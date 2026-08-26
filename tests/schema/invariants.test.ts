/**
 * Schema assertions -- spec §20.2 T24 to T26, plus the invariants they protect.
 *
 * "T24 to T26 are schema assertions rather than behavioural tests. They catch
 *  the class of defect that produced two rewrites."
 *
 * These read pg_catalog directly. They are the cheapest possible check on the
 * property the whole access-control design rests on, and they must stay green
 * for every future migration -- that is the entire point of them.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, q } from '../helpers/db';

const BUSINESS_TABLES = [
  'currencies',
  'currency_pairs',
  'partners',
  'principals',
  'staff_profiles',
  'partner_memberships',
  'partner_pairs',
  'rate_submissions',
  'rates',
  'markup_versions',
  'audit_events',
];

afterAll(closeDb);

describe('T24 -- every SECURITY DEFINER function pins search_path', () => {
  it('has no security definer function without search_path set', async () => {
    const rows = await q<{ fn: string }>(`
      select n.nspname || '.' || p.proname as fn
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','app')
        and p.prosecdef
        and not exists (
          select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'
        )
      order by 1
    `);
    expect(rows.map((r) => r.fn)).toEqual([]);
  });

  it('sets search_path to the empty string, not a pinned path (§12.4, TM6)', async () => {
    // An empty search path is stricter than a pinned one: an unqualified name
    // becomes an error at CREATE time rather than a resolution decided at call
    // time by the caller's path.
    //
    // Postgres stores `set search_path = ''` as the literal `search_path=""`.
    // Matching `search_path=` exactly reports a false failure; matching
    // `search_path=%` would wrongly accept `search_path=public`, which is the
    // pinned form §12.4 rejects.
    const rows = await q<{ fn: string; cfg: string }>(`
      select n.nspname || '.' || p.proname as fn,
             array_to_string(p.proconfig, ',') as cfg
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','app')
        and p.prosecdef
        and not ('search_path=""' = any(coalesce(p.proconfig, '{}')))
      order by 1
    `);
    expect(rows).toEqual([]);
  });
});

describe('T25 -- no write privilege on any table for anon or authenticated', () => {
  it('grants no INSERT, UPDATE, DELETE, TRUNCATE or REFERENCES (D2)', async () => {
    const rows = await q<{ offender: string }>(`
      select g.table_name || ':' || g.privilege_type || ' -> ' || g.grantee as offender
      from information_schema.role_table_grants g
      where g.table_schema = 'public'
        and g.grantee in ('anon','authenticated')
        and g.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES')
      order by 1
    `);
    expect(rows.map((r) => r.offender)).toEqual([]);
  });

  it('grants anon nothing at all on any business table', async () => {
    const rows = await q<{ offender: string }>(`
      select g.table_name || ':' || g.privilege_type as offender
      from information_schema.role_table_grants g
      where g.table_schema = 'public' and g.grantee = 'anon'
      order by 1
    `);
    expect(rows.map((r) => r.offender)).toEqual([]);
  });
});

describe('T26 -- no function is executable by PUBLIC', () => {
  // PUBLIC is grantee OID 0 in aclexplode(). Matching the ACL text for '=X'
  // is wrong: it also matches 'postgres=X/postgres'.
  const publicExecutable = `
    select n.nspname || '.' || p.proname as fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname in ('public','app')
      and a.privilege_type = 'EXECUTE'
      and a.grantee = $1
    order by 1
  `;

  it('exposes no existing function to PUBLIC', async () => {
    const rows = await q<{ fn: string }>(publicExecutable, [0]);
    expect(rows.map((r) => r.fn)).toEqual([]);
  });

  it('exposes no existing function to anon', async () => {
    const roles = await q<{ oid: number }>(`select oid from pg_roles where rolname = 'anon'`);
    expect(roles, 'the anon role should exist on a Supabase project').toHaveLength(1);
    const rows = await q<{ fn: string }>(publicExecutable, [roles[0]!.oid]);
    expect(rows.map((r) => r.fn)).toEqual([]);
  });

  // The spec is explicit that this must be proven with a function created
  // AFTER migration, "to prove default privileges hold". On Supabase they do
  // not: ALTER DEFAULT PRIVILEGES is re-overlaid with the built-in PUBLIC
  // EXECUTE default. Migration 0006 installs an event trigger instead. This
  // test is what proves the guard is live -- if someone drops the event
  // trigger, this goes red and nothing else does.
  it('a function created after migration is not executable by PUBLIC', async () => {
    for (const schema of ['public', 'app']) {
      await q(`drop function if exists ${schema}._t26_probe()`);
      await q(
        `create function ${schema}._t26_probe() returns int language sql immutable as $$ select 1 $$`,
      );
      try {
        const rows = await q<{ fn: string }>(
          `select n.nspname || '.' || p.proname as fn
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where p.proname = '_t26_probe'
              and n.nspname = $1
              and a.privilege_type = 'EXECUTE'
              and a.grantee = 0`,
          [schema],
        );
        expect(rows, `${schema}._t26_probe is executable by PUBLIC`).toEqual([]);
      } finally {
        await q(`drop function if exists ${schema}._t26_probe()`);
      }
    }
  });

  it('keeps the event-trigger guard installed (§12.2)', async () => {
    const rows = await q<{ evtname: string; enabled: string }>(
      `select evtname, evtenabled::text as enabled from pg_event_trigger where evtname = 'no_public_execute'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).not.toBe('D'); // not disabled
  });
});

describe('RLS is enabled on every business table (§12.6)', () => {
  it('enables row level security everywhere', async () => {
    const rows = await q<{ tablename: string }>(
      `select c.relname as tablename
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and c.relname = any($1) and not c.relrowsecurity
        order by 1`,
      [BUSINESS_TABLES],
    );
    expect(rows.map((r) => r.tablename)).toEqual([]);
  });

  it('covers every business table, none forgotten', async () => {
    const rows = await q<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname not like '\\_%'
        order by 1`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...BUSINESS_TABLES].sort());
  });
});

describe('No policy permits a write (D2, §12.6)', () => {
  it('has no INSERT, UPDATE, DELETE or ALL policy on any table', async () => {
    const rows = await q<{ offender: string }>(`
      select tablename || ':' || policyname || ' (' || cmd || ')' as offender
      from pg_policies
      where schemaname = 'public' and cmd <> 'SELECT'
      order by 1
    `);
    expect(rows.map((r) => r.offender)).toEqual([]);
  });
});

describe('v_current_rates does not bypass RLS (TM7)', () => {
  it('is declared security_invoker = true (§11.8)', async () => {
    const [row] = await q<{ opts: string | null }>(
      `select array_to_string(c.reloptions, ',') as opts
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'v_current_rates'`,
    );
    expect(row?.opts ?? '').toContain('security_invoker=true');
  });
});

describe('Decimal columns are NUMERIC, never floating point (D13, §12.7)', () => {
  it('uses no real, double precision or float anywhere in the schema', async () => {
    const rows = await q<{ offender: string }>(`
      select table_name || '.' || column_name || ' ' || data_type as offender
      from information_schema.columns
      where table_schema = 'public'
        and data_type in ('real','double precision')
      order by 1
    `);
    expect(rows.map((r) => r.offender)).toEqual([]);
  });
});

describe('The immutability spine (§21.2)', () => {
  it('has no delete path: rates and audit_events grant no DELETE to anyone but the owner', async () => {
    const rows = await q<{ offender: string }>(`
      select g.table_name || ':' || g.privilege_type || ' -> ' || g.grantee as offender
      from information_schema.role_table_grants g
      where g.table_schema = 'public'
        and g.table_name in ('rates','audit_events')
        and g.privilege_type = 'DELETE'
        and g.grantee not in ('postgres','supabase_admin','service_role')
      order by 1
    `);
    expect(rows.map((r) => r.offender)).toEqual([]);
  });
});
