/**
 * The rate-block parser. Spec §6.5, §6.3, §10.3.
 *
 *   BASE[/ -]?QUOTE  [:=]?  BID  [| / - whitespace]  ASK
 *
 * "The parser is a pure function. It writes nothing. It returns rows and
 *  diagnostics; the grid decides what is submitted."
 *
 * It is deliberately conservative. §6.3 error 3 — three or more numbers on a
 * line — is "reported, never guessed", and that principle runs through the
 * whole file: where the input is ambiguous the parser reports rather than
 * picking. A parser that guesses produces a rate board nobody can trust, and
 * §2 says trust is what decides whether this product works at all.
 *
 * D13/§12.7: numbers are captured and carried as STRINGS. Nothing here calls
 * Number() or parseFloat. Decimal is used only where a comparison is needed.
 */
import Decimal from 'decimal.js';
import { invertQuote, isCrossed } from './rates';

export type DiagnosticCode =
  | 'crossed'
  | 'too_many_numbers'
  | 'too_few_numbers'
  | 'unknown_currency'
  | 'unknown_pair'
  | 'unparseable'
  | 'normalised_from_inverse';

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
}

export interface ParsedRow {
  lineNumber: number;
  raw: string;
  /** Canonical orientation. */
  baseCcy: string;
  quoteCcy: string;
  currencyPairId: string;
  bid: string | null;
  ask: string | null;
  normalisedFromInverse: boolean;
  /** Present only when the line was sent inverted (§6.2 "Normalised"). */
  original?: { baseCcy: string; quoteCcy: string; bid: string | null; ask: string | null };
  warnings: Diagnostic[];
}

export interface RejectedLine {
  lineNumber: number;
  raw: string;
  code: DiagnosticCode;
  message: string;
}

export interface IgnoredLine {
  lineNumber: number;
  raw: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** §6.3 error 2: never dropped silently -- shown verbatim. */
  rejected: RejectedLine[];
  /** §6.5: greetings and signoffs, "ignored and reported as ignored". */
  ignored: IgnoredLine[];
}

export interface CanonicalPair {
  id: string;
  baseCcy: string;
  quoteCcy: string;
}

export interface Registry {
  currencies: Set<string>;
  /** Keyed "BASE/QUOTE" in the one approved orientation (D8). */
  pairs: Map<string, CanonicalPair>;
}

export function buildRegistry(
  currencies: string[],
  pairs: CanonicalPair[],
): Registry {
  return {
    currencies: new Set(currencies.map((c) => c.toUpperCase())),
    pairs: new Map(pairs.map((p) => [`${p.baseCcy.toUpperCase()}/${p.quoteCcy.toUpperCase()}`, p])),
  };
}

/**
 * A number: optional thousands separators, optional decimal part.
 *
 * Written as one alternative-free pattern on purpose. The obvious form,
 *   \d{1,3}(?:,\d{3})*(?:\.\d+)? | \d+(?:\.\d+)?
 * is wrong: the first alternative caps at three digits with no boundary, so
 * "1392" matches as "139" then "2" -- two numbers -- and every four-digit rate
 * is rejected as §6.3 error 3, "three or more numbers on a line". `\d+` first
 * consumes the whole integer part, and the optional group still accepts
 * "1,392".
 */
const NUMBER = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;
const NUMBER_RE = new RegExp(NUMBER, 'g');
/** Non-global twin. `.test()` on a /g regex advances lastIndex between calls. */
const NUMBER_TEST_RE = new RegExp(NUMBER);

/**
 * A leading pair token: two currency codes, with or without a separator.
 * Codes are 3 to 6 characters (matching `currencies.code`).
 */
const PAIR_RE = new RegExp(
  String.raw`^\s*([A-Za-z]{3,6})\s*[\/\-\s]?\s*([A-Za-z]{3,6})\s*[:=]?\s*(.*)$`,
);

/** A pair token with NO separator, e.g. USDNGN -- split 3+3. */
const GLUED_RE = /^\s*([A-Za-z]{6})\s*[:=]?\s*(.*)$/;

function stripThousands(n: string): string {
  return n.replace(/,/g, '');
}

/**
 * Lines that carry no rate at all. Reported as ignored rather than as errors,
 * so a partner pasting "Morning Seb, here are today's rates -- Thanks!" sees
 * their greeting acknowledged and not flagged as broken input.
 */
function looksLikeProse(line: string): boolean {
  return !NUMBER_TEST_RE.test(line) || !/[A-Za-z]{3}/.test(line);
}

