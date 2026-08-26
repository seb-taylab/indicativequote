/**
 * The correctness spine, and golden tests 1 and 3.
 *
 * These need no database and no credentials: they test the pure functions that
 * decide whether a client price is right. §20.3 marks direction mapping,
 * markup and canonicalisation all Critical.
 */
import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import {
  amountHeader,
  applyMarkup,
  clientRateFor,
  compareForRanking,
  counterAmount,
  invertQuote,
  isCrossed,
  sideForDirection,
  spread,
} from '../../src/domain/rates';
import { buildRegistry, parseRateBlock, spreadWarning, moveWarning } from '../../src/domain/parser';

const REGISTRY = buildRegistry(
  ['USD', 'NGN', 'GHS', 'KES', 'ZAR'],
  [
    { id: 'pair-usd-ngn', baseCcy: 'USD', quoteCcy: 'NGN' },
    { id: 'pair-usd-ghs', baseCcy: 'USD', quoteCcy: 'GHS' },
    { id: 'pair-usd-kes', baseCcy: 'USD', quoteCcy: 'KES' },
  ],
);

describe('§10.2 -- the direction to side mapping', () => {
  it('maps client_sells_base to the partner bid', () => {
    expect(sideForDirection('client_sells_base')).toBe('bid');
  });
  it('maps client_buys_base to the partner ask', () => {
    expect(sideForDirection('client_buys_base')).toBe('ask');
  });
  it('changes the amount header with the direction (§7)', () => {
    // "A single 'Amount received' header is wrong for half of all quotes and
    //  MUST NOT be used."
    expect(amountHeader('client_sells_base', 'NGN')).toBe('NGN received');
    expect(amountHeader('client_buys_base', 'NGN')).toBe('NGN paid');
  });
});

describe('§15.1 -- markup widens the spread', () => {
  it('moves BOTH sides away from the partner price, never toward it', () => {
    const { clientBid, clientAsk } = applyMarkup('1392', '1394', '50');
    expect(new Decimal(clientBid!).lessThan(1392)).toBe(true);
    expect(new Decimal(clientAsk!).greaterThan(1394)).toBe(true);
  });

  it('widens, never narrows', () => {
    const before = new Decimal(spread('1392', '1394')!);
    const { clientBid, clientAsk } = applyMarkup('1392', '1394', '50');
    const after = new Decimal(spread(clientBid, clientAsk)!);
    expect(after.greaterThan(before)).toBe(true);
  });

  it('is a no-op at zero bps', () => {
    const { clientBid, clientAsk } = applyMarkup('1392', '1394', '0');
    expect(new Decimal(clientBid!).equals(1392)).toBe(true);
    expect(new Decimal(clientAsk!).equals(1394)).toBe(true);
  });

  it('rejects a negative markup', () => {
    expect(() => applyMarkup('1392', '1394', '-1')).toThrow();
  });

  it('handles a one-sided quote without inventing the other side', () => {
    const { clientBid, clientAsk } = applyMarkup('1392', null, '50');
    expect(clientBid).not.toBeNull();
    expect(clientAsk).toBeNull();
  });
});

