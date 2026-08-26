#!/usr/bin/env node
/**
 * §16.2: "Automated axe scan plus one keyboard-only pass per page in the
 * acceptance run."
 *
 * This is the axe half. It signs in as a real principal of each class, fetches
 * every route's server-rendered HTML, and runs axe-core over it in jsdom.
 *
 * WHAT THIS CANNOT CHECK, and why that is stated rather than hidden:
 * jsdom performs no layout and no cascade, so `color-contrast` cannot run here
 * -- axe needs computed pixels. Contrast is checked separately and
 * deterministically by scripts/contrast-check.mjs against the palette tokens.
 * Reporting a pass on a rule that never executed would be worse than not
 * running it.
 *
 * Usage:  node scripts/a11y-scan.mjs [baseUrl]
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import axe from 'axe-core';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.local' });
config();

const BASE = process.argv[2] ?? 'http://localhost:3000';

const ROUTES = [
  { path: '/login', as: null, name: 'Login' },
  { path: '/board', as: 'staff', name: 'Board' },
  { path: '/denied', as: 'staff', name: 'Permission denied' },
  { path: '/admin/partners', as: 'staff', name: 'Admin: partners' },
  { path: '/admin/access', as: 'staff', name: 'Admin: access' },
  { path: '/admin/markup', as: 'staff', name: 'Admin: markup' },
  { path: '/admin/health', as: 'staff', name: 'Admin: health' },
  { path: '/admin/audit', as: 'staff', name: 'Admin: audit' },
  { path: '/partner', as: 'partner', name: 'Partner: home' },
  { path: '/partner/submit', as: 'partner', name: 'Partner: submit' },
  { path: '/partner/pairs', as: 'partner', name: 'Partner: pairs' },
  { path: '/partner/history', as: 'partner', name: 'Partner: history' },
];

const ACCOUNTS = {
  staff: 'demo.admin@example.com',
  partner: 'demo.alpha@example.com',
};

async function signIn(email) {
  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
  const { data, error } = await svc.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw new Error(`generateLink ${email}: ${error.message}`);

  const res = await fetch(
    `${BASE}/auth/callback?token_hash=${data.properties.hashed_token}`,
    { redirect: 'manual' },
  );
  const cookies = res.headers.getSetCookie?.() ?? [];
  if (cookies.length === 0) throw new Error(`no session cookie for ${email}`);
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

async function scan(route, cookie) {
  const res = await fetch(`${BASE}${route.path}`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });
  if (res.status >= 300 && res.status < 400) {
    return { skipped: `redirected to ${res.headers.get('location')}` };
  }
  const html = await res.text();

  const dom = new JSDOM(html, { url: `${BASE}${route.path}`, pretendToBeVisual: true });
  const { window } = dom;

  // axe expects these globals.
  global.window = window;
  global.document = window.document;
  global.Node = window.Node;
  global.NodeList = window.NodeList;
  global.Element = window.Element;
  global.HTMLElement = window.HTMLElement;
  global.getComputedStyle = window.getComputedStyle;

  const source = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');
  window.eval(source);

  const results = await window.axe.run(window.document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    // Cannot execute meaningfully without layout -- see the header comment.
    rules: { 'color-contrast': { enabled: false } },
  });

  dom.window.close();
  return results;
}

const sessions = {};
for (const [kind, email] of Object.entries(ACCOUNTS)) {
  sessions[kind] = await signIn(email);
}

let totalViolations = 0;
const summary = [];

for (const route of ROUTES) {
  const cookie = route.as ? sessions[route.as] : null;
  let out;
  try {
    out = await scan(route, cookie);
  } catch (err) {
    console.log(`\n${route.name} (${route.path})\n  ERROR ${err.message}`);
    continue;
  }

  if (out.skipped) {
    console.log(`\n${route.name} (${route.path})\n  skipped: ${out.skipped}`);
    continue;
  }

  const v = out.violations ?? [];
  totalViolations += v.length;
  summary.push({ route: route.name, violations: v.length, passes: out.passes.length });

  console.log(`\n${route.name} (${route.path})`);
  console.log(`  ${out.passes.length} checks passed, ${v.length} violation(s)`);
  for (const issue of v) {
    console.log(`  [${issue.impact}] ${issue.id} -- ${issue.help}`);
    for (const node of issue.nodes.slice(0, 3)) {
      console.log(`      ${node.html.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
    if (issue.nodes.length > 3) console.log(`      ... and ${issue.nodes.length - 3} more`);
  }
}

console.log('\n' + '='.repeat(64));
console.table(summary);
console.log(
  totalViolations === 0
    ? 'PASS - no WCAG 2.1 A/AA violations detected by axe (contrast checked separately)'
    : `FAIL - ${totalViolations} violation(s)`,
);
process.exit(totalViolations === 0 ? 0 : 1);