export function parseRateBlock(text: string, registry: Registry): ParseResult {
  const rows: ParsedRow[] = [];
  const rejected: RejectedLine[] = [];
  const ignored: IgnoredLine[] = [];

  const lines = text.split(/\r?\n/);

  lines.forEach((raw, i) => {
    const lineNumber = i + 1;
    const line = raw.trim();
    if (line.length === 0) return;

    NUMBER_RE.lastIndex = 0;
    const numbers = line.match(NUMBER_RE) ?? [];

    if (numbers.length === 0) {
      ignored.push({ lineNumber, raw });
      return;
    }

    // Find the pair token.
    let baseRaw: string | null = null;
    let quoteRaw: string | null = null;
    let rest = '';

    const m = PAIR_RE.exec(line);
    const glued = GLUED_RE.exec(line);

    if (m && m[1] && m[2]) {
      baseRaw = m[1].toUpperCase();
      quoteRaw = m[2].toUpperCase();
      rest = m[3] ?? '';
    } else if (glued && glued[1]) {
      baseRaw = glued[1].slice(0, 3).toUpperCase();
      quoteRaw = glued[1].slice(3).toUpperCase();
      rest = glued[2] ?? '';
    }

    // A 6-letter glued token also matches PAIR_RE's first group greedily in
    // some inputs; if the split we chose is not in the registry but the glued
    // split is, prefer the glued one.
    if (baseRaw && quoteRaw && !registry.currencies.has(quoteRaw)) {
      const single = /^\s*([A-Za-z]{6})\b/.exec(line);
      if (single && single[1]) {
        const b = single[1].slice(0, 3).toUpperCase();
        const q = single[1].slice(3).toUpperCase();
        if (registry.currencies.has(b) && registry.currencies.has(q)) {
          baseRaw = b;
          quoteRaw = q;
          rest = line.slice(single[0].length).replace(/^\s*[:=]?\s*/, '');
        }
      }
    }

    if (!baseRaw || !quoteRaw) {
      if (looksLikeProse(line)) ignored.push({ lineNumber, raw });
      else rejected.push({ lineNumber, raw, code: 'unparseable', message: 'No currency pair recognised on this line.' });
      return;
    }

    // §6.3 error 5.
    for (const code of [baseRaw, quoteRaw]) {
      if (!registry.currencies.has(code)) {
        rejected.push({
          lineNumber, raw, code: 'unknown_currency',
          message: `${code} is not a currency in the registry.`,
        });
        return;
      }
    }

    NUMBER_RE.lastIndex = 0;
    const restNumbers = (rest.match(NUMBER_RE) ?? []).map(stripThousands);

    // §6.3 error 3: reported, never guessed.
    if (restNumbers.length > 2) {
      rejected.push({
        lineNumber, raw, code: 'too_many_numbers',
        message: `Found ${restNumbers.length} numbers on this line. Two are expected -- bid and ask.`,
      });
      return;
    }
    if (restNumbers.length === 0) {
      if (looksLikeProse(line)) ignored.push({ lineNumber, raw });
      else rejected.push({ lineNumber, raw, code: 'unparseable', message: 'No rate found on this line.' });
      return;
    }

    // §6.3 error 4. One number is only meaningful if the pair's quote_mode
    // permits a single side, which the parser cannot know -- so it reports one
    // number as a single side and lets the grid apply quote_mode.
    let bid: string | null = null;
    let ask: string | null = null;
    if (restNumbers.length === 2) {
      bid = restNumbers[0]!;
      ask = restNumbers[1]!;
    } else {
      bid = restNumbers[0]!;
      ask = null;
    }

    const warnings: Diagnostic[] = [];
    const canonicalKey = `${baseRaw}/${quoteRaw}`;
    const inverseKey = `${quoteRaw}/${baseRaw}`;

    let pair = registry.pairs.get(canonicalKey);
    let normalised = false;
    let original: ParsedRow['original'];

    if (!pair) {
      const inverse = registry.pairs.get(inverseKey);
      if (!inverse) {
        // §6.3 error 6.
        rejected.push({
          lineNumber, raw, code: 'unknown_pair',
          message: `${baseRaw}/${quoteRaw} is not in the canonical registry.`,
        });
        return;
      }

      // §10.3 -- normalise, and SWAP THE SIDES.
      original = { baseCcy: baseRaw, quoteCcy: quoteRaw, bid, ask };
      const flipped = invertQuote(bid, ask);
      bid = flipped.bid;
      ask = flipped.ask;
      pair = inverse;
      normalised = true;
      warnings.push({
        code: 'normalised_from_inverse',
        message:
          `Sent as ${original.baseCcy}/${original.quoteCcy} ` +
          `${original.bid ?? '-'} | ${original.ask ?? '-'}, ` +
          `stored as ${inverse.baseCcy}/${inverse.quoteCcy} ${bid ?? '-'} | ${ask ?? '-'}. ` +
          `Size is not carried across and must be restated.`,
      });
    }

    // §6.3 error 1 -- a crossed rate is an error, never a warning, and is
    // never swapped silently.
    if (isCrossed(bid, ask)) {
      rejected.push({
        lineNumber, raw, code: 'crossed',
        message: `Bid is higher than ask. Swap them or correct one.`,
      });
      return;
    }

    rows.push({
      lineNumber,
      raw,
      baseCcy: pair.baseCcy,
      quoteCcy: pair.quoteCcy,
      currencyPairId: pair.id,
      bid,
      ask,
      normalisedFromInverse: normalised,
      ...(original ? { original } : {}),
      warnings,
    });
  });

  return { rows, rejected, ignored };
}

/**
 * §6.3 warning 2 -- an implausible spread, wider than a configured percentage
 * of the ask. Kept out of the parser proper because it is a policy question,
 * not a parsing one.
 */
export function spreadWarning(
  bid: string | null,
  ask: string | null,
  maxPctOfAsk: string,
): Diagnostic | null {
  if (bid === null || ask === null) return null;
  const a = new Decimal(ask);
  if (a.isZero()) return null;
  const pct = a.minus(new Decimal(bid)).div(a).times(100);
  if (pct.greaterThan(new Decimal(maxPctOfAsk))) {
    return {
      code: 'crossed',
      message: `Spread is ${pct.toFixed(2)}% of the ask, wider than the ${maxPctOfAsk}% threshold. Confirm?`,
    };
  }
  return null;
}

/**
 * §6.3 warning 1 -- a large move since the partner's last update.
 */
export function moveWarning(
  previous: string | null,
  next: string | null,
  warnPct: string,
  currency: string,
): Diagnostic | null {
  if (previous === null || next === null) return null;
  const prev = new Decimal(previous);
  if (prev.isZero()) return null;
  const movePct = new Decimal(next).minus(prev).div(prev).times(100).abs();
  if (movePct.greaterThan(new Decimal(warnPct))) {
    return {
      code: 'crossed',
      message: `${currency} moved ${movePct.toFixed(2)}% since your last update. Confirm?`,
    };
  }
  return null;
}
