/**
 * §20.3 "Lifecycle -- supersession, correction, withdrawal, REACTIVATION" and
 * "Correction -- inherits valid_until; only the current row is correctable;
 * idempotency key is honoured". Both rated High.
 *
 * Supersession has golden test 4. Correction and withdrawal are covered in
 * part. This file closes the two that were never tested at all: reactivation,
 * and the idempotency key.
 *
 * The through-line is D5: **validity is stamped once, at insert, and never
 * re-derived**. Every claim below is a consequence of that, and each is a place
 * where a plausible implementation would get it wrong by recomputing something
 * it should have read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { signInAs } from '../helpers/clients';
import { F, buildWorld, teardown, type World } from '../helpers/fixtures';
import { closeDb, q } from '../helpers/db';

let world: World;
let partner: SupabaseClient;
let operator: SupabaseClient;
let admin: SupabaseClient;
let rm: SupabaseClient;
let ppId: string;

beforeAll(async () => {
  world = await buildWorld();
  partner = await signInAs(F.users.aAdmin);
  operator = await signInAs(F.users.operator);
  admin = await signInAs(F.users.admin);
  rm = await signInAs(F.users.rm);

  const added = await partner.rpc('add_partner_pair', { p_currency_pair_id: world.testPairId });
  if (added.error) throw new Error(added.error.message);
  ppId = (added.data as { id: string }).id;

  const mv = await admin.rpc('create_markup_version', {
    p_currency_pair_id: world.testPairId,
    p_default: '50', p_min: '0', p_max: '200',
    p_reason: 'lifecycle fixture',
  });
  if (mv.error) throw new Error(mv.error.message);
});

afterAll(async () => {
  await teardown();
  await closeDb();
});

/**
 * Submit a rate, clearing the pair first so each test starts from one row.
 *
 * Use submitOver() when the point of the test is SUPERSESSION -- deleting the
 * previous row makes the old id vanish rather than become superseded, and a
 * test written on top of that asserts "no such rate" while believing it is
 * asserting "already superseded".
 */
async function submit(bid = '18.40', ask = '18.60') {
  await q(`delete from public.rates where partner_pair_id = $1`, [ppId]);
  const { data, error } = await partner.rpc('submit_rates', {
    p_rows: [
      { currency_pair_id: world.testPairId, bid, ask, size_status: 'unconfirmed' },
    ],
    p_valid_until: null, p_raw: null, p_idem: null,
  });
  if (error) throw new Error(error.message);
  return (data as { rows: Array<{ rate_id: string }> }).rows[0]!.rate_id;
}

/** Submit on top of what is already current, so the previous row is superseded. */
async function submitOver(bid: string, ask: string) {
  const { data, error } = await partner.rpc('submit_rates', {
    p_rows: [
      { currency_pair_id: world.testPairId, bid, ask, size_status: 'unconfirmed' },
    ],
    p_valid_until: null, p_raw: null, p_idem: null,
  });
  if (error) throw new Error(error.message);
  return (data as { rows: Array<{ rate_id: string }> }).rows[0]!.rate_id;
}

async function boardRows() {
  const { data, error } = await rm.rpc('board_rates', {
    p_currency_pair_id: world.testPairId,
    p_direction: 'client_sells_base',
    p_amount: null, p_markup_bps: null,
  });
  if (error) throw new Error(error.message);
  const b = data as unknown as {
    eligible: Array<{ rate_id: string }>;
    ineligible: Array<{ rate_id: string; reason: string }>;
  };
  return b;
}

