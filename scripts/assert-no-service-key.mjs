#!/usr/bin/env node
/**
 * §12.3 / TM1: "The service-role key is used only in server-side routes and
 * MUST NOT appear in any browser bundle. Enforce with a build-time check that
 * fails the build."
 *
 * Run after the client bundle is produced. Scans build output for the key
 * value itself and for the env var name, since a bundler that inlines
 * process.env would embed the literal.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import 'dotenv/config';

const BUNDLE_DIRS = ['.next/static', 'dist', 'build'];
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const needles = ['SUPABASE_SERVICE_ROLE_KEY', 'service_role'];
if (key && key.length > 20) needles.push(key);

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const offenders = [];
let scanned = 0;

for (const dir of BUNDLE_DIRS) {
  for await (const file of walk(dir)) {
    if (!/\.(js|mjs|cjs|css|map|html|json)$/.test(file)) continue;
    scanned += 1;
    const content = await readFile(file, 'utf8');
    for (const needle of needles) {
      if (content.includes(needle)) {
        offenders.push(`${file}  <-  ${needle === key ? 'the service-role key itself' : needle}`);
      }
    }
  }
}

if (scanned === 0) {
  console.error('No build output found. Build the client before running this check.');
  process.exit(1);
}

if (offenders.length > 0) {
  console.error('\nFAIL: service-role material found in the client bundle (§12.3):\n');
  for (const o of offenders) console.error(`  ${o}`);
  console.error('');
  process.exit(1);
}

console.log(`ok - scanned ${scanned} bundle file(s), no service-role material present.`);
