#!/usr/bin/env node
/**
 * §12.7 rule 4: "A lint rule fails the build on `Number(`, `parseFloat(` or
 * `+` applied to any value from a rate payload."
 *
 * D13 is only as strong as its weakest boundary. NUMERIC in the database, text
 * on the wire and decimal.js in the application all hold — and one `Number(row
 * .partner_bid)` anywhere undoes the lot, silently, with no float in the schema
 * and no visible difference in the rendered figure. That is what this catches.
 *
 * THE HARD PART IS NOT FINDING `Number(` — IT IS NOT CRYING WOLF.
 *
 * §12.7 governs DECIMALS: rates, amounts, spreads, markups, sizes. It does not
 * govern integers. `Number(fd.get('soft_ttl_minutes'))` is correct code: TTL
 * minutes are a whole number of minutes and `soft_ttl_minutes` is `integer` in
 * the schema. A rule that flags those gets an `eslint-disable` on day one and
 * then catches nothing ever again.
 *
 * So the rule is name-directed: it flags numeric coercion and arithmetic only
 * where the operand is decimal-bearing, and it requires an explicit, reasoned
 * opt-out rather than a blanket suppression.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['app', 'components', 'lib', 'src'];
const EXT = /\.(ts|tsx)$/;

/**
 * Identifiers that carry a DECIMAL across the wire. Drawn from the RPC
 * payloads (§13.3), v_current_rates (§11.8) and board_rates' row shape.
 */
const DECIMAL_TOKENS = [
  'bid', 'ask', 'rate', 'rates', 'spread', 'amount', 'markup', 'bps',
  'min_size', 'max_size', 'minSize', 'maxSize', 'size',
  'client_rate', 'clientRate', 'counter_amount', 'counterAmount',
  'partner_bid', 'partnerBid', 'partner_ask', 'partnerAsk',
  'default_bps', 'min_bps', 'max_bps', 'move_warn_pct', 'price',
];

/**
 * Integer fields that legitimately pass through Number(). Each is `integer` or
 * `smallint` in the schema, not `numeric` — listed explicitly so that adding a
 * decimal to this list is a visible, reviewable act rather than a silent one.
 */
const INTEGER_FIELDS = [
  'soft_ttl_minutes', 'hard_ttl_minutes', 'minor_units',
  'row_count', 'error_count', 'limit', 'offset', 'perPage', 'page',
];

const OPT_OUT = /\/\/\s*decimal-safe:/;

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (EXT.test(p)) out.push(p);
  }
  return out;
}

/**
 * Strip everything that is prose rather than code.
 *
 * The first version of this rule reported six violations, all false. Every one
 * was English: "Bid/ask convention" in a JSX heading reads as division, and
 * "* §16.3 /admin/markup" is a block-comment continuation line. That matters
 * more than it sounds — a rule that cries wolf is disabled within a week, and
 * then §12.7's fourth guarantee is gone while still appearing to be enforced.
 */
function stripNoise(line) {
  // Block-comment continuation lines: "   * some prose"
  if (/^\s*\*/.test(line)) return '';
  return line
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '')
    // JSX text nodes: >Bid/ask convention<
    .replace(/>[^<>{}]*</g, '><')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * Does this line look like executable code at all? JSX prose spanning several
 * lines cannot be stripped by a line-based pass, so arithmetic is only
 * considered where the line carries some syntax.
 */
function looksLikeCode(line) {
  return /[=;(){}[\]]|return|const|let|var/.test(line);
}

const decimalish = (text) => {
  const lowered = text.toLowerCase();
  if (INTEGER_FIELDS.some((f) => lowered.includes(f.toLowerCase()))) return false;
  return DECIMAL_TOKENS.some((t) => new RegExp(`\\b${t}\\b`, 'i').test(text));
};

const violations = [];
let scanned = 0;

for (const root of ROOTS) {
  for (const file of walk(root)) {
    scanned += 1;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);

    lines.forEach((raw, i) => {
      if (OPT_OUT.test(raw)) return;
      const line = stripNoise(raw);
      const at = `${file}:${i + 1}`;

      // 1. Numeric coercion of a decimal-bearing expression.
      for (const m of line.matchAll(/\b(Number|parseFloat|parseInt)\s*\(([^)]*)\)/g)) {
        if (decimalish(m[2])) {
          violations.push({ at, why: `${m[1]}() applied to a decimal`, code: raw.trim() });
        }
      }

      // 2. Unary + coercion: +row.partner_bid
      for (const m of line.matchAll(/(?<![\w)\]])\+\s*([A-Za-z_$][\w.$]*)/g)) {
        if (decimalish(m[1])) {
          violations.push({ at, why: `unary + coerces a decimal`, code: raw.trim() });
        }
      }

      // 3. Arithmetic between operands where either side is decimal-bearing.
      if (!looksLikeCode(line)) return;
      for (const m of line.matchAll(
        /([A-Za-z_$][\w.$]*)\s*([*/%-]|\+(?!\+))\s*([A-Za-z_$][\w.$]*)/g,
      )) {
        const [, left, op, right] = m;
        if (decimalish(left) || decimalish(right)) {
          violations.push({
            at,
            why: `arithmetic (${op}) on a decimal primitive`,
            code: raw.trim(),
          });
        }
      }
    });
  }
}

// Self-test: a rule that cannot fail is not a rule. Prove it catches the exact
// shape §12.7 describes before trusting a clean report.
const PROBE = [
  'const x = Number(row.partner_bid);',
  'const y = parseFloat(rate.client_rate);',
  'const z = +row.partner_ask;',
  'const w = amount * clientRate;',
];
const probeHits = PROBE.filter((line) => {
  const l = stripNoise(line);
  return (
    [...l.matchAll(/\b(Number|parseFloat|parseInt)\s*\(([^)]*)\)/g)].some((m) => decimalish(m[2])) ||
    [...l.matchAll(/(?<![\w)\]])\+\s*([A-Za-z_$][\w.$]*)/g)].some((m) => decimalish(m[1])) ||
    [...l.matchAll(/([A-Za-z_$][\w.$]*)\s*([*/%-]|\+(?!\+))\s*([A-Za-z_$][\w.$]*)/g)].some(
      (m) => decimalish(m[1]) || decimalish(m[3]),
    )
  );
});

if (probeHits.length !== PROBE.length) {
  console.error(
    `\nFAIL: the rule itself is broken — it caught ${probeHits.length}/${PROBE.length} known violations.`,
  );
  for (const p of PROBE.filter((x) => !probeHits.includes(x))) console.error(`  missed: ${p}`);
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`\nFAIL: ${violations.length} decimal(s) entering JavaScript arithmetic (§12.7):\n`);
  for (const v of violations) {
    console.error(`  ${v.at}`);
    console.error(`      ${v.why}`);
    console.error(`      ${v.code}\n`);
  }
  console.error(
    'Decimals cross every boundary as strings (D13). Use decimal.js, or keep the\n' +
      'value a string. If a value is genuinely an integer, add it to INTEGER_FIELDS\n' +
      'in this script, or annotate the line `// decimal-safe: <reason>`.\n',
  );
  process.exit(1);
}

console.log(
  `ok - scanned ${scanned} source file(s); no decimal reaches JavaScript arithmetic ` +
    `(rule self-test: ${probeHits.length}/${PROBE.length} known violations caught).`,
);