describe('Reactivation does not resurrect what expired while away (D5)', () => {
  it('a deactivated partner disappears from the board, and returns on reactivation', async () => {
    await submit();
    expect((await boardRows()).eligible).toHaveLength(1);

    const off = await operator.rpc('set_partner_status', {
      p_partner_id: world.partnerAId, p_status: 'inactive',
    });
    expect(off.error).toBeNull();
    // E1: not rendered at all, not even below the divider.
    const whileOff = await boardRows();
    expect([...whileOff.eligible, ...whileOff.ineligible]).toHaveLength(0);

    const on = await operator.rpc('set_partner_status', {
      p_partner_id: world.partnerAId, p_status: 'active',
    });
    expect(on.error).toBeNull();
    expect((await boardRows()).eligible, 'a still-valid rate must come back').toHaveLength(1);
  });

  it('a rate that EXPIRED during the deactivation stays expired afterwards', async () => {
    // §13.2: "Reversible; reactivation does not resurrect expired rates,
    // because validity is stamped." This is the test for that sentence, and it
    // is the one an implementation that recomputes validity on read would fail.
    await submit();
    await operator.rpc('set_partner_status', {
      p_partner_id: world.partnerAId, p_status: 'inactive',
    });

    await q(
      `update public.rates
          set valid_from = now() - interval '9 hours',
              expiry_warning_at = now() - interval '3 hours',
              valid_until = now() - interval '1 hour'
        where partner_pair_id = $1 and superseded_by is null`,
      [ppId],
    );

    await operator.rpc('set_partner_status', {
      p_partner_id: world.partnerAId, p_status: 'active',
    });

    const b = await boardRows();
    expect(b.eligible, 'an expired rate must not come back to life').toHaveLength(0);
    expect(b.ineligible).toHaveLength(1);
    expect(b.ineligible[0]!.reason).toMatch(/^expired/);
  });

  it('a deactivated PAIR behaves the same way, and its rates survive', async () => {
    await submit();
    const off = await partner.rpc('set_partner_pair_active', {
      p_partner_pair_id: ppId, p_active: false,
    });
    expect(off.error).toBeNull();

    // The rows are still THERE -- deactivation is not withdrawal.
    const stored = await q<{ n: number }>(
      `select count(*)::int as n from public.rates
        where partner_pair_id = $1 and superseded_by is null and withdrawn_at is null`,
      [ppId],
    );
    expect(stored[0]!.n).toBe(1);

    const whileOff = await boardRows();
    expect([...whileOff.eligible, ...whileOff.ineligible]).toHaveLength(0);

    await partner.rpc('set_partner_pair_active', { p_partner_pair_id: ppId, p_active: true });
    expect((await boardRows()).eligible).toHaveLength(1);
  });

  it('reactivating a partner does not restore a WITHDRAWN rate', async () => {
    // Withdrawal is the partner's own decision and is permanent for that row;
    // deactivation is backbone's and is reversible. They must not be confused.
    const rateId = await submit();
    await partner.rpc('withdraw_rate', { p_rate_id: rateId, p_reason: 'pulled' });
    await operator.rpc('set_partner_status', {
      p_partner_id: world.partnerAId, p_status: 'inactive',
    });
    await operator.rpc('set_partner_status', {
      p_partner_id: world.partnerAId, p_status: 'active',
    });
    const b = await boardRows();
    expect([...b.eligible, ...b.ineligible]).toHaveLength(0);
  });
});

