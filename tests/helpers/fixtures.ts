import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient, ensureAuthUser } from './clients.js';
import { q } from './db.js';

/**
 * A two-partner, five-principal world, built with the service role because the
 * RPC surface that would normally create it does not exist yet at step 1 of
 * §21.1. Every assertion against it is made through a real session.
 */
export const F = {
  partnerA: { slug: 'test-alpha', name: 'Test Alpha' },
  partnerB: { slug: 'test-beta', name: 'Test Beta' },
  users: {
    aUser: 'ratehub.test.a.user@example.com',
    aAdmin: 'ratehub.test.a.admin@example.com',
    bUser: 'ratehub.test.b.user@example.com',
    rm: 'ratehub.test.rm@example.com',
    operator: 'ratehub.test.operator@example.com',
    admin: 'ratehub.test.admin@example.com',
    revoked: 'ratehub.test.revoked@example.com',
  },
} as const;

export interface World {
  partnerAId: string;
  partnerBId: string;
  pairId: string;
  partnerPairAId: string;
  partnerPairBId: string;
  rateAId: string;
  rateBId: string;
  principalIds: Record<string, string>;
}

/** Remove every test artefact. Safe to call when nothing exists. */
export async function teardown(): Promise<void> {
  // Ordered by dependency. Test rows only -- matched on the test slugs and
  // the reserved e-mail prefix, so production data cannot be touched.
  await q(`delete from public.audit_events where partner_id in
             (select id from public.partners where slug in ($1,$2))`, [F.partnerA.slug, F.partnerB.slug]);
  await q(`delete from public.rates where partner_id in
             (select id from public.partners where slug in ($1,$2))`, [F.partnerA.slug, F.partnerB.slug]);
  await q(`delete from public.rate_submissions where partner_id in
             (select id from public.partners where slug in ($1,$2))`, [F.partnerA.slug, F.partnerB.slug]);
  await q(`delete from public.markup_versions where created_by in
             (select id from public.principals where email like 'ratehub.test.%')`);
  await q(`delete from public.partner_pairs where partner_id in
             (select id from public.partners where slug in ($1,$2))`, [F.partnerA.slug, F.partnerB.slug]);
  await q(`delete from public.partner_memberships where principal_id in
             (select id from public.principals where email like 'ratehub.test.%')`);
  await q(`delete from public.staff_profiles where principal_id in
             (select id from public.principals where email like 'ratehub.test.%')`);
  await q(`delete from public.principals where email like 'ratehub.test.%'`);
  await q(`delete from public.partners where slug in ($1,$2)`, [F.partnerA.slug, F.partnerB.slug]);
  await q(`delete from public.currency_pairs where base_ccy = 'USD' and quote_ccy = 'NGN'`);
  await q(`delete from public.currencies where code in ('USD','NGN')`);

  const admin = adminClient();
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data?.users ?? []) {
    if (u.email?.startsWith('ratehub.test.')) {
      await admin.auth.admin.deleteUser(u.id);
    }
  }
}

