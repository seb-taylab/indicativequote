/**
 * §9 "recent failures" and §18.2's alert threshold -- the resolution of F10.
 *
 * §6.4 makes a submission atomic, so a batch that fails validation raises and
 * is discarded whole, envelope included. `rate_submissions.error_count` can
 * therefore only ever be 0, and the signal an operator most needs -- a partner
 * repeatedly bouncing off validation -- was the one the table could not hold.
 *
 * These tests assert both halves of the resolution:
 *
 *   1. §6.4 still holds. A failed submission writes NO rate and NO envelope.
 *   2. The attempt is nonetheless recorded, by a separate transaction, so
 *      backbone can see it.
 *
 * §2 is why this matters more than it looks: "a partner hitting errors
 * silently stops using the product" is named as the risk that decides the
 * outcome.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { signInAs } from '../helpers/clients';
import { F, buildWorld, teardown, type World } from '../helpers/fixtures';
import { closeDb, q } from '../helpers/db';

let world: World;
let partnerA: SupabaseClient;
let partnerB: SupabaseClient;
let operator: SupabaseClient;
let rm: SupabaseClient;

beforeAll(async () => {
  world = await buildWorld();
  partnerA = await signInAs(F.users.aAdmin);
  partnerB = await signInAs(F.users.bUser);
  operator = await signInAs(F.users.operator);
  rm = await signInAs(F.users.rm);
  await q(`delete from public.submission_failures`);
});

afterAll(async () => {
  await q(`delete from public.submission_failures`);
  await teardown();
  await closeDb();
});

/** A submission guaranteed to fail validation: a crossed rate (§6.3 error 1). */
function crossedSubmission(client: SupabaseClient) {
  return client.rpc('submit_rates', {
    p_rows: [
      {
        currency_pair_id: world.pairId,
        bid: '1400',
        ask: '1390',
        size_status: 'unconfirmed',
      },
    ],
    p_valid_until: null,
    p_raw: null,
    p_idem: null,
  });
}

describe('§6.4 still holds: a failed submission leaves no rate and no envelope', () => {
  it('writes nothing at all when validation fails', async () => {
    const before = await q<{ rates: number; subs: number }>(
      `select (select count(*) from public.rates where partner_id = $1)::int as rates,
              (select count(*) from public.rate_submissions where partner_id = $1)::int as subs`,
      [world.partnerAId],
    );

    const { error } = await crossedSubmission(partnerA);
    expect(error, 'a crossed rate must be refused').not.toBeNull();

    const after = await q<{ rates: number; subs: number }>(
      `select (select count(*) from public.rates where partner_id = $1)::int as rates,
              (select count(*) from public.rate_submissions where partner_id = $1)::int as subs`,
      [world.partnerAId],
    );
    expect(after[0]!.rates, 'atomicity broken: a rate survived a failed batch').toBe(
      before[0]!.rates,
    );
    expect(after[0]!.subs, 'atomicity broken: an envelope survived a failed batch').toBe(
      before[0]!.subs,
    );
  });

  it('confirms error_count can never be non-zero -- which is why F10 exists', async () => {
    const rows = await q<{ n: number }>(
      `select count(*)::int as n from public.rate_submissions where error_count > 0`,
    );
    expect(rows[0]!.n, '§9 cannot read failures from this column').toBe(0);
  });
});

