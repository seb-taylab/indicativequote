#!/usr/bin/env node
/**
 * Migration runner.
 *
 * §18.1: migrations are files in version control, applied in order, never
 * hand-edited in a dashboard. A schema change that reaches production without
 * a migration file is an incident, not a shortcut.
 *
 * Applied files are recorded in app.schema_migrations so a re-run is a no-op.
 */
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'supabase', 'migrations');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

await client.query(`create schema if not exists app`);
await client.query(`
  create table if not exists app.schema_migrations (
    name        text primary key,
    applied_at  timestamptz not null default now()
  )
`);

const applied = new Set(
  (await client.query('select name from app.schema_migrations')).rows.map((r) => r.name),
);

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

let count = 0;
for (const file of files) {
  if (applied.has(file)) {
    console.log(`  skip  ${file}`);
    continue;
  }
  const sql = await readFile(join(migrationsDir, file), 'utf8');
  process.stdout.write(`  apply ${file} ... `);
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('insert into app.schema_migrations (name) values ($1)', [file]);
    await client.query('commit');
    console.log('ok');
    count += 1;
  } catch (err) {
    await client.query('rollback');
    console.log('FAILED');
    console.error(`\n${file}:\n${err.message}\n`);
    await client.end();
    process.exit(1);
  }
}

console.log(`\n${count} migration(s) applied, ${files.length - count} already present.`);
await client.end();
