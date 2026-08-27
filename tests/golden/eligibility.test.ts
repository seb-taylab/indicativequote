/**
 * §14 -- the nine eligibility gates, each excluding for the right reason, in
 * the right order. §20.3 rates this Critical/High, and it is the logic that
 * decides which rates an RM is allowed to price against.
 *
 * Two properties are asserted for every gate, because they are separate claims:
 *
 *   1. E1–E5 rows are NOT RENDERED AT ALL. A partner who is inactive, whose
 *      convention is unconfirmed, whose pair is withdrawn, or whose row is
 *      superseded must not appear even below the divider.
 *   2. E6–E9 rows ARE rendered, below the divider, WITH THEIR REASON --
 *      "an RM needs to know a rate exists but cannot be used, and why".
 *      §7: "Withheld rows are counted and named, never silently dropped."
 *
 * And the ordering, which is the part a re-implementation gets wrong: a row
 * failing several gates reports the EARLIEST, because that is the one that has
 * to be fixed first.
 *
 * Everything here runs on the fixture's dedicated pair. F21 is why: a test that
 * borrows the shared pair silently retires the seed's markup version, and
 * nothing fails to say so.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { signInAs } from '../helpers/clients';
import { F, buildWorld, teardown, type World } from '../helpers/fixtures';
import { closeDb, q } from '../helpers/db';

let world: World;
let rm: SupabaseClient;
let admin: SupabaseClient;
let partnerA: SupabaseClient;

/** The partner-pair under test: Partner A on the dedicated USD/ZAR pair. */
let ppId: string;

interface BoardRow {
  rate_id: string;
  partner_name: string;
  reason?: string;
  client_rate: string | null;
}
interface Board {
  eligible: BoardRow[];
  ineligible: BoardRow[];
  withheld_count: number;
  rankable: boolean;
}

async function board(
  direction = 'client_sells_base',
  amount: string | null = null,
  markup: string | null = null,
): Promise<Board> {
  const { data, error } = await rm.rpc('board_rates', {
    p_currency_pair_id: world.testPairId,
    p_direction: direction,
    p_amount: amount,
    p_markup_bps: markup,
  });
  if (error) throw new Error(`board_rates: ${error.message}`);
  return data as unknown as Board;
}

/** Every row the board returns, eligible or not. */
const allRows = (b: Board) => [...b.eligible, ...b.ineligible];

beforeAll(async () => {
  world = await buildWorld();
  rm = await signInAs(F.users.rm);
  admin = await signInAs(F.users.admin);
  partnerA = await signInAs(F.users.aAdmin);

  // Partner A takes the dedicated pair, and it gets its own markup version.
  const added = await partnerA.rpc('add_partner_pair', {
    p_currency_pair_id: world.testPairId,
  });
  if (added.error) throw new Error(added.error.message);
  ppId = (added.data as { id: string }).id;

  const mv = await admin.rpc('create_markup_version', {
    p_currency_pair_id: world.testPairId,
    p_default: '50',
    p_min: '0',
    p_max: '200',
    p_reason: 'eligibility fixture',
  });
  if (mv.error) throw new Error(mv.error.message);
});

afterAll(async () => {
  await teardown();
  await closeDb();
});

/** A fresh, live, two-sided, confirmed-band rate on the pair under test. */
async function seedLiveRate(min = '0', max: string | null = '100000') {
  await q(`delete from public.rates where partner_pair_id = $1`, [ppId]);
  const { error } = await partnerA.rpc('submit_rates', {
    p_rows: [
      {
        currency_pair_id: world.testPairId,
        bid: '18.40',
        ask: '18.60',
        size_status: 'confirmed',
        min_size: min,
        max_size: max,
      },
    ],
    p_valid_until: null,
    p_raw: null,
    p_idem: null,
  });
  if (error) throw new Error(error.message);
  const [row] = await q<{ id: string }>(
    `select id from public.rates
      where partner_pair_id = $1 and superseded_by is null and withdrawn_at is null`,
    [ppId],
  );
  return row!.id;
}

/**
 * Push a rate wholly into the past.
 *
 * The rates table enforces validity_order: valid_from <= expiry_warning_at <=
 * valid_until. Moving only valid_until backwards violates it, so all three
 * stamps move together. That constraint caught this fixture being wrong, which
 * is what it is for.
 */
async function expireRate(partnerPairId: string) {
  await q(
    `update public.rates
        set valid_from        = now() - interval '9 hours',
            expiry_warning_at = now() - interval '3 hours',
            valid_until       = now() - interval '1 hour'
      where partner_pair_id = $1 and superseded_by is null and withdrawn_at is null`,
    [partnerPairId],
  );
}

/** Retire the pair's markup through the real RPC -- retired_shape requires
 *  retired_by as well as retired_at, so a raw UPDATE is not equivalent. */
async function retireMarkup() {
  const [mv] = await q<{ id: string }>(
    `select id from public.markup_versions
      where currency_pair_id = $1 and status = 'active'`,
    [world.testPairId],
  );
  if (mv) {
    const { error } = await admin.rpc('retire_markup_version', {
      p_id: mv.id,
      p_reason: 'eligibility test',
    });
    if (error) throw new Error(error.message);
  }
}