describe('Golden test 1 -- the direction round trip (§20.1)', () => {
  // "Assert an RM selecting `Client sells USD` on USD/NGN sees a client rate
  //  derived from 1392, not 1394, and that applying 50 bps makes that number
  //  SMALLER, not larger."
  const BID = '1392';
  const ASK = '1394';

  it('derives Client sells USD from the bid, not the ask', () => {
    const raw = clientRateFor('client_sells_base', BID, ASK, '0');
    expect(new Decimal(raw!).equals(1392)).toBe(true);
    expect(new Decimal(raw!).equals(1394)).toBe(false);
  });

  it('makes that number smaller when 50 bps is applied', () => {
    const at0 = new Decimal(clientRateFor('client_sells_base', BID, ASK, '0')!);
    const at50 = new Decimal(clientRateFor('client_sells_base', BID, ASK, '50')!);
    expect(at50.lessThan(at0)).toBe(true);
    // 1392 * (1 - 0.005) = 1385.04
    expect(at50.toFixed(2)).toBe('1385.04');
  });

  it('derives Client buys USD from the ask, and 50 bps makes it larger', () => {
    const at0 = new Decimal(clientRateFor('client_buys_base', BID, ASK, '0')!);
    const at50 = new Decimal(clientRateFor('client_buys_base', BID, ASK, '50')!);
    expect(at0.equals(1394)).toBe(true);
    expect(at50.greaterThan(at0)).toBe(true);
    // 1394 * 1.005 = 1400.97
    expect(at50.toFixed(2)).toBe('1400.97');
  });

  it('computes the counter amount from the direction-correct side', () => {
    const sells = clientRateFor('client_sells_base', BID, ASK, '50')!;
    const buys = clientRateFor('client_buys_base', BID, ASK, '50')!;
    // 100,000 USD sold -> NGN received; 100,000 USD bought -> NGN paid
    expect(counterAmount('client_sells_base', '100000', sells)).toBe('138504000.00');
    expect(counterAmount('client_buys_base', '100000', buys)).toBe('140097000.00');
    // The client always receives less than they would pay. If this ever
    // inverts, the markup has been applied toward the partner price.
    expect(
      new Decimal(counterAmount('client_sells_base', '100000', sells)).lessThan(
        new Decimal(counterAmount('client_buys_base', '100000', buys)),
      ),
    ).toBe(true);
  });
});

describe('Golden test 3 -- the inverse-pair test (§20.1)', () => {
  // "Submit NGN/USD 0.000717 | 0.000719 for a partner whose canonical pair is
  //  USD/NGN. Assert the stored row is partner_bid ~ 1390.82 and
  //  partner_ask ~ 1394.70 -- 1/0.000719 and 1/0.000717, SIDES SWAPPED.
  //  Assert the naive reciprocal without the swap fails the test."
  const INV_BID = '0.000717';
  const INV_ASK = '0.000719';

  it('swaps the sides: bid comes from 1/inverse_ask', () => {
    const { bid, ask } = invertQuote(INV_BID, INV_ASK);
    expect(new Decimal(bid!).toFixed(2)).toBe('1390.82');
    expect(new Decimal(ask!).toFixed(2)).toBe('1394.70');
  });

  it('the naive reciprocal, without the swap, is wrong', () => {
    // 1/0.000717 = 1394.70 as a "bid" and 1/0.000719 = 1390.82 as an "ask"
    const naiveBid = new Decimal(1).div(new Decimal(INV_BID));
    const naiveAsk = new Decimal(1).div(new Decimal(INV_ASK));
    // It produces a CROSSED rate -- bid above ask -- which is how you know the
    // spread has been inverted.
    expect(naiveBid.greaterThan(naiveAsk)).toBe(true);
    expect(isCrossed(naiveBid.toFixed(14), naiveAsk.toFixed(14))).toBe(true);

    const correct = invertQuote(INV_BID, INV_ASK);
    expect(isCrossed(correct.bid, correct.ask)).toBe(false);
    expect(new Decimal(correct.bid!).equals(naiveBid)).toBe(false);
  });

  it('preserves the spread rather than inverting it', () => {
    const { bid, ask } = invertQuote(INV_BID, INV_ASK);
    expect(new Decimal(spread(bid, ask)!).greaterThan(0)).toBe(true);
  });

  it('normalises through the parser, flags it, and drops the size', () => {
    const out = parseRateBlock('NGN/USD 0.000717 | 0.000719', REGISTRY);
    expect(out.rows).toHaveLength(1);
    const row = out.rows[0]!;
    expect(row.normalisedFromInverse).toBe(true);
    expect(row.baseCcy).toBe('USD');
    expect(row.quoteCcy).toBe('NGN');
    expect(new Decimal(row.bid!).toFixed(2)).toBe('1390.82');
    expect(new Decimal(row.ask!).toFixed(2)).toBe('1394.70');
    expect(row.original).toEqual({
      baseCcy: 'NGN', quoteCcy: 'USD', bid: '0.000717', ask: '0.000719',
    });
    // §10.3: size bounds do not survive normalisation. The warning says so.
    expect(row.warnings.some((w) => w.code === 'normalised_from_inverse')).toBe(true);
    expect(row.warnings[0]!.message).toMatch(/size/i);
  });
});

