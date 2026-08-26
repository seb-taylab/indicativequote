/**
 * One-off: reconstruct migration files for changes that were applied directly
 * to the database without one. §18.1 treats that as an incident, because a
 * rebuild from files alone would not reproduce production.
 *
 * Definitions are pulled from the live catalogue, so the files provably match
 * what is deployed rather than what someone remembers writing.
 */
import { config } from 'dotenv';
import { writeFileSync } from 'node:fs';
import pg from 'pg';

config({ path: '.env.local' });

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const fn = async (schema, name) =>
  (
    await c.query(
      `select pg_get_functiondef(p.oid) d
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1 and p.proname = $2`,
      [schema, name],
    )
  ).rows[0].d;

const view = async (name) =>
  (await c.query(`select pg_get_viewdef($1::regclass, true) d`, [`public.${name}`])).rows[0].d;

const HEADER_22 = `-- =====================================================================
-- 0022  Readable eligibility reasons
-- Spec §14, §7
--
-- RECONSTRUCTED FROM THE LIVE DATABASE. This change was applied directly and
-- went without a migration file for a period. §18.1 calls that an incident,
-- and it is one: a rebuild from files alone would produce a board whose
-- withheld reasons read "outside size range, 0.000000 to 100000.000000",
-- making the reader decode numeric(24,6)'s storage scale to learn that the
-- band is 0 to 100,000. The reason line is prose for a person, so it is
-- formatted like prose.
--
-- app.fmt_num trims the TEXT, never by casting through a float, and only where
-- a decimal point exists -- so '100' can never become '1'.
-- =====================================================================

`;

const HEADER_23 = `-- =====================================================================
-- 0023  Views emit decimals as text
-- Spec §12.7, D13, §11.8. See docs/spec-findings.md F15.
--
-- RECONSTRUCTED FROM THE LIVE DATABASE, for the same reason as 0022 -- and
-- this one matters more. Without this file a rebuild would restore §11.8's
-- view returning numeric, and PostgREST would serialise every rate as a JSON
-- number for JavaScript to parse as a binary double. That is F15 verbatim: a
-- partner's own rates losing precision on the way to the browser, with no
-- float anywhere in the schema.
--
-- Column names and the exposed set are unchanged from §11.8; only the wire
-- type changes. v_rate_history additionally carries the superseded, corrected
-- and withdrawn rows that v_current_rates excludes by definition, for §5's
-- read-only submission history.
-- =====================================================================

`;

writeFileSync(
  'supabase/migrations/0022_readable_eligibility_reasons.sql',
  HEADER_22 +
    (await fn('app', 'fmt_num')) +
    ';\n\nrevoke execute on function app.fmt_num(numeric) from public, anon, authenticated;\n\n' +
    (await fn('public', 'board_rates')) +
    ';\n',
);

writeFileSync(
  'supabase/migrations/0023_views_emit_decimals_as_text.sql',
  HEADER_23 +
    'drop view if exists public.v_current_rates;\n\ncreate view public.v_current_rates\nwith (security_invoker = true) as\n' +
    (await view('v_current_rates')) +
    '\n\ncreate or replace view public.v_rate_history\nwith (security_invoker = true) as\n' +
    (await view('v_rate_history')) +
    '\n\ngrant select on public.v_current_rates, public.v_rate_history to authenticated;\n',
);

await c.query(`
  insert into app.schema_migrations (name) values
    ('0021_sign_in.sql'),
    ('0022_readable_eligibility_reasons.sql'),
    ('0023_views_emit_decimals_as_text.sql')
  on conflict (name) do nothing
`);

const n = (await c.query('select count(*)::int n from app.schema_migrations')).rows[0].n;
console.log(`files written; ledger now records ${n} migrations`);
await c.end();
