'use server';

import { revalidatePath } from 'next/cache';
import { supabaseServer } from '@/lib/supabase/server';

export interface R { ok: boolean; error?: string }

async function call(fn: string, args: Record<string, unknown>): Promise<R> {
  const sb = await supabaseServer();
  const { error } = await sb.rpc(fn, args);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Every one of these is a thin pass-through to an RPC. The role check lives
 * inside the function, not here (§13): an operator calling invite_staff is
 * refused by the database, not by this file. These wrappers exist to give the
 * form a Server Action, and to revalidate.
 */

export async function createPartner(fd: FormData): Promise<R> {
  const r = await call('create_partner', {
    p_slug: String(fd.get('slug') ?? '').trim(),
    p_display_name: String(fd.get('display_name') ?? '').trim(),
    p_soft_ttl_minutes: Number(fd.get('soft') ?? 120),
    p_hard_ttl_minutes: Number(fd.get('hard') ?? 480),
    // §12.7: decimals cross as text.
    p_move_warn_pct: String(fd.get('move_warn') ?? '5.000').trim(),
  });
  revalidatePath('/admin/partners');
  return r;
}

export async function setPartnerStatus(partnerId: string, status: string): Promise<R> {
  const r = await call('set_partner_status', { p_partner_id: partnerId, p_status: status });
  revalidatePath('/admin/partners');
  return r;
}

export async function confirmConvention(partnerId: string, ref: string): Promise<R> {
  const r = await call('confirm_partner_convention', { p_partner_id: partnerId, p_ref: ref });
  revalidatePath('/admin/partners');
  revalidatePath('/admin/health');
  return r;
}

export async function setPartnerPolicy(fd: FormData): Promise<R> {
  const r = await call('set_partner_policy', {
    p_partner_id: String(fd.get('partner_id')),
    p_soft_ttl_minutes: Number(fd.get('soft')),
    p_hard_ttl_minutes: Number(fd.get('hard')),
    p_move_warn_pct: String(fd.get('move_warn') ?? '5.000').trim(),
  });
  revalidatePath('/admin/partners');
  return r;
}

export async function invitePartnerUser(fd: FormData): Promise<R> {
  const r = await call('invite_partner_user', {
    p_email: String(fd.get('email') ?? '').trim(),
    p_role: String(fd.get('role') ?? 'partner_user'),
    p_partner_id: String(fd.get('partner_id')),
  });
  revalidatePath('/admin/access');
  return r;
}

/** Admin only. The single path that creates a staff principal (TM4). */
export async function inviteStaff(fd: FormData): Promise<R> {
  const r = await call('invite_staff', {
    p_email: String(fd.get('email') ?? '').trim(),
    p_role: String(fd.get('role') ?? 'rm_viewer'),
  });
  revalidatePath('/admin/access');
  return r;
}

export async function revokePartnerUser(principalId: string, reason: string): Promise<R> {
  const r = await call('revoke_partner_user', { p_principal_id: principalId, p_reason: reason });
  revalidatePath('/admin/access');
  return r;
}

export async function revokeStaff(principalId: string, reason: string): Promise<R> {
  const r = await call('revoke_staff', { p_principal_id: principalId, p_reason: reason });
  revalidatePath('/admin/access');
  return r;
}

export async function setStaffRole(principalId: string, role: string): Promise<R> {
  const r = await call('set_staff_role', { p_principal_id: principalId, p_role: role });
  revalidatePath('/admin/access');
  return r;
}

export async function createMarkupVersion(fd: FormData): Promise<R> {
  const r = await call('create_markup_version', {
    p_currency_pair_id: String(fd.get('pair_id')),
    p_default: String(fd.get('default_bps') ?? '').trim(),
    p_min: String(fd.get('min_bps') ?? '').trim(),
    p_max: String(fd.get('max_bps') ?? '').trim(),
    p_reason: String(fd.get('reason') ?? '').trim(),
  });
  revalidatePath('/admin/markup');
  revalidatePath('/board');
  return r;
}

export async function retireMarkupVersion(id: string, reason: string): Promise<R> {
  const r = await call('retire_markup_version', { p_id: id, p_reason: reason });
  revalidatePath('/admin/markup');
  revalidatePath('/board');
  return r;
}

export async function registerPair(fd: FormData): Promise<R> {
  const r = await call('register_currency_pair', {
    p_base: String(fd.get('base') ?? '').trim(),
    p_quote: String(fd.get('quote') ?? '').trim(),
  });
  revalidatePath('/admin/partners');
  return r;
}

export async function registerCurrency(fd: FormData): Promise<R> {
  const r = await call('register_currency', {
    p_code: String(fd.get('code') ?? '').trim(),
    p_name: String(fd.get('name') ?? '').trim(),
    p_kind: String(fd.get('kind') ?? 'fiat'),
    p_minor_units: Number(fd.get('minor_units') ?? 2),
  });
  revalidatePath('/admin/partners');
  return r;
}