describe('§6.5 -- the parser handles every observed variant', () => {
  it('canonical: USD/NGN 1392 | 1394', () => {
    const out = parseRateBlock('USD/NGN 1392 | 1394', REGISTRY);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ baseCcy: 'USD', quoteCcy: 'NGN', bid: '1392', ask: '1394' });
  });

  it('no separator: USDNGN 1392 / 1394', () => {
    const out = parseRateBlock('USDNGN 1392 / 1394', REGISTRY);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ baseCcy: 'USD', quoteCcy: 'NGN', bid: '1392', ask: '1394' });
  });

  it('lowercase with a dash: usd/ghs 11.77-11.81', () => {
    const out = parseRateBlock('usd/ghs 11.77-11.81', REGISTRY);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ baseCcy: 'USD', quoteCcy: 'GHS', bid: '11.77', ask: '11.81' });
  });

  it('space separated: USD KES 129.31 129.55', () => {
    const out = parseRateBlock('USD KES 129.31 129.55', REGISTRY);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ baseCcy: 'USD', quoteCcy: 'KES', bid: '129.31', ask: '129.55' });
  });

  it('thousands separators: USD/NGN 1,392 | 1,394', () => {
    const out = parseRateBlock('USD/NGN 1,392 | 1,394', REGISTRY);
    expect(out.rows).toHaveLength(1);
    // Stripped, and never passed through Number()
    expect(out.rows[0]).toMatchObject({ bid: '1392', ask: '1394' });
  });

  it('ignores greetings and signoffs, and reports them as ignored', () => {
    const out = parseRateBlock(
      ['Morning Seb, rates below', 'USD/NGN 1392 | 1394', 'Thanks!'].join('\n'),
      REGISTRY,
    );
    expect(out.rows).toHaveLength(1);
    expect(out.ignored.map((i) => i.lineNumber)).toEqual([1, 3]);
    expect(out.rejected).toHaveLength(0);
  });

  it('parses a whole realistic block in one pass', () => {
    const out = parseRateBlock(
      [
        'Morning! today:',
        'USD/NGN 1,392 | 1,394',
        'usd/ghs 11.77-11.81',
        'USD KES 129.31 129.55',
        'regards',
      ].join('\n'),
      REGISTRY,
    );
    expect(out.rows).toHaveLength(3);
    expect(out.ignored).toHaveLength(2);
    expect(out.rejected).toHaveLength(0);
  });
});

describe('§6.3 -- errors block the row, and only that row', () => {
  it('error 1: a crossed rate is an error, never a swap', () => {
    const out = parseRateBlock('USD/NGN 1394 | 1392', REGISTRY);
    expect(out.rows).toHaveLength(0);
    expect(out.rejected[0]!.code).toBe('crossed');
    expect(out.rejected[0]!.message).toMatch(/Swap them or correct one/);
  });

  it('error 3: three or more numbers is reported, never guessed', () => {
    const out = parseRateBlock('USD/NGN 1392 | 1394 | 1396', REGISTRY);
    expect(out.rows).toHaveLength(0);
    expect(out.rejected[0]!.code).toBe('too_many_numbers');
  });

  it('error 5: an unknown currency is rejected', () => {
    const out = parseRateBlock('USD/XYZ 1392 | 1394', REGISTRY);
    expect(out.rejected[0]!.code).toBe('unknown_currency');
  });

  it('error 6: a pair absent from the registry in both orientations is rejected', () => {
    const out = parseRateBlock('ZAR/NGN 1 | 2', REGISTRY);
    expect(out.rejected[0]!.code).toBe('unknown_pair');
  });

  it('a bad line blocks only itself; the good rows still parse (§6.4)', () => {
    const out = parseRateBlock(
      ['USD/NGN 1392 | 1394', 'USD/NGN 1394 | 1392', 'USD KES 129.31 129.55'].join('\n'),
      REGISTRY,
    );
    expect(out.rows).toHaveLength(2);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.lineNumber).toBe(2);
    // §6.3 error 2: never dropped silently -- the original text comes back.
    expect(out.rejected[0]!.raw).toBe('USD/NGN 1394 | 1392');
  });

  it('a single number is carried as one side for the grid to judge', () => {
    // The parser cannot know the pair's quote_mode, so it reports rather than
    // rejecting or inventing the missing side.
    const out = parseRateBlock('USD/NGN 1392', REGISTRY);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ bid: '1392', ask: null });
  });
});

