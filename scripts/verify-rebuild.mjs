#!/usr/bin/env node
/**
 * Can this database be rebuilt from `supabase/migrations/` alone?
 *
 * §18.1 says the migration files ARE the schema. §18.3 says a backup that has
 * never been restored is a belief, not a control — and a migration set that has
 * never been applied from scratch is exactly the same belief. Every migration
 * here was applied INCREMENTALLY to one long-lived database; the from-scratch
 * path had never once been exercised.
 *
 * This creates a scratch database, applies every migration in order, compares
 * the result against the live schema, and drops the scratch. It is the
 * mechanical half of §18.3's rehearsal: it proves the schema can be recreated,
 * which is the part a human timing a restore should not have to discover.
 *
 * Usage:  node scripts/verify-rebuild.mjs [--keep]
 */
import { config as loadEnv } from 'dotenv';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

loadEnv({ path: '.env.local' });
loadEnv();

const KEEP = process.argv.includes('--keep');
const SCRATCH = 'ratehub_rebuild_check';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'supabase', 'migrations');

const url = new URL(process.env.DATABASE_URL);
const scratchUrl = new URL(process.env.DATABASE_URL);
scratchUrl.pathname = `/${SCRATCH}`;

const connect = async (connectionString) => {
  const c = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
};

/** A fingerprint of the schema: what exists, not what is in it. */
const FINGERPRINT = {
  tables: `select table_name from information_schema.tables
            where table_schema='public' and table_type='BASE TABLE'
              and table_name not like '\\_%' order by 1`,
  columns: `select table_name||'.'||column_name||':'||data_type as c
              from information_schema.columns
             where table_schema='public' and table_name not like '\\_%' order by 1`,
  constraints: `select conrelid::regclass::text||'.'||conname as c
                  from pg_constraint con
                  join pg_namespace n on n.oid = con.connamespace
                 where n.nspname='public' order by 1`,
  indexes: `select indexname from pg_indexes where schemaname='public' order by 1`,
  policies: `select tablename||'.'||policyname||':'||cmd as p
               from pg_policies where schemaname='public' order by 1`,
  functions: `select n.nspname||'.'||p.proname as f
                from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname in ('public','app') and p.proname not like '\\_%' order by 1`,
  views: `select table_name from information_schema.views
           where table_schema='public' order by 1`,
};

async function fingerprint(client) {
  const out = {};
  for (const [name, sql] of Object.entries(FINGERPRINT)) {
    const res = await client.query(sql);
    out[name] = res.rows.map((r) => Object.values(r)[0]);
  }
  return out;
}

/**
 * Dropping the scratch database is the step that actually failed the first
 * time this ran, and the reason is worth writing down: this connects through
 * Supabase's POOLER. `client.end()` returns the connection to the pool rather
 * than closing the server-side session, so for a short window after we
 * disconnect Postgres still sees a session on the scratch database and
 * refuses `drop database` with 55006.
 *
 * `with (force)` terminates those sessions itself (PG13+), and the retry
 * covers a fresh one opening in between. Left unhandled, this abandons a
 * stray database on a REAL project every run -- exactly the kind of debris a
 * verification script must never create.
 */
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

const admin = await connect(process.env.DATABASE_URL);

console.log(`Dropping any previous scratch database...`);
await dropScratch(admin);
console.log(`Creating ${SCRATCH}...`);
await admin.query(`create database ${SCRATCH}`);

let scratch;
let failed = null;
try {
  scratch = await connect(scratchUrl.toString());

  // Supabase provisions these before any migration runs. A restore into a
  // fresh Supabase project gets them for free; a bare Postgres does not, and
  // the migrations do not declare the dependency. Stubbed here so the test
  // measures OUR migrations rather than the platform's bootstrap -- and
  // recorded in docs/spec-findings.md as an undeclared prerequisite.
  console.log('Stubbing the Supabase-provided prerequisites...');
  await scratch.query(`create schema if not exists extensions`);
  await scratch.query(`create schema if not exists auth`);
  await scratch.query(`
    create table if not exists auth.users (
      id uuid primary key,
      email text
    )`);
  await scratch.query(`
    create or replace function auth.uid() returns uuid
    language sql stable as $$ select null::uuid $$`);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  console.log(`\nApplying ${files.length} migrations from scratch:\n`);

  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    process.stdout.write(`  ${file} ... `);
    try {
      await scratch.query('begin');
      await scratch.query(sql);
      await scratch.query('commit');
      console.log('ok');
    } catch (err) {
      await scratch.query('rollback').catch(() => {});
      console.log('FAILED');
      console.error(`\n    ${err.message}\n`);
      failed = { file, message: err.message };
      break;
    }
  }

  if (!failed) {
    console.log('\nComparing the rebuilt schema against the live one...\n');
    const live = await fingerprint(admin);
    const built = await fingerprint(scratch);

    let differences = 0;
    for (const key of Object.keys(FINGERPRINT)) {
      const onlyLive = live[key].filter((x) => !built[key].includes(x));
      const onlyBuilt = built[key].filter((x) => !live[key].includes(x));
      if (onlyLive.length || onlyBuilt.length) {
        differences += onlyLive.length + onlyBuilt.length;
        console.log(`  ${key}:`);
        for (const x of onlyLive) console.log(`    only in LIVE  : ${x}`);
        for (const x of onlyBuilt) console.log(`    only in BUILT : ${x}`);
      } else {
        console.log(`  ${key.padEnd(12)} ${live[key].length} objects, identical`);
      }
    }
    failed = differences > 0 ? { file: '(comparison)', message: `${differences} difference(s)` } : null;
  }
} finally {
  if (scratch) await scratch.end();
  if (!KEEP) {
    await dropScratch(admin);
    console.log(`\nScratch database dropped.`);
  } else {
    console.log(`\nScratch database kept as ${SCRATCH} (--keep).`);
  }
  await admin.end();
}

if (failed) {
  console.error(
    `\nFAIL: the schema cannot be rebuilt from migrations alone.\n` +
      `  ${failed.file}: ${failed.message}\n\n` +
      `§18.1 makes the migration files the source of truth. If they do not\n` +
      `reproduce the schema, a restore into a fresh project produces something\n` +
      `other than production -- which is the failure §18.3 exists to catch.\n`,
  );
  process.exit(1);
}

console.log(
  `\nPASS - every migration applies from scratch, and the rebuilt schema is\n` +
    `identical to the live one. §18.3's mechanical half is verified.\n`,
);