describe('The attempt is recorded separately, and survives the rollback', () => {
  it('records a failure against the calling partner', async () => {
    await q(`delete from public.submission_failures`);
    const { error: rpcError } = await crossedSubmission(partnerA);
    expect(rpcError).not.toBeNull();

    // This is the second, separate call the route makes.
    const { error } = await partnerA.rpc('record_submission_failure', {
      p_reason: rpcError!.message,
      p_sqlstate: rpcError!.code ?? null,
      p_row_count: 1,
    });
    expect(error).toBeNull();

    const rows = await q<{ partner_id: string; reason: string; row_count: number }>(
      `select partner_id, reason, row_count from public.submission_failures`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.partner_id).toBe(world.partnerAId);
    expect(rows[0]!.reason).toMatch(/higher than ask/i);
    expect(rows[0]!.row_count).toBe(1);
  });

  it('stores no pasted text and no rate values', async () => {
    // §18.2 forbids rate data in logs, and duplicating raw_input here would
    // place the same personal data outside §18.4's retention regime.
    const cols = await q<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'submission_failures'`,
    );
    const names = cols.map((c) => c.column_name);
    expect(names).not.toContain('raw_input');
    expect(names).not.toContain('partner_bid');
    expect(names).not.toContain('partner_ask');
  });

  it('attributes the failure to the caller, never to a partner they name', async () => {
    await q(`delete from public.submission_failures`);
    await partnerB.rpc('record_submission_failure', {
      p_reason: 'test from partner B',
      p_sqlstate: null,
      p_row_count: 1,
    });
    const rows = await q<{ partner_id: string }>(
      `select partner_id from public.submission_failures`,
    );
    expect(rows[0]!.partner_id).toBe(world.partnerBId);
  });
});

describe('Who can see failures (§12.6 shape, §4)', () => {
  beforeAll(async () => {
    await q(`delete from public.submission_failures`);
    await partnerA.rpc('record_submission_failure', {
      p_reason: 'partner A failure',
      p_sqlstate: null,
      p_row_count: 1,
    });
    await partnerB.rpc('record_submission_failure', {
      p_reason: 'partner B failure',
      p_sqlstate: null,
      p_row_count: 1,
    });
  });

  it('a partner sees only its own failures', async () => {
    const { data } = await partnerA.from('submission_failures').select('partner_id');
    expect(data ?? []).not.toHaveLength(0);
    expect((data ?? []).every((r) => r.partner_id === world.partnerAId)).toBe(true);
  });

  it('an operator sees every partner', async () => {
    const { data } = await operator.from('submission_failures').select('partner_id');
    const partners = new Set((data ?? []).map((r) => r.partner_id));
    expect(partners.size).toBeGreaterThanOrEqual(2);
  });

  it('rm_viewer sees none -- an RM prices tickets, not partner troubles', async () => {
    const { data } = await rm.from('submission_failures').select('*');
    expect(data ?? []).toHaveLength(0);
  });

  it('no role can write directly; the RPC is the only path (D2)', async () => {
    for (const [name, client] of Object.entries({ partnerA, operator, rm })) {
      const { error } = await client.from('submission_failures').insert({
        partner_id: world.partnerAId,
        reason: 'direct write',
      });
      expect(error, `${name} was permitted a direct INSERT`).not.toBeNull();
    }
  });
});

describe('§9 and §18.2 -- the health page can finally read this', () => {
  it('groups failures per partner with the last-hour count §18.2 alerts on', async () => {
    await q(`delete from public.submission_failures`);
    // Four failures for one partner within the hour: over §18.2's threshold.
    for (let i = 0; i < 4; i += 1) {
      await partnerA.rpc('record_submission_failure', {
        p_reason: `bid is higher than ask (attempt ${i + 1})`,
        p_sqlstate: '22023',
        p_row_count: 1,
      });
    }

    const { data, error } = await operator.rpc('partner_health');
    expect(error).toBeNull();

    const health = data as unknown as {
      recent_failures: Array<{
        partner_name: string;
        failures: number;
        in_last_hour: number;
        reasons: string[];
      }>;
    };

    expect(health.recent_failures, '§9 requires these to be visible').toHaveLength(1);
    const f = health.recent_failures[0]!;
    expect(f.failures).toBe(4);
    // §18.2: "more than 2 for one partner in an hour -> alert".
    expect(f.in_last_hour).toBeGreaterThan(2);
    // §9: "with the reasons".
    expect(f.reasons.length).toBeGreaterThan(0);
    expect(f.reasons.join(' ')).toMatch(/higher than ask/i);
  });

  it('reports nothing once the window has passed', async () => {
    await q(
      `update public.submission_failures set occurred_at = now() - interval '48 hours'`,
    );
    const { data } = await operator.rpc('partner_health');
    const health = data as unknown as { recent_failures: unknown[] };
    expect(health.recent_failures).toHaveLength(0);
  });
});