/** Restore the pair to a fully healthy state between gates. */
async function reset() {
  await q(`update public.partners set status = 'active', convention_confirmed_at = now()
            where id = $1`, [world.partnerAId]);
  await q(`update public.partner_pairs set active = true, quote_mode = 'two_way' where id = $1`, [ppId]);
  // create_markup_version retires the current active version and creates the
  // new one in a single transaction, so markup_one_active is never violated.
  // Flipping rows back to 'active' by hand can leave two active at once.
  const [active] = await q<{ id: string }>(
    `select id from public.markup_versions
      where currency_pair_id = $1 and status = 'active'`,
    [world.testPairId],
  );
  if (!active) {
    const { error } = await admin.rpc('create_markup_version', {
      p_currency_pair_id: world.testPairId,
      p_default: '50',
      p_min: '0',
      p_max: '200',
      p_reason: 'eligibility fixture reset',
    });
    if (error) throw new Error(error.message);
  }
  return seedLiveRate();
}

describe('§14 -- the baseline: a healthy row is eligible', () => {
  it('renders and prices when every gate passes', async () => {
    await reset();
    const b = await board();
    expect(b.eligible).toHaveLength(1);
    expect(b.ineligible).toHaveLength(0);
    expect(b.eligible[0]!.client_rate).not.toBeNull();
    expect(b.rankable).toBe(true);
  });
});

describe('§14 E1–E5 -- these rows are NOT RENDERED AT ALL', () => {
  it('E1 partner inactive', async () => {
    await reset();
    await q(`update public.partners set status = 'inactive' where id = $1`, [world.partnerAId]);
    const b = await board();
    expect(allRows(b), 'an inactive partner must not appear even below the divider').toHaveLength(0);
  });

  it('E2 convention not confirmed -- the [A-1] gate', async () => {
    await reset();
    await q(`update public.partners set convention_confirmed_at = null where id = $1`, [
      world.partnerAId,
    ]);
    const b = await board();
    expect(allRows(b), 'an unconfirmed convention must never reach the board').toHaveLength(0);
  });

  it('E3 pair not offered', async () => {
    await reset();
    await q(`update public.partner_pairs set active = false where id = $1`, [ppId]);
    const b = await board();
    expect(allRows(b)).toHaveLength(0);
  });

  it('E4 withdrawn by partner', async () => {
    const rateId = await reset();
    const { error } = await partnerA.rpc('withdraw_rate', {
      p_rate_id: rateId,
      p_reason: 'pulled',
    });
    expect(error).toBeNull();
    const b = await board();
    expect(allRows(b), 'a withdrawn rate is gone from the board entirely').toHaveLength(0);
  });

  it('E5 superseded', async () => {
    const firstId = await reset();
    await partnerA.rpc('submit_rates', {
      p_rows: [
        {
          currency_pair_id: world.testPairId,
          bid: '18.45',
          ask: '18.65',
          size_status: 'confirmed',
          min_size: '0',
          max_size: '100000',
        },
      ],
      p_valid_until: null,
      p_raw: null,
      p_idem: null,
    });
    const b = await board();
    // Exactly one row, and it is not the superseded one.
    expect(allRows(b)).toHaveLength(1);
    expect(allRows(b)[0]!.rate_id).not.toBe(firstId);
  });
});

