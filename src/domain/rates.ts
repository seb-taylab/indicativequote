/**
 * The correctness spine. Spec §10.2, §10.3, §15.1.
 *
 * "Ambiguity here produces confidently wrong client prices."
 *
 * Three rules live in this file and nowhere else:
 *
 *   1. The direction-to-side mapping exists in EXACTLY ONE function (§10.2)
 *      and is never re-derived. If you find yourself writing
 *      `direction === 'client_sells_base' ? bid : ask` anywhere else, that is
 *      the defect this file exists to prevent.
 *
 *   2. Markup WIDENS the spread (§15.1). Both sides move away from the partner
 *      price. A markup implemented as a single directional addition makes
 *      roughly half of all quotes wrong in the client's favour.
 *
 *   3. Inverting a pair SWAPS the sides (§10.3). A reciprocal without the swap
 *      inverts the spread and produces a rate wrong in the client's favour on
 *      every inverse pair.
 *
 * D13/§12.7: decimals cross every boundary as strings. Every value in and out
 * of this module is a string, and Decimal is the only arithmetic used. There
 * is no Number(), no parseFloat, no `+` on a rate.
 */
import Decimal from 'decimal.js';

// numeric(28,14) in the database. Configure Decimal with enough working
// precision that a reciprocal round-trips inside that scale.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 });

/** The scale of rates.partner_bid / partner_ask. */
export const RATE_SCALE = 14;

/** §10.2, stated in client-action language. "bid" and "ask" are never UI labels. */
export type Direction = 'client_sells_base' | 'client_buys_base';

/** §10.1 */
export type Side = 'bid' | 'ask';

/**
 * §10.2 — THE mapping. The only place in the codebase that decides which side
 * of a partner's quote a client direction consumes.
 *
 *   client_sells_base  client gives BASE, receives QUOTE  -> partner_bid
 *   client_buys_base   client gives QUOTE, receives BASE  -> partner_ask
 */
export function sideForDirection(direction: Direction): Side {
  switch (direction) {
    case 'client_sells_base':
      return 'bid';
    case 'client_buys_base':
      return 'ask';
    default: {
      // Exhaustiveness: a new direction must not silently fall through to a
      // side, which would price it wrongly rather than failing.
      const never: never = direction;
      throw new Error(`unknown direction: ${String(never)}`);
    }
  }
}

/**
 * §7 — the amount column's header changes with the direction, "because the
 * client's position changes with it". A single "Amount received" header is
 * wrong for half of all quotes and MUST NOT be used.
 */
export function amountHeader(direction: Direction, quoteCcy: string): string {
  return direction === 'client_sells_base' ? `${quoteCcy} received` : `${quoteCcy} paid`;
}

export interface ClientRates {
  clientBid: string | null;
  clientAsk: string | null;
}

/**
 * §15.1 — markup widens the spread.
 *
 *   client_bid = partner_bid * (1 - m/10000)   client receives less when selling base
 *   client_ask = partner_ask * (1 + m/10000)   client pays more when buying base
 *
 * Both sides move AWAY from the partner price. Never toward it.
 */
export function applyMarkup(
  partnerBid: string | null,
  partnerAsk: string | null,
  markupBps: string,
): ClientRates {
  const m = new Decimal(markupBps);
  if (m.isNegative()) throw new Error('markup must not be negative');

  const factor = m.div(10_000);
  return {
    clientBid: partnerBid === null
      ? null
      : new Decimal(partnerBid).times(new Decimal(1).minus(factor)).toFixed(RATE_SCALE),
    clientAsk: partnerAsk === null
      ? null
      : new Decimal(partnerAsk).times(new Decimal(1).plus(factor)).toFixed(RATE_SCALE),
  };
}

/**
 * The single client-facing rate for a direction, after markup. This is what
 * ranking sorts on (§15.2) and what a copied quote quotes (§8).
 */
export function clientRateFor(
  direction: Direction,
  partnerBid: string | null,
  partnerAsk: string | null,
  markupBps: string,
): string | null {
  const { clientBid, clientAsk } = applyMarkup(partnerBid, partnerAsk, markupBps);
  return sideForDirection(direction) === 'bid' ? clientBid : clientAsk;
}

export interface Inverted {
  bid: string | null;
  ask: string | null;
}

/**
 * §10.3 — normalise an inverse submission to the canonical orientation.
 *
 *   canonical_bid = 1 / inverse_ask
 *   canonical_ask = 1 / inverse_bid
 *
 * THE SIDES SWAP. Golden test 3 asserts that the naive reciprocal — bid from
 * bid, ask from ask — fails, because it inverts the spread and produces a rate
 * wrong in the client's favour on every inverse pair.
 *
 * Size bounds do not survive: bounds stated in the inverse pair's base are
 * bounds in the canonical QUOTE currency, which D9 does not permit. The caller
 * MUST mark a normalised row's size `unconfirmed` unless the partner restates
 * it. This function deliberately does not accept or return sizes, so there is
 * nothing to carry across by accident.
 */
export function invertQuote(inverseBid: string | null, inverseAsk: string | null): Inverted {
  const one = new Decimal(1);
  for (const v of [inverseBid, inverseAsk]) {
    if (v !== null && new Decimal(v).lessThanOrEqualTo(0)) {
      throw new Error('a rate must be positive to invert');
    }
  }
  return {
    // note the crossing: ask feeds bid, bid feeds ask
    bid: inverseAsk === null ? null : one.div(new Decimal(inverseAsk)).toFixed(RATE_SCALE),
    ask: inverseBid === null ? null : one.div(new Decimal(inverseBid)).toFixed(RATE_SCALE),
  };
}

/** §10.1 invariant, checked before a row is ever offered for submission. */
export function isCrossed(bid: string | null, ask: string | null): boolean {
  if (bid === null || ask === null) return false;
  return new Decimal(bid).greaterThan(new Decimal(ask));
}

/** The spread, as a string. Null unless both sides are present. */
export function spread(bid: string | null, ask: string | null): string | null {
  if (bid === null || ask === null) return null;
  return new Decimal(ask).minus(new Decimal(bid)).toFixed(RATE_SCALE);
}

/**
 * §7 — the direction-dependent amount column.
 *   client_sells_base -> amount x client_bid   (QUOTE received)
 *   client_buys_base  -> amount x client_ask   (QUOTE paid)
 */
export function counterAmount(
  direction: Direction,
  amount: string,
  clientRate: string,
): string {
  return new Decimal(amount).times(new Decimal(clientRate)).toFixed(2);
}

/**
 * §15.2 — ranking. Sort direction depends on side; "a single unconditional
 * sort is a defect".
 *
 *   client_sells_base  the client receives QUOTE  -> higher is better  -> desc
 *   client_buys_base   the client pays QUOTE      -> lower is better   -> asc
 */
export function compareForRanking(
  direction: Direction,
  a: string,
  b: string,
): number {
  const cmp = new Decimal(a).comparedTo(new Decimal(b));
  return direction === 'client_sells_base' ? -cmp : cmp;
}
