/**
 * The access-control matrix -- spec §20.2 T1 to T23, and golden test 2.
 *
 * "Automated, through the real client with real sessions. Never a manual
 *  check, never a service-role query."
 *
 * Every assertion here therefore goes through a client returned by signInAs().
 * The service role appears only in beforeAll, to build the world.
 *
 * Note on what "denied" looks like: PostgREST reports an RLS denial as an
 * empty result set, not an error. §20.1 golden test 2 is explicit that reads
 * "MUST all return empty rather than filtered" -- an empty set is the pass
 * condition for a read, and an error is the pass condition for a write.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { anonClient, signInAs } from '../helpers/clients';
import { F, buildWorld, teardown, type World } from '../helpers/fixtures';
import { closeDb } from '../helpers/db';

let world: World;
const s: Record<string, SupabaseClient> = {};

beforeAll(async () => {
  world = await buildWorld();
  s.aUser = await signInAs(F.users.aUser);
  s.aAdmin = await signInAs(F.users.aAdmin);
  s.bUser = await signInAs(F.users.bUser);
  s.rm = await signInAs(F.users.rm);
  s.operator = await signInAs(F.users.operator);
  s.admin = await signInAs(F.users.admin);
  s.revoked = await signInAs(F.users.revoked);
});

afterAll(async () => {
  await teardown();
  await closeDb();
});

describe('Partner isolation (T1 to T6)', () => {
  it('T1 -- Partner A sees zero rows of Partner B rates', async () => {
    const { data } = await s.aUser!.from('rates').select('id, partner_id');
    expect(data ?? []).not.toHaveLength(0); // sees its own
    expect((data ?? []).every((r) => r.partner_id === world.partnerAId)).toBe(true);
    expect((data ?? []).some((r) => r.id === world.rateBId)).toBe(false);
  });

  it('T2 -- Partner A sees no partner row but its own', async () => {
    const { data } = await s.aUser!.from('partners').select('id, slug');
    expect(data ?? []).toHaveLength(1);
    expect(data![0]!.id).toBe(world.partnerAId);
  });

  it('T3 -- Partner A sees zero rows of markup_versions', async () => {
    const { data } = await s.aUser!.from('markup_versions').select('*');
    expect(data ?? []).toHaveLength(0);
  });

  it('T4 -- Partner A sees zero rows of staff_profiles', async () => {
    const { data } = await s.aUser!.from('staff_profiles').select('*');
    expect(data ?? []).toHaveLength(0);
  });

  it('T5 -- Partner A sees no partner_memberships of another partner', async () => {
    const { data } = await s.aUser!.from('partner_memberships').select('partner_id');
    expect((data ?? []).every((r) => r.partner_id === world.partnerAId)).toBe(true);
  });

  it('T6 -- Partner A sees zero rows of Partner B rate_submissions', async () => {
    const { data } = await s.aUser!.from('rate_submissions').select('partner_id');
    expect((data ?? []).every((r) => r.partner_id === world.partnerAId)).toBe(true);
  });
});

describe('rm_viewer is denied the envelope and the audit (T7, T8)', () => {
  it('T7 -- rm_viewer sees zero rows of rate_submissions', async () => {
    // Carries raw_input, client IP and user agent, none of which an RM needs
    // to price a ticket (§4.1).
    const { data } = await s.rm!.from('rate_submissions').select('*');
    expect(data ?? []).toHaveLength(0);
  });

  it('T8 -- rm_viewer sees zero rows of audit_events', async () => {
    const { data } = await s.rm!.from('audit_events').select('*');
    expect(data ?? []).toHaveLength(0);
  });

  it('rm_viewer can still read the board data it needs', async () => {
    const { data } = await s.rm!.from('rates').select('id');
    expect((data ?? []).length).toBeGreaterThanOrEqual(2); // both partners
  });
});

describe('No direct writes from any application role (T9, T13, T14, T15)', () => {
  it('T9 -- Partner A cannot insert into rates directly', async () => {
    const { error } = await s.aUser!.from('rates').insert({
      submission_id: world.rateAId,
      partner_id: world.partnerAId,
      partner_pair_id: world.partnerPairAId,
      partner_bid: '1',
      partner_ask: '2',
      size_status: 'unconfirmed',
      observed_at: new Date().toISOString(),
      submitted_at: new Date().toISOString(),
      valid_from: new Date().toISOString(),
      expiry_warning_at: new Date().toISOString(),
      valid_until: new Date().toISOString(),
    });
    expect(error).not.toBeNull();
  });

  it('T13 -- no role can update or delete a rate', async () => {
    for (const [name, client] of Object.entries(s)) {
      const upd = await client.from('rates').update({ partner_bid: '1' }).eq('id', world.rateAId);
      expect(upd.error, `${name} was permitted to UPDATE rates`).not.toBeNull();
      const del = await client.from('rates').delete().eq('id', world.rateAId);
      expect(del.error, `${name} was permitted to DELETE rates`).not.toBeNull();
    }
  });

  it('T14 -- no role can update or delete an audit event', async () => {
    for (const [name, client] of Object.entries(s)) {
      const upd = await client.from('audit_events').update({ action: 'x' }).gt('id', 0);
      expect(upd.error, `${name} was permitted to UPDATE audit_events`).not.toBeNull();
      const del = await client.from('audit_events').delete().gt('id', 0);
      expect(del.error, `${name} was permitted to DELETE audit_events`).not.toBeNull();
    }
  });

  it('T15 -- no role can self-elevate via staff_profiles.role', async () => {
    // The defect this replaces: a predecessor of staff_profiles held each
    // user's own role in a table with RLS never enabled, making
    // `update ... set role = 'backbone_admin' where id = auth.uid()`
    // a valid statement for a partner (§12.1).
    for (const [name, client] of Object.entries(s)) {
      const { error } = await client
        .from('staff_profiles')
        .update({ role: 'backbone_admin' })
        .eq('principal_id', world.principalIds[F.users.rm]!);
      expect(error, `${name} was permitted to UPDATE staff_profiles.role`).not.toBeNull();
    }
  });

  it('T15b -- no role can move itself to another partner', async () => {
    for (const [name, client] of Object.entries(s)) {
      const { error } = await client
        .from('partner_memberships')
        .update({ partner_id: world.partnerBId })
        .eq('principal_id', world.principalIds[F.users.aUser]!);
      expect(error, `${name} was permitted to UPDATE partner_memberships`).not.toBeNull();
    }
  });
});

describe('T11 -- the composite foreign key refuses a cross-tenant rate', () => {
  it('refuses a rate whose partner_pair_id belongs to another partner', async () => {
    // Asserted against the database directly, because the point of the test is
    // that even a privileged path cannot do it -- §11.5.
    const { q } = await import('../helpers/db');
    await expect(
      q(
        `insert into public.rates
           (submission_id, partner_id, partner_pair_id, partner_bid, partner_ask, size_status,
            observed_at, submitted_at, valid_from, expiry_warning_at, valid_until)
         select r.submission_id, $1, $2, 1392, 1394, 'unconfirmed',
                now(), now(), now(), now() + interval '2 hours', now() + interval '8 hours'
           from public.rates r where r.id = $3`,
        [world.partnerAId, world.partnerPairBId, world.rateAId],
      ),
    ).rejects.toThrow();
  });
});

describe('T12 -- a revoked principal has no access', () => {
  it('reads nothing from any table', async () => {
    for (const table of ['rates', 'partners', 'partner_pairs', 'rate_submissions']) {
      const { data } = await s.revoked!.from(table).select('*');
      expect(data ?? [], `revoked principal could read ${table}`).toHaveLength(0);
    }
  });

  it('resolves to no principal at all', async () => {
    // Every helper filters status = 'active', which is what makes revocation
    // effective on the next request regardless of token state (TM8, §19).
    const { data } = await s.revoked!.rpc('principal_id' as never);
    expect(data ?? null).toBeNull();
  });
});

describe('T21 -- an anonymous caller reads nothing', () => {
  it('reads nothing from any table or view', async () => {
    const anon = anonClient();
    for (const table of [
      'rates',
      'partners',
      'partner_pairs',
      'currencies',
      'currency_pairs',
      'principals',
      'staff_profiles',
      'partner_memberships',
      'rate_submissions',
      'markup_versions',
      'audit_events',
      'v_current_rates',
    ]) {
      const { data } = await anon.from(table).select('*');
      expect(data ?? [], `anon could read ${table}`).toHaveLength(0);
    }
  });
});

describe('T22 -- v_current_rates respects the caller row policies', () => {
  it('shows Partner A only its own rows through the view', async () => {
    const { data } = await s.aUser!.from('v_current_rates').select('id, partner_id');
    expect(data ?? []).not.toHaveLength(0);
    expect((data ?? []).every((r) => r.partner_id === world.partnerAId)).toBe(true);
  });

  it('shows staff every partner through the same view', async () => {
    const { data } = await s.rm!.from('v_current_rates').select('id, partner_id');
    const partners = new Set((data ?? []).map((r) => r.partner_id));
    expect(partners.size).toBeGreaterThanOrEqual(2);
  });

  it('marks an unconfirmed-convention partner unavailable ([A-1] gate, E2)', async () => {
    const { data } = await s.rm!
      .from('v_current_rates')
      .select('partner_id, status')
      .eq('partner_id', world.partnerBId);
    expect(data ?? []).not.toHaveLength(0);
    expect((data ?? []).every((r) => r.status === 'unavailable')).toBe(true);
  });
});

describe('Golden test 2 -- the isolation test (§20.1)', () => {
  it('returns empty rather than filtered across every partner-forbidden surface', async () => {
    for (const table of ['markup_versions', 'staff_profiles']) {
      const { data } = await s.aUser!.from(table).select('*');
      expect(data ?? [], `${table} leaked to a partner`).toHaveLength(0);
    }
    const others = await s.aUser!.from('rates').select('partner_id').eq('partner_id', world.partnerBId);
    expect(others.data ?? []).toHaveLength(0);
  });

  it('refuses every escalation write', async () => {
    const elevate = await s.aUser!
      .from('staff_profiles')
      .update({ role: 'backbone_admin' })
      .eq('principal_id', world.principalIds[F.users.aUser]!);
    expect(elevate.error).not.toBeNull();

    const move = await s.aUser!
      .from('partner_memberships')
      .update({ partner_id: world.partnerBId })
      .eq('principal_id', world.principalIds[F.users.aUser]!);
    expect(move.error).not.toBeNull();

    const insert = await s.aUser!.from('rates').insert({
      submission_id: world.rateAId,
      partner_id: world.partnerAId,
      partner_pair_id: world.partnerPairBId,
      partner_bid: '1392',
      partner_ask: '1394',
      size_status: 'unconfirmed',
      observed_at: new Date().toISOString(),
      submitted_at: new Date().toISOString(),
      valid_from: new Date().toISOString(),
      expiry_warning_at: new Date().toISOString(),
      valid_until: new Date().toISOString(),
    });
    expect(insert.error).not.toBeNull();
  });
});
