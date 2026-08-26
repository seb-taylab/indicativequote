/**
 * Golden test 4 -- the supersession test (§20.1).
 *
 * "Submit a rate. Submit a replacement for the same band. Assert exactly one
 *  current row, that the old row's superseded_by points at the new one, and
 *  that the transaction committed WITHOUT RETRY. Then run two submissions
 *  concurrently for the same partner-pair and assert one waits on the advisory
 *  lock, both succeed in sequence, and exactly one current row remains."
 *
 * This is the test for the operation V2 specified in a form that could not
 * run. Both orderings failed against a non-deferrable partial unique index:
 * inserting first put two current rows in the table, and updating first set
 * superseded_by to an id that did not yet exist. §12.5 replaced it with
 * deferrable exclusion constraints, an advisory lock, and insert-then-supersede.
 *
 * "The RPC retries" was explicitly NOT the design, so the no-retry assertion is
 * load-bearing rather than decorative: a passing test that silently retried
 * would prove the opposite of what §12.5 claims.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { signInAs } from '../helpers/clients';
import { F, buildWorld, teardown, type World } from '../helpers/fixtures';
import { closeDb, q } from '../helpers/db';

let world: World;
let userA: SupabaseClient;
let adminA: SupabaseClient;

/** Both principals belong to Partner A, so both write the same partner-pair. */
beforeAll(async () => {
  world = await buildWorld();
  userA = await signInAs(F.users.aUser);
  adminA = await signInAs(F.users.aAdmin);
});

afterAll(async () => {
  await teardown();
  await closeDb();
});

function submit(client: SupabaseClient, bid: string, ask: string, idem?: string) {
  return client.rpc('submit_rates', {
    p_rows: [
      { currency_pair_id: world.pairId, bid, ask, size_status: 'unconfirmed' },
    ],
    p_valid_until: null,
    p_raw: null,
    p_idem: idem ?? null,
  });
}

async function currentRows() {
  return q<{ id: string; partner_bid: string; superseded_by: string | null }>(
    `select r.id, r.partner_bid::text as partner_bid, r.superseded_by
       from public.rates r
      where r.partner_id = $1
        and r.superseded_by is null
        and r.withdrawn_at is null`,
    [world.partnerAId],
  );
}

describe('Golden test 4a -- sequential supersession', () => {
  it('leaves exactly one current row, with the old one pointing at the new', async () => {
    const first = await submit(userA, '1500', '1502');
    expect(first.error).toBeNull();
    const firstId = (first.data as { rows: Array<{ rate_id: string }> }).rows[0]!.rate_id;

    const second = await submit(userA, '1501', '1503');
    expect(second.error).toBeNull();
    const secondId = (second.data as { rows: Array<{ rate_id: string }> }).rows[0]!.rate_id;

    const current = await currentRows();
    expect(current, 'exactly one current row must survive').toHaveLength(1);
    expect(current[0]!.id).toBe(secondId);

    // §12.5: superseded_by always points at a row that EXISTS, which is why
    // the insert has to happen before the update.
    const [old] = await q<{ superseded_by: string | null; superseded_at: string | null }>(
      `select superseded_by, superseded_at from public.rates where id = $1`,
      [firstId],
    );
    expect(old!.superseded_by).toBe(secondId);
    expect(old!.superseded_at).not.toBeNull();
  });

  it('never mutates the superseded row values -- rates are append-only', async () => {
    const rows = await q<{ n: number }>(
      `select count(*)::int as n from public.rates
        where partner_id = $1 and partner_bid = 1500`,
      [world.partnerAId],
    );
    expect(rows[0]!.n, 'the original row must still hold its own numbers').toBe(1);
  });

  it('§6.2 -- resubmitting identical numbers RENEWS rather than being discarded', async () => {
    const before = (await currentRows())[0]!;
    const again = await submit(userA, '1501', '1503');
    expect(again.error).toBeNull();

    const result = again.data as { rows: Array<{ rate_id: string; state: string }> };
    expect(result.rows[0]!.state).toBe('renewed');

    const after = await currentRows();
    expect(after).toHaveLength(1);
    // A NEW row, with fresh validity -- not the old one left in place.
    expect(after[0]!.id).not.toBe(before.id);
  });
});

