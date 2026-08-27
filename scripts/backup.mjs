#!/usr/bin/env node
/**
 * Logical data backup, and the rehearsal of restoring one.
 *
 * WHAT THIS IS FOR. docs/restore-runbook.md §3.2 says: restore the SCHEMA from
 * `supabase/migrations/` and the DATA from a dump, because a dump taken with
 * `--no-acl` restores tables without the revocations TM1 rests on.
 * `scripts/verify-rebuild.mjs` proves the schema half. This proves the data
 * half: it dumps every row, rebuilds a scratch database from migrations alone,
 * loads the dump into it, and compares the result against live.
 *
 * WHAT THIS IS NOT. It is not a replacement for `pg_dump`. The nightly
 * production backup §18.3 requires should be `pg_dump`, which handles large
 * objects, extensions, sequences and ownership properly. This exists because
 * "the data half of a restore has never been tried" was a belief, and §18.3 is
 * explicit that a backup nobody has restored is not a control.
 *
 * THE DECIMAL TRAP, which is the reason this is not thirty lines of to_jsonb.
 * §12.7/TM16 route every decimal across every boundary as TEXT. `to_jsonb(t)`
 * renders a NUMERIC as a JSON *number*, and `JSON.parse` turns that into a
 * double. A backup written that way looks perfect and silently rounds every
 * rate in the system -- the exact failure D13 exists to prevent, in the one
 * artefact you reach for when everything else is already wrong. Every column
 * here is cast to text on the way out and passed back as a text parameter on
 * the way in, so Postgres does the only conversion that happens.
 *
 * WHERE DUMPS MUST NOT GO. This file contains the complete rate book. Never
 * store it as a GitHub Actions artifact: on a public repository, artifacts are
 * downloadable by anyone. Never commit it -- the script refuses to write inside
 * the working tree for that reason. §18.3 says "stored outside the Supabase
 * project", which means private object storage with its own credentials.
 *
 * Usage:
 *   node scripts/backup.mjs --out <path>     dump only
 *   node scripts/backup.mjs --verify         dump to a temp file, restore into
 *                                            a scratch database, compare
 */
import { config as loadEnv } from 'dotenv';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

loadEnv({ path: '.env.local' });
loadEnv();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const migrationsDir = join(repoRoot, 'supabase', 'migrations');

const VERIFY = process.argv.includes('--verify');
const outFlag = process.argv.indexOf('--out');
const SCRATCH = 'ratehub_restore_check';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.');
  process.exit(1);
}

const connect = async (connectionString) => {
  const c = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
};

