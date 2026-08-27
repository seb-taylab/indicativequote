/**
 * §20.3: "Parser -- every observed variant, plus TRANSPOSED, MALFORMED and
 * HOSTILE input. Priority: High."
 *
 * The well-formed variants are covered in domain.test.ts. This file is about
 * the other kind of input, and it matters more than it looks: `raw_input` is
 * arbitrary text arriving from an external party over WhatsApp, pasted by a
 * human into a box. It is the least trusted data in the system.
 *
 * The parser's contract makes it safe to be strict here — §6.5: "The parser is
 * a pure function. It writes nothing. It returns rows and diagnostics; the grid
 * decides what is submitted." So the bar for every case below is one of:
 *
 *   - parse it correctly, or
 *   - reject it with a reason a partner can act on, or
 *   - ignore it as prose and say so
 *
 * What it must never do is GUESS. §6.3 error 3 is explicit: three or more
 * numbers on a line is "reported, never guessed". A parser that guesses turns
 * a fat-fingered message into a confidently wrong price.
 */
import { describe, expect, it } from 'vitest';
import { buildRegistry, parseRateBlock } from '../../src/domain/parser';

const REGISTRY = buildRegistry(
  ['USD', 'NGN', 'GHS', 'KES', 'ZAR'],
  [
    { id: 'pair-usd-ngn', baseCcy: 'USD', quoteCcy: 'NGN' },
    { id: 'pair-usd-ghs', baseCcy: 'USD', quoteCcy: 'GHS' },
  ],
);

const parse = (text: string) => parseRateBlock(text, REGISTRY);

/** Nothing may crash, and nothing may silently disappear. */
function accountsForEveryLine(text: string) {
  const out = parse(text);
  const meaningful = text.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  const seen = out.rows.length + out.rejected.length + out.ignored.length;
  return { out, meaningful, seen };
}

describe('Degenerate input never throws', () => {
  const CASES: Array<[string, string]> = [
    ['empty string', ''],
    ['only whitespace', '   \n\t\n   '],
    ['only newlines', '\n\n\n\n'],
    ['a single character', 'x'],
    ['only punctuation', '!!! ??? ***'],
    ['only digits', '1392'],
    ['only a pair', 'USD/NGN'],
    ['a lone separator', '|'],
    ['null-ish text', 'null undefined NaN Infinity'],
    ['emoji', '👋 USD/NGN 🚀'],
    ['RTL text', 'مرحبا USD/NGN 1392 | 1394'],
    ['zero-width characters', 'USD/NGN​ 1392 | 1394'],
    ['CRLF line endings', 'USD/NGN 1392 | 1394\r\nUSD/GHS 11.7 | 11.8\r\n'],
  ];

  for (const [name, input] of CASES) {
    it(`survives ${name}`, () => {
      expect(() => parse(input)).not.toThrow();
      const out = parse(input);
      // Whatever it decides, the shape is always intact.
      expect(Array.isArray(out.rows)).toBe(true);
      expect(Array.isArray(out.rejected)).toBe(true);
      expect(Array.isArray(out.ignored)).toBe(true);
    });
  }
});