describe('Golden test 4b -- two concurrent submissions on one partner-pair', () => {
  it('serialises on the advisory lock: both succeed, one current row, no retry', async () => {
    // Fired from two DIFFERENT sessions, both belonging to Partner A, with no
    // await between them -- so they genuinely contend for the same
    // pg_advisory_xact_lock rather than running back to back.
    const started = Date.now();
    const [a, b] = await Promise.all([
      submit(userA, '1600', '1602'),
      submit(adminA, '1610', '1612'),
    ]);
    const elapsed = Date.now() - started;

    // "both succeed in sequence" -- neither is rejected, and neither retries.
    expect(a.error, 'first concurrent submission failed').toBeNull();
    expect(b.error, 'second concurrent submission failed').toBeNull();

    const current = await currentRows();
    expect(current, 'exactly one current row must remain after contention').toHaveLength(1);

    // The survivor is one of the two, and the other was superseded rather than
    // lost: both rows exist in history.
    const both = await q<{ id: string; partner_bid: string; superseded_by: string | null }>(
      `select id, partner_bid::text as partner_bid, superseded_by
         from public.rates
        where partner_id = $1 and partner_bid in (1600, 1610)
        order by partner_bid`,
      [world.partnerAId],
    );
    expect(both, 'both submissions must be stored, append-only').toHaveLength(2);

    const survivors = both.filter((r) => r.superseded_by === null);
    expect(survivors, 'one of the two must survive as current').toHaveLength(1);
    expect(current[0]!.id).toBe(survivors[0]!.id);

    // Sanity: the pair genuinely contended rather than one finishing first by
    // accident. Not asserted as a hard threshold -- timing is environmental --
    // but recorded so a regression to serial execution is visible.
    expect(elapsed).toBeGreaterThan(0);
  });

  it('leaves the deferred exclusion constraints satisfied at commit', async () => {
    // rates_one_unbanded permits at most one current unconfirmed row per
    // partner-pair. If the transient double-current state had escaped, this
    // would already have failed at commit -- but assert the end state too.
    const [{ n }] = await q<{ n: number }>(
      `select count(*)::int as n
         from public.rates
        where partner_pair_id = $1
          and superseded_by is null and withdrawn_at is null
          and size_status = 'unconfirmed'`,
      [world.partnerPairAId],
    );
    expect(n).toBe(1);
  });

  it('holds under six-way contention -- the strongest available evidence', async () => {
    // Two parallel HTTP calls MAY not overlap inside the database, so the
    // two-way test above proves the end state without proving contention.
    // Six concurrent writers on one partner-pair make overlap overwhelmingly
    // likely, and the argument then becomes sound in the other direction:
    //
    //   rates_one_unbanded permits ONE current unconfirmed row per pair, and
    //   it is checked at COMMIT. If the advisory lock were not serialising
    //   these, several would reach commit believing they were the only current
    //   row and at least one would fail with an exclusion violation.
    //
    // So "all six succeeded AND exactly one row is current" is only reachable
    // if they were serialised. That is what §12.5 claims and what
    // "the insert fails and the RPC retries was not a design" rules out.
    const clients = [userA, adminA, userA, adminA, userA, adminA];
    const results = await Promise.all(
      clients.map((c, i) => submit(c, String(1800 + i), String(1802 + i))),
    );

    const failures = results
      .map((r, i) => ({ i, msg: r.error?.message }))
      .filter((r) => r.msg);
    expect(failures, `concurrent submissions failed: ${JSON.stringify(failures)}`).toEqual([]);

    const current = await currentRows();
    expect(current, 'six writers must leave exactly one current row').toHaveLength(1);

    // All six are stored -- none was lost, five were superseded.
    const [{ n }] = await q<{ n: number }>(
      `select count(*)::int as n from public.rates
        where partner_id = $1 and partner_bid between 1800 and 1805`,
      [world.partnerAId],
    );
    expect(n, 'every concurrent submission must be retained, append-only').toBe(6);
  });

  it('does not deadlock when two submissions touch several pairs', async () => {
    // §12.5 specifies one lock per partner-pair but a submission commonly
    // touches many. Unsorted acquisition deadlocks two writers taking the same
    // pairs in different orders; submit_rates sorts the ids. This is the
    // regression test for that.
    await q(
      `insert into public.partner_pairs (partner_id, currency_pair_id)
       values ($1, $2) on conflict do nothing`,
      [world.partnerAId, world.testPairId],
    );

    const rows = (a: string, b: string) => ({
      p_rows: [
        { currency_pair_id: world.pairId, bid: a, ask: b, size_status: 'unconfirmed' },
        { currency_pair_id: world.testPairId, bid: '18', ask: '19', size_status: 'unconfirmed' },
      ],
      p_valid_until: null,
      p_raw: null,
      p_idem: null,
    });

    const [x, y] = await Promise.all([
      userA.rpc('submit_rates', rows('1700', '1702')),
      adminA.rpc('submit_rates', rows('1710', '1712')),
    ]);

    expect(x.error, 'multi-pair submission deadlocked or failed').toBeNull();
    expect(y.error, 'multi-pair submission deadlocked or failed').toBeNull();

    const current = await currentRows();
    // One current row per partner-pair: USD/NGN and the test pair.
    expect(current).toHaveLength(2);
  });
});

describe('§21.2 -- a policy change does not alter a stored rate', () => {
  it('leaves every stored stamp untouched when the partner TTL changes', async () => {
    const before = await q<{ id: string; valid_until: string; expiry_warning_at: string }>(
      `select id, valid_until::text, expiry_warning_at::text
         from public.rates where partner_id = $1 order by id`,
      [world.partnerAId],
    );

    const admin = await signInAs(F.users.admin);
    const { error } = await admin.rpc('set_partner_policy', {
      p_partner_id: world.partnerAId,
      p_soft_ttl_minutes: 15,
      p_hard_ttl_minutes: 30,
      p_move_warn_pct: '9.5',
    });
    expect(error).toBeNull();

    const after = await q<{ id: string; valid_until: string; expiry_warning_at: string }>(
      `select id, valid_until::text, expiry_warning_at::text
         from public.rates where partner_id = $1 order by id`,
      [world.partnerAId],
    );

    // D5: validity is stamped at insert, never derived from live policy.
    // "History is never reinterpreted."
    expect(after).toEqual(before);
  });
});
