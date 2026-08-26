import 'server-only';
import { redirect } from 'next/navigation';
import { supabaseServer } from './supabase/server';

/**
 * §19: "Role and partner are resolved server-side on every protected request.
 *  No partner_id in a JWT claim -- a claim would need re-checking against the
 *  live table anyway, which is the complexity of both approaches and the
 *  guarantee of neither."
 *
 * So this reads the live tables through the caller's own RLS-bound session on
 * every request. A revoked principal resolves to null on their next request,
 * whether or not token invalidation has landed (TM8).
 */

export type StaffRole = 'rm_viewer' | 'backbone_operator' | 'backbone_admin';
export type PartnerRole = 'partner_user' | 'partner_admin';

export interface Principal {
  id: string;
  email: string;
  kind: 'staff' | 'partner';
  staffRole: StaffRole | null;
  partnerId: string | null;
  partnerName: string | null;
  partnerRole: PartnerRole | null;
}

export async function currentPrincipal(): Promise<Principal | null> {
  const sb = await supabaseServer();
  const { data: auth } = await sb.auth.getUser();
  if (!auth?.user) return null;

  // principals_self_read lets a principal see exactly its own row.
  const { data: p } = await sb
    .from('principals')
    .select('id, email, kind, status')
    .eq('auth_user_id', auth.user.id)
    .maybeSingle();

  if (!p || p.status !== 'active') return null;

  const [{ data: staff }, { data: membership }] = await Promise.all([
    sb.from('staff_profiles').select('role').eq('principal_id', p.id).maybeSingle(),
    sb.from('partner_memberships').select('partner_id, role').eq('principal_id', p.id).maybeSingle(),
  ]);

  let partnerName: string | null = null;
  if (membership?.partner_id) {
    const { data: partner } = await sb
      .from('partners')
      .select('display_name')
      .eq('id', membership.partner_id)
      .maybeSingle();
    partnerName = partner?.display_name ?? null;
  }

  return {
    id: p.id,
    email: p.email,
    kind: p.kind,
    staffRole: (staff?.role as StaffRole) ?? null,
    partnerId: membership?.partner_id ?? null,
    partnerName,
    partnerRole: (membership?.role as PartnerRole) ?? null,
  };
}

/** §5: a principal only ever sees one zone. */
export function zoneFor(p: Principal): '/board' | '/partner' {
  return p.kind === 'staff' ? '/board' : '/partner';
}

export async function requireStaff(allowed: StaffRole[]): Promise<Principal> {
  const p = await currentPrincipal();
  if (!p) redirect('/login');
  if (!p.staffRole || !allowed.includes(p.staffRole)) redirect('/denied');
  return p;
}

export async function requirePartner(allowed: PartnerRole[]): Promise<Principal> {
  const p = await currentPrincipal();
  if (!p) redirect('/login');
  if (!p.partnerRole || !allowed.includes(p.partnerRole)) redirect('/denied');
  return p;
}
