/**
 * §18.5 transport: "Standard `POST` with CSRF protection; the existing app's
 * GET-with-query write pattern MUST NOT be carried across."
 *
 * That is one of the few places the specification names a defect in the system
 * being replaced, and it had never been verified here. Next.js Server Actions
 * do carry an origin check, but "the framework probably handles it" is exactly
 * the reasoning F1 punished: §12.2 assumed ALTER DEFAULT PRIVILEGES worked on
 * Supabase, and it did not.
 *
 * These tests assert the control by its EFFECT, not by a status code. A
 * cross-origin request that returns 500 has told you nothing if the write
 * happened anyway. The login action is used because its side effect is
 * observable and harmless: an unknown address writes an `access.signin_denied`
 * audit row (0021) and sends no e-mail.
 *
 * Both sides of the boundary are asserted. The two requests are byte-identical
 * apart from the Origin header -- same freshly-fetched action id, same fields,
 * same encoding -- so a test that passed because the request was malformed
 * rather than because it was cross-origin would fail the same-origin half.
 * F24 and N7 were both assertions that would have passed whatever the code did.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, q } from '../helpers/db';

const BASE = process.env.RATEHUB_BASE_URL ?? 'http://localhost:3000';

const serverUp = await (async () => {
  try {
    const probe = await fetch(`${BASE}/login`, { redirect: 'manual' });
    return probe.status < 500;
  } catch {
    return false;
  }
})();

if (!serverUp) {
  console.warn(
    `\n${'='.repeat(72)}\n` +
      `SKIPPED: §18.5 CSRF tests.\n` +
      `  No dev server at ${BASE}. These post real Server Action requests, so\n` +
      `  they cannot run without one. Start it with \`npm run dev\` and re-run.\n` +
      `  A green suite WITHOUT these has not verified that a forged cross-origin\n` +
      `  POST fails to write.\n` +
      `${'='.repeat(72)}\n`,
  );
}

/**
 * Next.js encodes a Server Action for the no-JavaScript path as hidden inputs
 * inside the form. Reading them back gives a REAL action request rather than a
 * hand-made approximation of one -- which matters, because an approximation
 * would be rejected for being malformed and would look like CSRF protection.
 */
async function loginFormFields(): Promise<Record<string, string>> {
  const html = await (await fetch(`${BASE}/login`)).text();
  const form = /<form[\s\S]*?<\/form>/.exec(html);
  if (!form) throw new Error('No form on /login; the page shape changed.');
  const fields: Record<string, string> = {};
  for (const m of form[0].matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g)) {
    fields[m[1]!] = (m[2] ?? '').replace(/&quot;/g, '"');
  }
  if (Object.keys(fields).length === 0) {
    throw new Error('No hidden action fields on /login; Server Action encoding changed.');
  }
  return fields;
}

async function submitLogin(email: string, origin: string | null): Promise<Response> {
  const body = new FormData();
  for (const [k, v] of Object.entries(await loginFormFields())) body.append(k, v);
  body.append('email', email);
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  return fetch(`${BASE}/login`, { method: 'POST', body, headers, redirect: 'manual' });
}

async function denialsFor(email: string): Promise<number> {
  const [row] = await q<{ n: number }>(
    `select count(*)::int as n from public.audit_events
      where action = 'access.signin_denied' and subject_id = $1`,
    [email],
  );
  return row!.n;
}

afterAll(async () => {
  await q(`delete from public.audit_events where subject_id like 'csrf.test.%'`);
  await closeDb();
});

describe.runIf(serverUp)('§18.5 -- Server Actions reject a forged cross-origin POST', () => {
  it('performs the write when the request comes from the application itself', async () => {
    // The control half. Without this, "no write happened" in the next test
    // could equally mean the request never worked in the first place.
    const email = `csrf.test.same.${Date.now()}@example.com`;
    const res = await submitLogin(email, BASE);

    expect(res.status, 'a same-origin Server Action POST was rejected').toBeLessThan(400);
    expect(await denialsFor(email), 'the same-origin action did not run').toBe(1);
  });

  it('does NOT perform the write when the Origin is another site', async () => {
    const email = `csrf.test.cross.${Date.now()}@example.com`;
    const res = await submitLogin(email, 'https://evil.example');

    // The status is secondary. The claim is that nothing happened.
    expect(res.status, 'a cross-origin Server Action POST was accepted').toBeGreaterThanOrEqual(400);
    expect(
      await denialsFor(email),
      'a cross-origin POST reached the database -- CSRF protection is not holding',
    ).toBe(0);
  });

  it('is decided by the Origin header alone, nothing else about the request', async () => {
    // Same shape, same freshly-fetched action id, two outcomes. This is what
    // rules out "the cross-origin request was simply malformed".
    const same = `csrf.test.same2.${Date.now()}@example.com`;
    const cross = `csrf.test.cross2.${Date.now()}@example.com`;

    const sameRes = await submitLogin(same, BASE);
    const crossRes = await submitLogin(cross, 'https://evil.example');

    expect(sameRes.status).toBeLessThan(400);
    expect(crossRes.status).toBeGreaterThanOrEqual(400);
    expect(await denialsFor(same)).toBe(1);
    expect(await denialsFor(cross)).toBe(0);
  });
});

describe.runIf(serverUp)('§18.5 -- no write happens over GET', () => {
  it('leaves the audit log untouched when the login action is attempted as a GET', async () => {
    // "The existing app's GET-with-query write pattern MUST NOT be carried
    // across." A query string is the shape that pattern took, so this is the
    // shape the test uses.
    const email = `csrf.test.get.${Date.now()}@example.com`;
    const before = await q<{ n: number }>(
      `select count(*)::int as n from public.audit_events where action = 'access.signin_denied'`,
    );

    const res = await fetch(`${BASE}/login?email=${encodeURIComponent(email)}`, {
      redirect: 'manual',
    });
    expect(res.status).toBeLessThan(500);

    const after = await q<{ n: number }>(
      `select count(*)::int as n from public.audit_events where action = 'access.signin_denied'`,
    );
    expect(await denialsFor(email), 'a GET with a query string performed a write').toBe(0);
    expect(after[0]!.n, 'a GET request wrote an audit event').toBe(before[0]!.n);
  });

  it('exposes exactly one GET route that writes, and it is the magic-link exchange', async () => {
    // /auth/callback is a GET that calls record_sign_in, and that is not the
    // pattern §18.5 forbids: the single-use token IS the credential, it is
    // consumed on use, and a magic link cannot be anything but a GET. Recorded
    // here so the exception is a decision rather than an oversight, and so a
    // second write-on-GET route cannot appear unnoticed.
    const { readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');

    async function routeFiles(dir: string): Promise<string[]> {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await routeFiles(p)));
        else if (e.name === 'route.ts' || e.name === 'route.tsx') out.push(p);
      }
      return out;
    }

    const routes = (await routeFiles('app')).map((p) => p.replace(/\\/g, '/'));
    expect(routes).toEqual(['app/auth/callback/route.ts']);
  });
});
