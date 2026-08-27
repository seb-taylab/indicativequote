#!/usr/bin/env node
/**
 * §18.2: "Application logs MUST NOT contain rate values, partner rate data, or
 * `raw_input`. Error trackers are configured with the same exclusion."
 *
 * This rule held only by accident: there were no `console.*` calls in the
 * application at all when it was written. That is not a control, it is a
 * coincidence, and the first person to debug a submission problem by logging
 * the parsed rows would end it -- probably at 17:00 on a day when a partner is
 * complaining, which is exactly when nobody is thinking about D1.
 *
 * What is actually at stake: §D1 makes the board internal-only, TM1 is a
 * partner reading a competitor's rates, and §18.4 retains `raw_input` for 90
 * days precisely because it is a partner's own pasted text, which "may carry
 * greetings, names or unrelated content". A log line is none of those things --
 * it has no RLS, no retention, and no deletion path. Rate data in a log is
 * outside every control this system has.
 *
 * The rule: a `console.*` call may not mention anything that carries rate data
 * or partner text. Deliberate exceptions are annotated on the line.
 *
 * Usage:  node scripts/assert-no-rate-logging.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOTS = ['app', 'src', 'components', 'lib'];
const CODE = /\.(ts|tsx|js|jsx|mjs)$/;

/**
 * Names that carry rate values or partner text. Drawn from the actual schema
 * and domain types rather than invented: partner_bid/partner_ask are columns,
 * raw_input is the retained paste, and the client_* pair is the marked-up
 * board side.
 */
const FORBIDDEN = [
  /\braw_?input\b/i,
  /\bpartner_?(bid|ask)\b/i,
  /\bclient_?(bid|ask)\b/i,
  /\b(bid|ask|mid)\b/i,
  /\bmarkup\b/i,
  /\bspread\b/i,
  /\bpasted?\b/i,
  // Whole rows and payloads: logging the object logs everything in it.
  /\b(rate|rates|rateRow|rateRows|parsed|rows|submission|payload|quote)\b/i,
];

/** `// log-safe: <reason>` on the line is a deliberate, reviewed exception. */
const EXEMPT = /\/\/\s*log-safe:/;

function findConsoleCalls(text) {
  const out = [];
  const re = /console\s*\.\s*(log|error|warn|info|debug|trace|dir|table)\s*\(/g;
  for (const m of re.exec.length ? text.matchAll(re) : []) {
    // Walk to the matching close paren so multi-line calls are captured whole.
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    const call = text.slice(m.index, i);
    const line = text.slice(0, m.index).split('\n').length;
    // The whole physical line, so an end-of-line exemption comment is seen.
    const lineText = text.split('\n')[line - 1] ?? '';
    out.push({ call, line, lineText });
  }
  return out;
}

function offendingTerm(call) {
  // The arguments only -- `console.log` itself must not match.
  const args = call.slice(call.indexOf('(') + 1);
  // String literals are the usual way a value gets in ("bid: " + row.bid),
  // so they are scanned too rather than trusted as static text.
  for (const re of FORBIDDEN) {
    const m = re.exec(args);
    if (m) return m[0];
  }
  return null;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next') continue;
      yield* walk(p);
    } else if (CODE.test(e.name)) {
      yield p;
    }
  }
}

const violations = [];
let scanned = 0;
let consoleCalls = 0;

for (const root of ROOTS) {
  for await (const file of walk(root)) {
    scanned += 1;
    const text = await readFile(file, 'utf8');
    if (!text.includes('console')) continue;
    for (const c of findConsoleCalls(text)) {
      consoleCalls += 1;
      if (EXEMPT.test(c.lineText)) continue;
      const term = offendingTerm(c.call);
      if (term) {
        violations.push({
          at: `${file.replace(/\\/g, '/')}:${c.line}`,
          term,
          code: c.call.replace(/\s+/g, ' ').slice(0, 120),
        });
      }
    }
  }
}

// The rule is checked against known violations, because a rule that scans a
// codebase containing nothing to find will pass whether or not it works. This
// is the same self-test the decimal rule carries, and for the same reason:
// N7 and F24 were both assertions that passed regardless of the code.
const PROBE = [
  `console.log('parsed rows', parsed);`,
  `console.error('submit failed', { raw_input: text });`,
  `console.warn("bid " + row.partner_bid);`,
  `console.log(\`markup \${version.bps}\`);`,
];
const NEGATIVE_PROBE = [
  `console.log('health page rendered');`,
  `console.error('auth callback failed', error.code);`,
];

const probeHits = PROBE.filter((p) => offendingTerm(p) !== null);
const falsePositives = NEGATIVE_PROBE.filter((p) => offendingTerm(p) !== null);

if (probeHits.length !== PROBE.length) {
  console.error(
    `\nFAIL: the rule itself is broken - it caught ${probeHits.length}/${PROBE.length} known violations.`,
  );
  for (const p of PROBE.filter((x) => !probeHits.includes(x))) console.error(`  missed: ${p}`);
  process.exit(1);
}

if (falsePositives.length > 0) {
  console.error(`\nFAIL: the rule flags benign logging, which would train people to bypass it:`);
  for (const p of falsePositives) console.error(`  ${p}`);
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`\nFAIL: ${violations.length} log statement(s) may carry rate data (§18.2):\n`);
  for (const v of violations) {
    console.error(`  ${v.at}   <-  ${v.term}`);
    console.error(`      ${v.code}\n`);
  }
  console.error(
    'A log line has no RLS, no retention and no deletion path, so rate data in a\n' +
      'log is outside every control this system has (D1, TM1, §18.4). Log an\n' +
      'identifier instead of a value. If the line is genuinely safe, annotate it\n' +
      '`// log-safe: <reason>`.\n',
  );
  process.exit(1);
}

console.log(
  `ok - scanned ${scanned} source file(s), ${consoleCalls} console call(s); no rate data ` +
    `reaches a log (rule self-test: ${probeHits.length}/${PROBE.length} caught, ` +
    `${NEGATIVE_PROBE.length}/${NEGATIVE_PROBE.length} benign lines allowed).`,
);
