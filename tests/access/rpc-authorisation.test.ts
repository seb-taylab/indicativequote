/**
 * T10 and T16 to T20 -- the RPC authorisation tests.
 *
 * These were verified during the build by impersonating roles in SQL, which is
 * NOT what §20.2 asks for: "Automated, through the real client with real
 * sessions. Never a manual check, never a service-role query." A check done
 * once by hand proves the code was right that afternoon; only a test proves it
 * is still right.
 *
 * They cover the two failures §13.2 exists to prevent — escalation by
 * invitation (TM4) and lockout by revocation (TM5) — which are the ones a
 * refactor is most likely to reopen quietly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { signInAs } from '../helpers/clients';
import { F, buildWorld, teardown, type World } from '../helpers/fixtures';
import { closeDb, q } from '../helpers/db';

let world: World;
const s: Record<string, SupabaseClient> = {};

beforeAll(async () => {
  world = await buildWorld();
  s.aAdmin = await signInAs(F.users.aAdmin);
  s.bUser = await signInAs(F.users.bUser);
  s.rm = await signInAs(F.users.rm);
  s.operator = await signInAs(F.users.operator);
  s.admin = await signInAs(F.users.admin);
});

afterAll(async () => {
  await teardown();
  await closeDb();
});

describe('T10 -- a partner cannot write into another partner', () => {
  // §13.1's submit_rates takes a currency_pair_id, not a partner_pair_id: it
  // resolves the partner-pair from the CALLER's own partner. That is a
  // stronger guarantee than the spec's phrasing, because there is no
  // partner_pair_id parameter for a caller to tamper with at all.
  //
  // Both fixture partners quote the same canonical pair, so this is the exact
  // case where a lookup scoped to the wrong tenant would be invisible.
  it('resolves the caller own partner-pair, never another partner one', async () => {
    const { error } = await s.aAdmin!.rpc('submit_rates', {
      p_rows: [
        {
          currency_pair_id: world.pairId,
          bid: '1400',
          ask: '1402',
          size_status: 'unconfirmed',
        },
      ],
      p_valid_until: null,
      p_raw: null,
      p_idem: null,
    });
    expect(error).toBeNull();

    const rows = await q<{ partner_id: string }>(
      `select partner_id from public.rates
        where partner_bid = 1400 and partner_ask = 1402`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.partner_id, 'a rate was written against the wrong partner').toBe(world.partnerAId);
      expect(r.partner_id).not.toBe(world.partnerBId);
    }
  });

  it('refuses a pair the caller partner does not offer', async () => {
    // world.testPairId exists in the registry but is on nobody's book.
    const { error } = await s.aAdmin!.rpc('submit_rates', {
      p_rows: [
        { currency_pair_id: world.testPairId, bid: '18', ask: '19', size_status: 'unconfirmed' },
      ],
      p_valid_until: null,
      p_raw: null,
      p_idem: null,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not on your book/i);
  });
});

describe('T16 -- an operator cannot create a staff principal (TM4)', () => {
  // V2 shipped a single invite_principal(email, kind, role) callable by an
  // operator, so an operator could invite an address they controlled as
  // backbone_admin and sign in with it. `kind` is now hard-coded per function.
  it('refuses invite_staff to a backbone_operator', async () => {
    const { error } = await s.operator!.rpc('invite_staff', {
      p_email: 'ratehub.test.selfmade@example.com',
      p_role: 'backbone_admin',
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/backbone_admin/);
  });

  it('refuses invite_staff to an rm_viewer', async () => {
    const { error } = await s.rm!.rpc('invite_staff', {
      p_email: 'ratehub.test.selfmade2@example.com',
      p_role: 'rm_viewer',
    });
    expect(error).not.toBeNull();
  });

  it('lets an operator invite a PARTNER user, which is its actual job', async () => {
    const { error } = await s.operator!.rpc('invite_partner_user', {
      p_email: 'ratehub.test.newpartner@example.com',
      p_role: 'partner_user',
      p_partner_id: world.partnerAId,
    });
    expect(error).toBeNull();

    // ...and that principal is 'partner', never 'staff'.
    const [p] = await q<{ kind: string }>(
      `select kind from public.principals where email = 'ratehub.test.newpartner@example.com'`,
    );
    expect(p!.kind).toBe('partner');
  });
});

describe('T17 -- an operator cannot reach a staff principal by the partner path', () => {
  it('refuses revoke_partner_user against a staff principal', async () => {
    const { error } = await s.operator!.rpc('revoke_partner_user', {
      p_principal_id: world.principalIds[F.users.admin]!,
      p_reason: 'attempting the wrong door',
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/staff/i);
  });

  it('leaves that admin active', async () => {
    const [p] = await q<{ status: string }>(
      `select status from public.principals where id = $1`,
      [world.principalIds[F.users.admin]!],
    );
    expect(p!.status).toBe('active');
  });
});

describe('T18 / T19 -- the lockout guards (TM5)', () => {
  it('T19 refuses revoke_staff on oneself', async () => {
    const { error } = await s.admin!.rpc('revoke_staff', {
      p_principal_id: world.principalIds[F.users.admin]!,
      p_reason: 'tidying up',
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/yourself/i);
  });

  it('refuses an admin changing their own role', async () => {
    // Demotion is the other route to zero admins.
    const { error } = await s.admin!.rpc('set_staff_role', {
      p_principal_id: world.principalIds[F.users.admin]!,
      p_role: 'rm_viewer',
    });
    expect(error).not.toBeNull();
  });

  it('T18 leaves at least one active backbone_admin standing', async () => {
    // With self-revocation refused and require_staff admitting only an ACTIVE
    // admin, the count guard is unreachable for a non-self target -- see
    // docs/spec-findings.md N2. What T18 actually asserts is the invariant:
    // the system can never reach zero active admins through the RPC surface.
    const [{ n }] = await q<{ n: number }>(
      `select count(*)::int as n
         from public.staff_profiles sp
         join public.principals p on p.id = sp.principal_id
        where sp.role = 'backbone_admin' and p.status = 'active'`,
    );
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('permits revoking an INVITED admin who never signed in', async () => {
    // The bug fixed in 0013: the guard counted active admins without checking
    // whether the TARGET was active, so an invitation sent to a mistyped
    // address could not be withdrawn.
    const invited = await s.admin!.rpc('invite_staff', {
      p_email: 'ratehub.test.mistyped@example.com',
      p_role: 'backbone_admin',
    });
    expect(invited.error).toBeNull();

    const principalId = (invited.data as { principal_id: string }).principal_id;
    const { error } = await s.admin!.rpc('revoke_staff', {
      p_principal_id: principalId,
      p_reason: 'invited by mistake',
    });
    expect(error, 'an invited admin who never signed in must be revocable').toBeNull();
  });
});

describe('T20 -- markup is admin-only', () => {
  const markupArgs = (pairId: string) => ({
    p_currency_pair_id: pairId,
    p_default: '50',
    p_min: '0',
    p_max: '200',
    p_reason: 'test',
  });

  it('refuses create_markup_version to an rm_viewer', async () => {
    const { error } = await s.rm!.rpc('create_markup_version', markupArgs(world.testPairId));
    expect(error).not.toBeNull();
  });

  it('refuses create_markup_version to a backbone_operator', async () => {
    const { error } = await s.operator!.rpc('create_markup_version', markupArgs(world.testPairId));
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/backbone_admin/);
  });

  it('refuses retire_markup_version to an operator', async () => {
    const created = await s.admin!.rpc('create_markup_version', markupArgs(world.testPairId));
    expect(created.error).toBeNull();
    const id = (created.data as { id: string }).id;

    const { error } = await s.operator!.rpc('retire_markup_version', {
      p_id: id,
      p_reason: 'not mine to retire',
    });
    expect(error).not.toBeNull();
  });

  it('refuses a partner every markup RPC (TM2)', async () => {
    const create = await s.aAdmin!.rpc('create_markup_version', markupArgs(world.testPairId));
    expect(create.error).not.toBeNull();
    // And the partner still cannot read the table at all.
    const { data } = await s.aAdmin!.from('markup_versions').select('*');
    expect(data ?? []).toHaveLength(0);
  });

  it('lets an admin create one, which is the point', async () => {
    const { error } = await s.admin!.rpc('create_markup_version', markupArgs(world.testPairId));
    expect(error).toBeNull();
  });
});

describe('Partner RPCs refuse staff, and vice versa', () => {
  it('refuses submit_rates to staff -- they have no partner to submit for', async () => {
    const { error } = await s.rm!.rpc('submit_rates', {
      p_rows: [{ currency_pair_id: world.pairId, bid: '1', ask: '2', size_status: 'unconfirmed' }],
      p_valid_until: null,
      p_raw: null,
      p_idem: null,
    });
    expect(error).not.toBeNull();
  });

  it('refuses board_rates to a partner (TM2 -- the only rates-to-markup join)', async () => {
    const { error } = await s.aAdmin!.rpc('board_rates', {
      p_currency_pair_id: world.pairId,
      p_direction: 'client_sells_base',
      p_amount: null,
      p_markup_bps: null,
    });
    expect(error).not.toBeNull();
  });

  it('refuses partner_health to an rm_viewer (§4: board and quotes, nothing else)', async () => {
    const { error } = await s.rm!.rpc('partner_health', {});
    expect(error).not.toBeNull();
  });
});
