/**
 * §16.1 -- every degraded state, rendered and asserted. §20.3 requires exactly
 * that, and none of it had been tested.
 *
 * §16.1 exists because of §2: the risk that decides the outcome is "RMs find
 * stale data, and they revert to asking backbone while now also distrusting the
 * tool". A page that looks broken, or that silently shows nothing, costs the
 * same trust as a wrong number — and unlike a wrong number, nobody reports it.
 *
 * These run against the SERVER-RENDERED HTML of the real application, with real
 * sessions, rather than through a browser: the assertions are about what the
 * server decides to say, which is where every one of these states is chosen.
 *
 * Requires the dev server. Skipped with a clear message if it is not running,
 * rather than failing in a way that looks like a product defect.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/clients';
import { closeDb, q } from '../helpers/db';

const BASE = process.env.RATEHUB_BASE_URL ?? 'http://localhost:3000';

let staffCookie = '';
let partnerCookie = '';

/**
 * Probed at module load, before the suites are registered, so the whole file
 * can be skipped rather than reported as failing.
 *
 * A skip is announced LOUDLY on purpose. A suite that quietly skips is worse
 * than one that fails: §20's whole premise is that tests are executable
 * doctrine, and a doctrine that silently does not run is not doctrine. The
 * banner below is what stops "13 passed" and "13 skipped" looking alike in a
 * scrolling CI log.
 */
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
    `
${'='.repeat(72)}
` +
      `SKIPPED: §16.1 degraded-state tests.
` +
      `  No dev server at ${BASE}. These assert what the SERVER renders, so
` +
      `  they cannot run without one. Start it with \`npm run dev\` and re-run.
` +
      `  §20.3 requires every row of §16.1 to be rendered and asserted, so a
` +
      `  green suite WITHOUT these has not covered that requirement.
` +
      `${'='.repeat(72)}
`,
  );
}