describe('§6.3 -- warnings do not block', () => {
  it('warns on an implausible spread', () => {
    expect(spreadWarning('1000', '1394', '5')).not.toBeNull();
    expect(spreadWarning('1392', '1394', '5')).toBeNull();
  });

  it('warns on a large move, in either direction', () => {
    expect(moveWarning('1392', '1600', '5', 'NGN')?.message).toMatch(/moved/);
    expect(moveWarning('1600', '1392', '5', 'NGN')).not.toBeNull();
    expect(moveWarning('1392', '1394', '5', 'NGN')).toBeNull();
  });
});

describe('§15.2 -- ranking', () => {
  it('sorts descending when the client sells base, ascending when it buys', () => {
    const rates = ['1390', '1395', '1392'];
    expect([...rates].sort((a, b) => compareForRanking('client_sells_base', a, b))).toEqual(
      ['1395', '1392', '1390'],
    );
    expect([...rates].sort((a, b) => compareForRanking('client_buys_base', a, b))).toEqual(
      ['1390', '1392', '1395'],
    );
  });
});

describe('§12.7 -- precision survives the boundary', () => {
  it('round-trips a high-magnitude rate without loss', () => {
    const v = '1392.12345678901234';
    expect(new Decimal(v).toFixed(14)).toBe('1392.12345678901234');
  });

  it('round-trips a low-magnitude rate without loss', () => {
    const v = '0.00000071812345';
    expect(new Decimal(v).toFixed(14)).toBe('0.00000071812345');
  });

  it('a value that a JS double would corrupt survives as a string', () => {
    const v = '1392.10000000000002';
    // This is the failure §12.7 exists to prevent.
    expect(String(Number(v))).not.toBe(v);
    expect(new Decimal(v).toFixed(14)).toBe('1392.10000000000002');
  });
});

describe('Display formatting never loses a digit (§12.7)', () => {
  it('trims storage-scale zeros without touching the value', async () => {
    const { dec } = await import('../../components/fmt');
    expect(dec('1501.50000000000000')).toBe('1501.5');
    expect(dec('1493.99250000000000')).toBe('1493.9925');
    expect(dec('2.00000000000000')).toBe('2');
    expect(dec('1392')).toBe('1392');
    expect(dec(null)).toBe('—');
  });

  it('keeps every significant digit, including tiny magnitudes', async () => {
    const { dec } = await import('../../components/fmt');
    // An inverse-pair rate. Trimming must not round this to nothing.
    expect(dec('0.00000071812345')).toBe('0.00000071812345');
    expect(dec('1392.10000000000002')).toBe('1392.10000000000002');
  });

  it('groups sizes and amounts for reading', async () => {
    const { dec, size, band } = await import('../../components/fmt');
    expect(size('100000.000000')).toBe('100,000');
    expect(size('100000.000001')).toBe('100,000.000001');
    expect(dec('69252000.00', { group: true, minDp: 2 })).toBe('69,252,000.00');
    expect(band('confirmed', '0', '100000.000000')).toBe('0 – 100,000');
    expect(band('unconfirmed', null, null)).toBe('not confirmed');
  });

  it('is pure string surgery -- a value JS cannot hold survives', async () => {
    const { dec } = await import('../../components/fmt');
    const v = '9007199254740993.50000000000000'; // beyond Number.MAX_SAFE_INTEGER
    expect(dec(v)).toBe('9007199254740993.5');
    expect(String(Number(v))).not.toBe('9007199254740993.5');
  });
});