describe('No line is ever silently dropped (§6.3 error 2)', () => {
  it('accounts for every non-empty line as parsed, rejected or ignored', () => {
    const text = [
      'Morning!',
      'USD/NGN 1392 | 1394',
      'USD/NGN 1394 | 1392',
      'USD/XYZ 1 | 2',
      'USD/NGN 1 2 3 4',
      'complete gibberish ####',
      'Thanks',
    ].join('\n');
    const { out, meaningful, seen } = accountsForEveryLine(text);
    expect(seen, 'a line vanished without being reported').toBe(meaningful);
    // And every rejection carries the ORIGINAL text back, verbatim.
    for (const r of out.rejected) {
      expect(text.split('\n')).toContain(r.raw);
      expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

describe('Malformed numbers are reported, never guessed', () => {
  it('rejects three or more numbers rather than picking two (§6.3 error 3)', () => {
    const out = parse('USD/NGN 1392 1394 1396');
    expect(out.rows).toHaveLength(0);
    expect(out.rejected[0]!.code).toBe('too_many_numbers');
  });

  it('rejects a rate with two decimal points rather than truncating it', () => {
    // "13.9.2" reads as two numbers, so the line carries three in total and is
    // reported. What matters is that it never silently becomes 13.9.
    const out = parse('USD/NGN 13.9.2 | 1394');
    expect(out.rows).toHaveLength(0);
    expect(out.rejected[0]!.code).toBe('too_many_numbers');
  });

  it('rejects scientific notation rather than guessing a magnitude', () => {
    const out = parse('USD/NGN 1e5 | 1394');
    expect(out.rows).toHaveLength(0);
    expect(out.rejected).toHaveLength(1);
  });

  it('does not invent a rate from a bare currency line', () => {
    const out = parse('USD/NGN');
    expect(out.rows).toHaveLength(0);
  });

  it('rejects a negative rate instead of silently dropping the sign', () => {
    // Found by this suite. NUMBER matches digits only, so "-1392" previously
    // parsed as a BID OF 1392 -- the minus vanished and the partner's value
    // changed meaning, with the database's positive_rates check never seeing
    // it because the sign was already gone.
    const out = parse('USD/NGN -1392 | 1394');
    expect(out.rows).toHaveLength(0);
    expect(out.rejected[0]!.code).toBe('negative_rate');
    expect(out.rejected[0]!.message).toMatch(/cannot be negative/);
  });

  it('still treats a hyphen BETWEEN two rates as a separator', () => {
    // The observed variant from §6.5 must keep working: the fix distinguishes
    // a sign from a separator by what precedes the hyphen.
    const out = parse('usd/ghs 11.77-11.81');
    expect(out.rejected).toHaveLength(0);
    expect(out.rows[0]).toMatchObject({ bid: '11.77', ask: '11.81' });
  });

  it('rejects a zero rate in the parser, not at the database constraint', () => {
    // positive_rates would refuse it at submit_rates, but §16.1 says a failed
    // submission must not be where the partner discovers the problem.
    const out = parse('USD/NGN 0 | 1394');
    expect(out.rows).toHaveLength(0);
    expect(out.rejected[0]!.code).toBe('zero_rate');
    expect(out.rejected[0]!.message).toMatch(/not a rate/);
  });

  it('rejects a zero ask as well as a zero bid', () => {
    const out = parse('USD/NGN 1392 | 0');
    expect(out.rejected[0]!.code).toBe('zero_rate');
  });
});

describe('Precision is never lost in the parser (§12.7)', () => {
  it('carries a very long decimal through as a string, unrounded', () => {
    const long = '1392.12345678901234567890';
    const out = parse(`USD/NGN ${long} | 1394`);
    expect(out.rows[0]!.bid, 'the parser must not round or reformat').toBe(long);
  });

  it('carries a magnitude beyond Number.MAX_SAFE_INTEGER intact', () => {
    const huge = '9007199254740993';
    const out = parse(`USD/NGN ${huge} | ${huge}`);
    expect(out.rows[0]!.bid).toBe(huge);
    expect(String(Number(huge))).not.toBe(huge); // JS would have corrupted it
  });

  it('strips thousands separators without touching the value', () => {
    const out = parse('USD/NGN 1,392.5 | 1,394.5');
    expect(out.rows[0]!.bid).toBe('1392.5');
    expect(out.rows[0]!.ask).toBe('1394.5');
  });
});

describe('Transposition and fat-finger cases (§20.3)', () => {
  it('a transposed crossed rate is an error, never silently swapped', () => {
    // §6.3 error 1: "It is never swapped silently."
    const out = parse('USD/NGN 1394 | 1392');
    expect(out.rows).toHaveLength(0);
    expect(out.rejected[0]!.code).toBe('crossed');
    expect(out.rejected[0]!.message).toMatch(/Swap them or correct one/);
  });

  it('a wildly transposed magnitude still parses -- it is a WARNING, not an error', () => {
    // 13920 instead of 1392 is plausible input the parser cannot judge. §6.3
    // makes a large move a warning requiring acknowledgement, not a rejection,
    // because only the partner knows whether the market moved.
    const out = parse('USD/NGN 13920 | 13940');
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.bid).toBe('13920');
  });

  it('an inverted pair with transposed sides is still refused as crossed', () => {
    // 1/0.000719 < 1/0.000717, so writing them the wrong way round inverts.
    const out = parse('NGN/USD 0.000719 | 0.000717');
    expect(out.rows).toHaveLength(0);
    expect(out.rejected[0]!.code).toBe('crossed');
  });
});

describe('Hostile input', () => {
  it('treats SQL-looking text as text, not as anything else', () => {
    const out = parse("USD/NGN 1392 | 1394'; drop table public.rates; --");
    // Either rejected for too many tokens, or parsed with the numbers only.
    // What matters is that the string is returned verbatim for display and
    // never interpreted. §18.5 TM15: parameterised queries only, everywhere.
    const reported = [...out.rejected.map((r) => r.raw), ...out.rows.map((r) => r.raw)];
    expect(reported.some((r) => r.includes('drop table'))).toBe(true);
  });

  it('does not execute or strip markup in a rejected line', () => {
    const nasty = 'USD/NGN <script>alert(1)</script> 1392 | 1394';
    const out = parse(nasty);
    const all = [...out.rejected.map((r) => r.raw), ...out.rows.map((r) => r.raw), ...out.ignored.map((i) => i.raw)];
    // Returned intact for React to escape at render time -- not sanitised
    // here, because a parser that quietly rewrites input hides what was sent.
    expect(all.some((r) => r.includes('<script>'))).toBe(true);
  });

  it('handles a very long single line without hanging (ReDoS)', () => {
    // The pair pattern has two adjacent {3,6} character classes with an
    // optional separator, which is the shape that backtracks badly. Measured
    // rather than assumed.
    const line = 'USD/NGN ' + '1'.repeat(5000) + ' | ' + '2'.repeat(5000);
    const started = Date.now();
    const out = parse(line);
    const elapsed = Date.now() - started;
    expect(elapsed, `parser took ${elapsed}ms on a 10k-character line`).toBeLessThan(1000);
    expect(out.rows.length + out.rejected.length).toBeGreaterThan(0);
  });

  it('handles pathological near-matches without hanging', () => {
    const cases = [
      'A'.repeat(2000),
      'AB'.repeat(1500),
      'USDNGNUSDNGN'.repeat(400),
      '1,'.repeat(3000),
      'USD/'.repeat(2000) + 'NGN 1392 | 1394',
    ];
    for (const c of cases) {
      const started = Date.now();
      expect(() => parse(c)).not.toThrow();
      const elapsed = Date.now() - started;
      expect(elapsed, `pathological input took ${elapsed}ms`).toBeLessThan(1000);
    }
  });

  it('handles a very large block of lines in reasonable time', () => {
    const block = Array.from({ length: 2000 }, (_, i) =>
      i % 3 === 0 ? 'USD/NGN 1392 | 1394' : i % 3 === 1 ? 'hello there' : 'USD/XYZ 1 | 2',
    ).join('\n');
    const started = Date.now();
    const out = parse(block);
    const elapsed = Date.now() - started;
    expect(elapsed, `2000 lines took ${elapsed}ms`).toBeLessThan(3000);
    expect(out.rows.length + out.rejected.length + out.ignored.length).toBe(2000);
  });
});

describe('Currency-code edge cases', () => {
  it('does not confuse a 6-letter glued pair with a 6-letter currency', () => {
    const out = parse('USDNGN 1392 | 1394');
    expect(out.rows[0]).toMatchObject({ baseCcy: 'USD', quoteCcy: 'NGN' });
  });

  it('rejects an unknown currency rather than guessing a near match', () => {
    // USE is not USD. A parser that "helpfully" corrects this prices the wrong
    // currency.
    const out = parse('USE/NGN 1392 | 1394');
    expect(out.rows).toHaveLength(0);
    expect(out.rejected[0]!.code).toBe('unknown_currency');
    expect(out.rejected[0]!.message).toContain('USE');
  });

  it('rejects a pair absent from the registry in BOTH orientations', () => {
    const out = parse('GHS/KES 1 | 2');
    expect(out.rows).toHaveLength(0);
    expect(out.rejected[0]!.code).toBe('unknown_pair');
  });

  it('is case-insensitive on currency codes but canonical on output', () => {
    const out = parse('uSd/nGn 1392 | 1394');
    expect(out.rows[0]).toMatchObject({ baseCcy: 'USD', quoteCcy: 'NGN' });
  });
});

describe('The parser writes nothing (§6.5)', () => {
  it('returns identical results for identical input, with no shared state', () => {
    const text = 'USD/NGN 1392 | 1394\nUSD/NGN 1394 | 1392';
    const a = parse(text);
    const b = parse(text);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not mutate the registry it was given', () => {
    const snapshot = {
      currencies: [...REGISTRY.currencies].sort(),
      pairs: [...REGISTRY.pairs.keys()].sort(),
    };
    parse('USD/XYZ 1 | 2\nNGN/USD 0.0007 | 0.0008');
    expect([...REGISTRY.currencies].sort()).toEqual(snapshot.currencies);
    expect([...REGISTRY.pairs.keys()].sort()).toEqual(snapshot.pairs);
  });
});