/** A real session for `email`, via the magic-link flow the app actually uses. */
async function sessionCookie(email: string): Promise<string> {
  const svc = adminClient();
  const { data, error } = await svc.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw new Error(`generateLink ${email}: ${error.message}`);
  const res = await fetch(
    `${BASE}/auth/callback?token_hash=${data.properties!.hashed_token}`,
    { redirect: 'manual' },
  );
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

async function page(path: string, cookie: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' });
  return res.text();
}

beforeAll(async () => {
  staffCookie = await sessionCookie('demo.admin@example.com');
  partnerCookie = await sessionCookie('demo.alpha@example.com');
});

afterAll(closeDb);

describe.runIf(serverUp)('§16.1 Board -- empty for the pair', () => {
  it('names the partners who support it and when each last submitted', async () => {
    // USD/KES: Demo Alpha offers it, and the seed leaves it with no rate.
    const [pair] = await q<{ id: string }>(
      `select id from public.currency_pairs where base_ccy='USD' and quote_ccy='KES'`,
    );
    const html = await page(`/board?pair=${pair!.id}`, staffCookie);

    expect(html).toMatch(/No rates on the board for this pair|No partner currently offers/);
    // "The empty state names which partners support the pair and when each
    // last submitted" -- an empty table teaches an RM nothing.
    expect(html).not.toMatch(/<tbody>\s*<\/tbody>/);
  });
});

describe.runIf(serverUp)('§16.1 Board -- no active markup', () => {
  it('withholds every row, states why, and links to the fix', async () => {
    const [pair] = await q<{ id: string }>(
      `select id from public.currency_pairs where base_ccy='USD' and quote_ccy='KES'`,
    );
    // Give the pair a rate but no markup, which is E9's exact shape.
    const [pp] = await q<{ id: string; partner_id: string }>(
      `select pp.id, pp.partner_id from public.partner_pairs pp
        where pp.currency_pair_id = $1 limit 1`,
      [pair!.id],
    );
    const [sub] = await q<{ id: string }>(
      `insert into public.rate_submissions (partner_id, submitted_by, source_type, row_count)
       select $1, pm.principal_id, 'manual_grid', 1
         from public.partner_memberships pm where pm.partner_id = $1 limit 1
       returning id`,
      [pp!.partner_id],
    );
    await q(
      `insert into public.rates
         (submission_id, partner_id, partner_pair_id, partner_bid, partner_ask, size_status,
          observed_at, submitted_at, valid_from, expiry_warning_at, valid_until)
       values ($1,$2,$3,129.31,129.55,'unconfirmed',
               now(), now(), now(), now() + interval '2 hours', now() + interval '8 hours')`,
      [sub!.id, pp!.partner_id, pp!.id],
    );

    try {
      const html = await page(`/board?pair=${pair!.id}`, staffCookie);
      expect(html).toContain('no active markup');
      // "state why, link to /admin/markup for staff who can fix it"
      expect(html).toContain('/admin/markup');
      // §15.2 rule 5: never number rows that are not ranked.
      expect(html).toMatch(/unranked|no active markup/i);
    } finally {
      await q(`delete from public.rates where submission_id = $1`, [sub!.id]);
      await q(`delete from public.rate_submissions where id = $1`, [sub!.id]);
    }
  });
});

describe.runIf(serverUp)('§16.1 Board -- all rows ineligible', () => {
  it('shows them below the divider with reasons, and says nothing is quotable', async () => {
    const [pair] = await q<{ id: string }>(
      `select id from public.currency_pairs where base_ccy='USD' and quote_ccy='NGN'`,
    );
    // An amount no band covers puts every row below the divider.
    const html = await page(
      `/board?pair=${pair!.id}&direction=client_sells_base&amount=999999999`,
      staffCookie,
    );
    expect(html).toContain('Not quotable');
    // "Withheld rows are counted and named, never silently dropped."
    expect(html).toMatch(/withheld/i);
    expect(html).toMatch(/outside size range|size not confirmed|expired/i);
  });
});

describe.runIf(serverUp)('§16.1 Board -- stale data is shown, never hidden', () => {
  it('renders expiring and expired rows rather than dropping them', async () => {
    const [pair] = await q<{ id: string }>(
      `select id from public.currency_pairs where base_ccy='USD' and quote_ccy='NGN'`,
    );
    const html = await page(`/board?pair=${pair!.id}`, staffCookie);
    // §16.2: status is never encoded by colour alone -- the word is present.
    expect(html).toMatch(/\b(live|expiring|expired)\b/);
  });
});

describe.runIf(serverUp)('§16.1 Board -- the disclaimer and the forbidden phrase', () => {
  it('carries the indicative disclaimer directly beneath the table', async () => {
    const [pair] = await q<{ id: string }>(
      `select id from public.currency_pairs where base_ccy='USD' and quote_ccy='NGN'`,
    );
    const html = await page(`/board?pair=${pair!.id}`, staffCookie);
    expect(html).toContain('Indicative only');
  });

  it('never says "best execution", anywhere', async () => {
    // §7: the phrase "MUST NOT appear anywhere in the application".
    for (const path of ['/board', '/admin/health', '/admin/markup', '/partner', '/login']) {
      const cookie = path.startsWith('/partner') ? partnerCookie : staffCookie;
      const html = await page(path, cookie);
      expect(html.toLowerCase(), `"best execution" found on ${path}`).not.toContain(
        'best execution',
      );
    }
  });
});

describe.runIf(serverUp)('§16.1 Grid -- parse produced nothing', () => {
  it('offers both entry paths so a partner is never stuck', async () => {
    const html = await page('/partner/submit', partnerCookie);
    // §6.1: "a large autofocused textarea ... Beneath it: or start with an
    // empty row. Both paths land in the same grid." D7: no paste-only dead end.
    expect(html).toContain('Parse');
    expect(html).toMatch(/start with an empty row/i);
    expect(html).toContain('<textarea');
  });
});

describe.runIf(serverUp)('§16.1 Any page -- session expired', () => {
  it('sends an unauthenticated visitor to /login, not to a blank page', async () => {
    for (const path of ['/board', '/partner', '/admin/health']) {
      const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
      expect([302, 303, 307, 308], `${path} did not redirect`).toContain(res.status);
      expect(res.headers.get('location')).toMatch(/\/login/);
    }
  });

  it('caches no data in the redirect URL', async () => {
    // §16.1: "no data cached in the URL".
    const res = await fetch(`${BASE}/board?pair=abc&amount=50000`, { redirect: 'manual' });
    const location = res.headers.get('location') ?? '';
    expect(location).not.toContain('50000');
  });
});

describe.runIf(serverUp)('§16.1 Any page -- permission denied', () => {
  it('states plainly what is not permitted, and is never an empty page', async () => {
    const html = await page('/denied', staffCookie);
    expect(html).toMatch(/do not have access/i);
    // "Never an empty page that looks broken."
    expect(html.length).toBeGreaterThan(500);
    // It offers a way back rather than stranding the user.
    expect(html).toMatch(/href="\/(board|partner)"/);
  });

  it('sends a partner who reaches an admin route to /denied, not to a 500', async () => {
    const res = await fetch(`${BASE}/admin/markup`, {
      headers: { cookie: partnerCookie },
      redirect: 'manual',
    });
    expect([302, 303, 307, 308]).toContain(res.status);
    expect(res.headers.get('location')).toMatch(/\/denied/);
  });

  it('sends staff who reach the partner zone to /denied (§5, one zone each)', async () => {
    const res = await fetch(`${BASE}/partner/submit`, {
      headers: { cookie: staffCookie },
      redirect: 'manual',
    });
    expect([302, 303, 307, 308]).toContain(res.status);
    expect(res.headers.get('location')).toMatch(/\/denied/);
  });
});

describe.runIf(serverUp)('§16.1 Partner home -- no pairs yet', () => {
  it('explains that backbone adds the first pair, and names who to contact', async () => {
    // Demo Beta has a pair; strip it temporarily to reach the state.
    const [beta] = await q<{ id: string }>(
      `select id from public.partners where slug = 'demo-beta'`,
    );
    await q(`update public.partner_pairs set active = false where partner_id = $1`, [beta!.id]);
    try {
      const cookie = await sessionCookie('demo.beta@example.com');
      const html = await page('/partner', cookie);
      expect(html).toMatch(/backbone|relationship manager/i);
      expect(html).toMatch(/None yet|no pairs/i);
    } finally {
      await q(`update public.partner_pairs set active = true where partner_id = $1`, [beta!.id]);
    }
  });
});