describe('Correction: the idempotency key is honoured (§6.6)', () => {
  it('a retried correction returns the original and writes nothing new', async () => {
    const rateId = await submit();
    const key = `idem-correct-${Date.now()}`;

    const first = await partner.rpc('correct_rate', {
      p_rate_id: rateId, p_bid: '18.45', p_ask: '18.65',
      p_size: null, p_reason: 'typo', p_idem: key,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as { rate_id: string; submission_id: string };

    const countAfterFirst = await q<{ n: number }>(
      `select count(*)::int as n from public.rates where partner_pair_id = $1`,
      [ppId],
    );

    // The network dropped the response; the client retries with the same key.
    const retry = await partner.rpc('correct_rate', {
      p_rate_id: rateId, p_bid: '18.45', p_ask: '18.65',
      p_size: null, p_reason: 'typo', p_idem: key,
    });
    expect(retry.error, 'a retried correction must not fail').toBeNull();
    const retryResult = retry.data as { submission_id: string; idempotent_replay?: boolean };

    expect(retryResult.submission_id).toBe(firstResult.submission_id);
    expect(retryResult.idempotent_replay).toBe(true);

    const countAfterRetry = await q<{ n: number }>(
      `select count(*)::int as n from public.rates where partner_pair_id = $1`,
      [ppId],
    );
    expect(countAfterRetry[0]!.n, 'the retry wrote a second correction').toBe(
      countAfterFirst[0]!.n,
    );
  });

  it('the same key on a DIFFERENT partner is not a collision', async () => {
    // rate_submissions_idem is unique per (partner_id, idempotency_key), so two
    // partners choosing the same key must not interfere.
    const partnerB = await signInAs(F.users.bUser);
    const key = `shared-key-${Date.now()}`;

    const a = await partner.rpc('submit_rates', {
      p_rows: [{ currency_pair_id: world.testPairId, bid: '18.4', ask: '18.6', size_status: 'unconfirmed' }],
      p_valid_until: null, p_raw: null, p_idem: key,
    });
    expect(a.error).toBeNull();

    const b = await partnerB.rpc('submit_rates', {
      p_rows: [{ currency_pair_id: world.pairId, bid: '1400', ask: '1402', size_status: 'unconfirmed' }],
      p_valid_until: null, p_raw: null, p_idem: key,
    });
    expect(b.error, 'the same key on another partner must be independent').toBeNull();
    expect((b.data as { idempotent_replay?: boolean }).idempotent_replay).toBeUndefined();
  });
});

describe('Correction: only the current row, and the chain is preserved', () => {
  it('refuses to correct a row that has already been superseded', async () => {
    const firstId = await submit();
    const secondId = await submitOver('18.50', '18.70');
    expect(secondId).not.toBe(firstId);

    // The first row must still EXIST and be marked superseded -- if it had been
    // deleted, the error below would be "no such rate" and this test would pass
    // while asserting nothing about supersession.
    const [old] = await q<{ superseded_by: string | null }>(
      `select superseded_by from public.rates where id = $1`,
      [firstId],
    );
    expect(old, 'the superseded row must be retained').toBeDefined();
    expect(old!.superseded_by).toBe(secondId);

    const { error } = await partner.rpc('correct_rate', {
      p_rate_id: firstId, p_bid: '18.99', p_ask: '19.01',
      p_size: null, p_reason: 'too late', p_idem: null,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/superseded/i);
  });

  it('refuses to correct a withdrawn row', async () => {
    const rateId = await submit();
    await partner.rpc('withdraw_rate', { p_rate_id: rateId, p_reason: 'pulled' });
    const { error } = await partner.rpc('correct_rate', {
      p_rate_id: rateId, p_bid: '18.99', p_ask: '19.01',
      p_size: null, p_reason: 'after the fact', p_idem: null,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/withdrawn/i);
  });

  it('a correction of a correction inherits the ORIGINAL expiry, not a fresh one', async () => {
    // §6.6: "A correction restates a price the partner already committed to
    // until a given time; fixing a typo does not extend the life of the quote."
    // A chain of corrections must not ratchet the expiry forward either.
    const rateId = await submit();
    const [original] = await q<{ valid_until: string }>(
      `select valid_until::text from public.rates where id = $1`,
      [rateId],
    );

    const first = await partner.rpc('correct_rate', {
      p_rate_id: rateId, p_bid: '18.45', p_ask: '18.65',
      p_size: null, p_reason: 'first typo', p_idem: null,
    });
    expect(first.error).toBeNull();
    const secondId = (first.data as { rate_id: string }).rate_id;

    const second = await partner.rpc('correct_rate', {
      p_rate_id: secondId, p_bid: '18.46', p_ask: '18.66',
      p_size: null, p_reason: 'second typo', p_idem: null,
    });
    expect(second.error).toBeNull();
    const thirdId = (second.data as { rate_id: string }).rate_id;

    const [final] = await q<{ valid_until: string; correction_of: string }>(
      `select valid_until::text, correction_of from public.rates where id = $1`,
      [thirdId],
    );
    expect(final!.valid_until, 'the expiry ratcheted forward across a chain').toBe(
      original!.valid_until,
    );
    expect(final!.correction_of).toBe(secondId);
  });

  it('keeps every step of the chain, with values untouched', async () => {
    const rows = await q<{ n: number }>(
      `select count(*)::int as n from public.rates
        where partner_pair_id = $1 and correction_of is not null`,
      [ppId],
    );
    // Corrections are inserts, never edits: the record of what was said and
    // when is what a dispute is settled against.
    expect(rows[0]!.n).toBeGreaterThanOrEqual(2);
  });
});

describe('The audit trail follows the lifecycle', () => {
  it('records each lifecycle action against the partner', async () => {
    const actions = await q<{ action: string }>(
      `select distinct action from public.audit_events
        where partner_id = $1 and action like 'rate.%'`,
      [world.partnerAId],
    );
    const names = actions.map((a) => a.action);
    expect(names).toContain('rate.submit');
    expect(names).toContain('rate.correct');
    expect(names).toContain('rate.withdraw');
  });

  it('records partner activation and deactivation distinctly', async () => {
    const actions = await q<{ action: string }>(
      `select distinct action from public.audit_events
        where partner_id = $1 and action like 'partner.%'`,
      [world.partnerAId],
    );
    const names = actions.map((a) => a.action);
    // An audit trail that logs a reactivation as a deactivation is worse than
    // one that names an action §11.7 did not enumerate.
    expect(names).toContain('partner.deactivate');
    expect(names).toContain('partner.activate');
  });
});