describe('§14 E6–E9 -- these rows ARE rendered, below the divider, with a reason', () => {
  it('E6 partner quotes one side only', async () => {
    await reset();
    // A bid-only pair, asked for the direction that needs the ask.
    await q(`update public.partner_pairs set quote_mode = 'bid_only' where id = $1`, [ppId]);
    await q(`update public.rates set partner_ask = null where partner_pair_id = $1`, [ppId]);

    const b = await board('client_buys_base');
    expect(b.eligible).toHaveLength(0);
    expect(b.ineligible).toHaveLength(1);
    expect(b.ineligible[0]!.reason).toBe('partner quotes one side only');
    expect(b.withheld_count).toBe(1);

    // ...and the OTHER direction still prices, because the bid is present.
    const other = await board('client_sells_base');
    expect(other.eligible).toHaveLength(1);
  });

  it('E7 expired, naming the expiry in SGT', async () => {
    await reset();
    await expireRate(ppId);
    const b = await board();
    expect(b.eligible).toHaveLength(0);
    expect(b.ineligible).toHaveLength(1);
    // §14: "expired, valid until HH:MM SGT" -- the RM is told WHEN.
    expect(b.ineligible[0]!.reason).toMatch(/^expired, valid until \d{2}:\d{2} SGT$/);
  });

  it('E7 names the DATE when the expiry was not today (A-3)', async () => {
    await reset();
    // Expired 30 hours ago: yesterday in SGT, whatever the hour.
    await q(
      `update public.rates
          set valid_from        = now() - interval '38 hours',
              expiry_warning_at = now() - interval '32 hours',
              valid_until       = now() - interval '30 hours'
        where partner_pair_id = $1 and superseded_by is null and withdrawn_at is null`,
      [ppId],
    );
    const b = await board();
    expect(b.ineligible).toHaveLength(1);
    // §14's bare "HH:MM SGT" is ambiguous across a date boundary: SGT is UTC+8
    // and a partner who stops submitting leaves rates that expired on an
    // earlier day, so a bare time can read as a moment still ahead of the
    // reader. Observed live at 08:33 SGT on the 27th, where a rate that
    // expired at 23:35 on the 26th had reported only "23:35 SGT".
    expect(b.ineligible[0]!.reason).toMatch(
      /^expired, valid until \d{2} [A-Z][a-z]{2,3} \d{2}:\d{2} SGT$/,
    );
  });

  it('E8 size not confirmed by partner', async () => {
    await q(`delete from public.rates where partner_pair_id = $1`, [ppId]);
    await partnerA.rpc('submit_rates', {
      p_rows: [
        { currency_pair_id: world.testPairId, bid: '18.40', ask: '18.60', size_status: 'unconfirmed' },
      ],
      p_valid_until: null,
      p_raw: null,
      p_idem: null,
    });

    // With no amount, an unconfirmed row is eligible and labelled.
    const noAmount = await board();
    expect(noAmount.eligible).toHaveLength(1);

    // With an amount, D10 applies: unknown size is never treated as unlimited.
    const withAmount = await board('client_sells_base', '50000');
    expect(withAmount.eligible).toHaveLength(0);
    expect(withAmount.ineligible[0]!.reason).toBe('size not confirmed by partner');
  });

  it('E8 outside the size range, naming the range', async () => {
    await reset(); // band is 0 – 100000
    const b = await board('client_sells_base', '250000');
    expect(b.eligible).toHaveLength(0);
    expect(b.ineligible[0]!.reason).toMatch(/^outside size range, 0 to 100000$/);
  });

  it('E9 no active markup -- nothing on the pair can be quoted', async () => {
    await reset();
    await retireMarkup();
    const b = await board();
    expect(b.eligible).toHaveLength(0);
    expect(b.ineligible).toHaveLength(1);
    expect(b.ineligible[0]!.reason).toBe('no active markup');
    // §15.2 rule 5: without ranking inputs the board must not number rows.
    expect(b.rankable).toBe(false);
  });
});

describe('§14 -- "applied in order": the earliest failing gate wins', () => {
  it('reports E1 rather than E7 when a row is both inactive and expired', async () => {
    await reset();
    await q(`update public.partners set status = 'inactive' where id = $1`, [world.partnerAId]);
    await expireRate(ppId);
    const b = await board();
    // E1 precedes E7, and E1 is a not-rendered gate -- so the row vanishes
    // rather than appearing below the divider as "expired".
    expect(allRows(b)).toHaveLength(0);
  });

  it('reports E2 rather than E9 when the convention is unconfirmed and markup is gone', async () => {
    await reset();
    await q(`update public.partners set convention_confirmed_at = null where id = $1`, [
      world.partnerAId,
    ]);
    await retireMarkup();
    const b = await board();
    expect(allRows(b), 'E2 precedes E9 and hides the row entirely').toHaveLength(0);
  });

  it('reports E7 rather than E8 when a row is both expired and out of band', async () => {
    await reset();
    await expireRate(ppId);
    const b = await board('client_sells_base', '250000');
    expect(b.ineligible).toHaveLength(1);
    expect(b.ineligible[0]!.reason).toMatch(/^expired/);
  });
});

describe('§8 -- record_quote_copy re-runs eligibility, it does not trust the board', () => {
  it('refuses to quote a rate that has since expired', async () => {
    const rateId = await reset();
    // The RM saw it live; by the time they copy, it has expired.
    await expireRate(ppId);
    const { error } = await rm.rpc('record_quote_copy', {
      p_rate_id: rateId,
      p_direction: 'client_sells_base',
      p_amount: null,
      p_markup_bps: '50',
    });
    expect(error, 'an expired rate must not be quotable').not.toBeNull();
    expect(error!.message).toMatch(/expired/i);
  });

  it('refuses to quote a withdrawn rate', async () => {
    const rateId = await reset();
    await partnerA.rpc('withdraw_rate', { p_rate_id: rateId, p_reason: 'pulled' });
    const { error } = await rm.rpc('record_quote_copy', {
      p_rate_id: rateId,
      p_direction: 'client_sells_base',
      p_amount: null,
      p_markup_bps: '50',
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/withdrawn/i);
  });

  it('writes no quote.copy audit event when it refuses', async () => {
    const rateId = await reset();
    await expireRate(ppId);
    const before = await q<{ n: number }>(
      `select count(*)::int as n from public.audit_events where action = 'quote.copy'`,
    );
    await rm.rpc('record_quote_copy', {
      p_rate_id: rateId,
      p_direction: 'client_sells_base',
      p_amount: null,
      p_markup_bps: '50',
    });
    const after = await q<{ n: number }>(
      `select count(*)::int as n from public.audit_events where action = 'quote.copy'`,
    );
    // The pricing record must not contain a quote that was never given.
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