export async function buildWorld(): Promise<World> {
  await teardown();

  await q(`insert into public.currencies (code, name, kind, minor_units)
           values ('USD','US Dollar','fiat',2), ('NGN','Nigerian Naira','fiat',2)`);

  const [pair] = await q<{ id: string }>(
    `insert into public.currency_pairs (base_ccy, quote_ccy) values ('USD','NGN') returning id`,
  );

  // Partner A has its convention confirmed; Partner B does not, so the [A-1]
  // gate has something to bite on in the eligibility tests.
  const [pa] = await q<{ id: string }>(
    `insert into public.partners (slug, display_name, convention_confirmed_at, convention_ref)
     values ($1, $2, now(), 'test-confirmation') returning id`,
    [F.partnerA.slug, F.partnerA.name],
  );
  const [pb] = await q<{ id: string }>(
    `insert into public.partners (slug, display_name) values ($1, $2) returning id`,
    [F.partnerB.slug, F.partnerB.name],
  );

  const [ppa] = await q<{ id: string }>(
    `insert into public.partner_pairs (partner_id, currency_pair_id) values ($1,$2) returning id`,
    [pa!.id, pair!.id],
  );
  const [ppb] = await q<{ id: string }>(
    `insert into public.partner_pairs (partner_id, currency_pair_id) values ($1,$2) returning id`,
    [pb!.id, pair!.id],
  );

  const principalIds: Record<string, string> = {};

  async function principal(
    email: string,
    kind: 'staff' | 'partner',
    opts: { role?: string; partnerId?: string; status?: string } = {},
  ): Promise<string> {
    const authId = await ensureAuthUser(email);
    const [p] = await q<{ id: string }>(
      `insert into public.principals (email, kind, auth_user_id, status, revoked_at, revoked_by)
       values ($1,$2,$3,$4, case when $4='revoked' then now() end, case when $4='revoked' then $3::uuid end)
       returning id`,
      [email, kind, authId, opts.status ?? 'active'],
    );
    if (kind === 'staff') {
      await q(`insert into public.staff_profiles (principal_id, role) values ($1,$2)`, [
        p!.id,
        opts.role,
      ]);
    } else {
      await q(
        `insert into public.partner_memberships (principal_id, partner_id, role) values ($1,$2,$3)`,
        [p!.id, opts.partnerId, opts.role],
      );
    }
    principalIds[email] = p!.id;
    return p!.id;
  }

  await principal(F.users.aUser, 'partner', { role: 'partner_user', partnerId: pa!.id });
  await principal(F.users.aAdmin, 'partner', { role: 'partner_admin', partnerId: pa!.id });
  await principal(F.users.bUser, 'partner', { role: 'partner_user', partnerId: pb!.id });
  await principal(F.users.rm, 'staff', { role: 'rm_viewer' });
  await principal(F.users.operator, 'staff', { role: 'backbone_operator' });
  await principal(F.users.admin, 'staff', { role: 'backbone_admin' });
  await principal(F.users.revoked, 'partner', {
    role: 'partner_user',
    partnerId: pa!.id,
    status: 'revoked',
  });

  // One current rate for each partner. submitted_by is that partner's own user.
  const rateAId = await seedRateFor(pa!.id, ppa!.id, principalIds[F.users.aUser]!, '1392', '1394');
  const rateBId = await seedRateFor(pb!.id, ppb!.id, principalIds[F.users.bUser]!, '1391', '1395');

  return {
    partnerAId: pa!.id,
    partnerBId: pb!.id,
    pairId: pair!.id,
    partnerPairAId: ppa!.id,
    partnerPairBId: ppb!.id,
    rateAId,
    rateBId,
    principalIds,
  };
}

async function seedRateFor(
  partnerId: string,
  partnerPairId: string,
  submittedBy: string,
  bid: string,
  ask: string,
): Promise<string> {
  const [sub] = await q<{ id: string }>(
    `insert into public.rate_submissions (partner_id, submitted_by, source_type, row_count)
     values ($1, $2, 'manual_grid', 1) returning id`,
    [partnerId, submittedBy],
  );
  const [rate] = await q<{ id: string }>(
    `insert into public.rates
       (submission_id, partner_id, partner_pair_id, partner_bid, partner_ask,
        size_status, observed_at, submitted_at, valid_from, expiry_warning_at, valid_until)
     values ($1,$2,$3,$4,$5,'unconfirmed', now(), now(), now(), now() + interval '2 hours', now() + interval '8 hours')
     returning id`,
    [sub!.id, partnerId, partnerPairId, bid, ask],
  );
  return rate!.id;
}

/** Rows visible to this session for a table. Returns [] on a policy denial. */
export async function visibleRows(
  client: SupabaseClient,
  table: string,
): Promise<unknown[]> {
  const { data, error } = await client.from(table).select('*');
  if (error) return [];
  return data ?? [];
}