/** Every base table in `public`, and its columns in ordinal order. */
async function inventory(client) {
  const { rows: tables } = await client.query(`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name`);
  const out = [];
  for (const { table_name } of tables) {
    const { rows: cols } = await client.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = $1
        order by ordinal_position`,
      [table_name],
    );
    out.push({ table: table_name, columns: cols.map((c) => c.column_name) });
  }
  return out;
}

/**
 * An order-independent fingerprint of a table's contents: hash each row, sort
 * the hashes, hash the result. Row ORDER is not a property of a table, so a
 * comparison that depended on it would report differences that are not
 * differences -- and would hide real ones behind a reordering.
 */
async function tableChecksum(client, table) {
  const { rows } = await client.query(
    `select coalesce(md5(string_agg(h, '' order by h)), 'empty') as sum,
            count(*)::int as n
       from (select md5(t::text) as h from public.${table} t) s`,
  );
  return { sum: rows[0].sum, n: rows[0].n };
}

/** Every column cast to text. See THE DECIMAL TRAP above. */
function selectAsText(table, columns) {
  const list = columns.map((c) => `"${c}"::text as "${c}"`).join(', ');
  return `select ${list} from public.${table}`;
}

async function dump(client, outPath) {
  const tables = await inventory(client);
  const stream = createWriteStream(outPath, { encoding: 'utf8' });
  const write = (s) => new Promise((r) => (stream.write(s) ? r() : stream.once('drain', r)));

  await write(
    `${JSON.stringify({
      format: 'ratehub-jsonl-v1',
      note:
        'One JSON object per line. Every value is a STRING or null -- the text ' +
        'representation Postgres itself produced. Never parse these as numbers: ' +
        'see §12.7 and the header of scripts/backup.mjs.',
      tables: tables.map((t) => t.table),
    })}\n`,
  );

  let total = 0;
  for (const { table, columns } of tables) {
    const { rows } = await client.query(selectAsText(table, columns));
    await write(`${JSON.stringify({ table, columns, rows: rows.length })}\n`);
    for (const row of rows) {
      await write(`${JSON.stringify(columns.map((c) => row[c]))}\n`);
    }
    total += rows.length;
    console.log(`  ${table.padEnd(24)} ${String(rows.length).padStart(6)} row(s)`);
  }

  await new Promise((r) => stream.end(r));
  return { tables: tables.length, rows: total };
}

/** Reads the dump back, inserting every value as a TEXT parameter. */
async function load(client, dumpPath) {
  const lines = (await readFile(dumpPath, 'utf8')).split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  if (header.format !== 'ratehub-jsonl-v1') throw new Error(`Unknown dump format.`);

  // Foreign keys reference rows that may not be loaded yet, and the composite
  // tenant keys of D11 make a topological order fragile. Deferring triggers is
  // the same thing pg_restore --disable-triggers does, and the constraints are
  // all re-checked by the comparison that follows.
  await client.query(`set session_replication_role = replica`);

  let current = null;
  let loaded = 0;
  for (const line of lines.slice(1)) {
    const parsed = JSON.parse(line);
    if (!Array.isArray(parsed)) {
      current = parsed;
      continue;
    }
    const cols = current.columns.map((c) => `"${c}"`).join(', ');
    const params = current.columns.map((_, i) => `$${i + 1}`).join(', ');
    await client.query(`insert into public.${current.table} (${cols}) values (${params})`, parsed);
    loaded += 1;
  }
  await client.query(`set session_replication_role = origin`);
  return loaded;
}

async function dropScratch(admin) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = $1 and pid <> pg_backend_pid()`,
        [SCRATCH],
      );
      await admin.query(`drop database if exists ${SCRATCH} with (force)`);
      return;
    } catch (err) {
      if (err.code !== '55006' || attempt === 5) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

const live = await connect(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Dump
// ---------------------------------------------------------------------------
let dumpPath;
if (outFlag !== -1) {
  dumpPath = resolve(process.argv[outFlag + 1] ?? '');
  if (dumpPath.startsWith(repoRoot)) {
    console.error(
      `\nRefusing to write a dump inside the working tree:\n  ${dumpPath}\n\n` +
        `This file contains the complete rate book. Inside the repository it is one\n` +
        `\`git add -A\` away from a public commit. §18.3 wants it "stored outside the\n` +
        `Supabase project" -- private object storage with its own credentials, never\n` +
        `a GitHub Actions artifact, which on a public repository anyone can download.\n`,
    );
    await live.end();
    process.exit(1);
  }
} else {
  dumpPath = join(await mkdtemp(join(tmpdir(), 'ratehub-backup-')), 'data.jsonl');
}

console.log(`Dumping public schema data...\n`);
const stats = await dump(live, dumpPath);
console.log(`\n${stats.rows} row(s) across ${stats.tables} table(s) -> ${dumpPath}`);

if (!VERIFY) {
  console.log(
    `\nDump only. Run with --verify to prove it restores.\n` +
      `A backup that has never been restored is a belief, not a control (§18.3).\n`,
  );
  await live.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Restore into a scratch database and compare
// ---------------------------------------------------------------------------
const scratchUrl = new URL(process.env.DATABASE_URL);
scratchUrl.pathname = `/${SCRATCH}`;

let scratch;
let failed = null;
try {
  await dropScratch(live);
  await live.query(`create database ${SCRATCH}`);
  scratch = await connect(scratchUrl.toString());

  // Provisioned by Supabase before any migration runs; see verify-rebuild.mjs.
  await scratch.query(`create schema if not exists extensions`);
  await scratch.query(`create schema if not exists auth`);
  await scratch.query(`create table if not exists auth.users (id uuid primary key, email text)`);
  await scratch.query(
    `create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$`,
  );

  console.log(`\nRebuilding the schema from migrations...`);
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await scratch.query(await readFile(join(migrationsDir, file), 'utf8'));
  }
  console.log(`  ${files.length} migration(s) applied.`);

  console.log(`\nLoading the dump...`);
  const loaded = await load(scratch, dumpPath);
  console.log(`  ${loaded} row(s) loaded.`);

  console.log(`\nComparing restored data against live:\n`);
  const tables = await inventory(live);
  let differences = 0;
  for (const { table } of tables) {
    const a = await tableChecksum(live, table);
    const b = await tableChecksum(scratch, table);
    const ok = a.sum === b.sum && a.n === b.n;
    if (!ok) differences += 1;
    console.log(
      `  ${ok ? 'ok  ' : 'DIFF'}  ${table.padEnd(24)} ` +
        `live ${String(a.n).padStart(5)} row(s)   restored ${String(b.n).padStart(5)} row(s)` +
        (ok ? '' : `\n         live ${a.sum}\n         rest ${b.sum}`),
    );
  }

  // The decimal contract, checked on the artefact rather than assumed. If a
  // NUMERIC had gone through a JavaScript number anywhere in this round trip,
  // trailing zeroes and long fractions are where it would show.
  const { rows: sample } = await scratch.query(
    `select partner_bid::text as b, partner_ask::text as a from public.rates order by id limit 5`,
  );
  const { rows: original } = await live.query(
    `select partner_bid::text as b, partner_ask::text as a from public.rates order by id limit 5`,
  );
  const decimalsIntact = JSON.stringify(sample) === JSON.stringify(original);
  console.log(
    `\n  ${decimalsIntact ? 'ok  ' : 'DIFF'}  decimals survive the round trip byte-for-byte ` +
      `(${original.length} rate(s) compared)`,
  );
  if (!decimalsIntact) differences += 1;

  failed = differences > 0 ? `${differences} table(s) differ` : null;
} finally {
  if (scratch) await scratch.end();
  await dropScratch(live);
  console.log(`\nScratch database dropped.`);
  await live.end();
}

if (failed) {
  console.error(`\nFAIL: the dump does not restore faithfully -- ${failed}.\n`);
  process.exit(1);
}

console.log(
  `\nPASS - every row round-tripped through a dump, a schema rebuilt from\n` +
    `migrations, and a reload, with decimals byte-identical. §18.3's data half\n` +
    `is rehearsed.\n`,
);
