'use server';

import { revalidatePath } from 'next/cache';
import { supabaseServer } from '@/lib/supabase/server';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** §13.1: partner_admin only, own partner only. The RPC enforces both. */
export async function addPair(currencyPairId: string): Promise<ActionResult> {
  const sb = await supabaseServer();
  const { error } = await sb.rpc('add_partner_pair', { p_currency_pair_id: currencyPairId });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/partner/pairs');
  revalidatePath('/partner');
  return { ok: true };
}

export async function setPairActive(partnerPairId: string, active: boolean): Promise<ActionResult> {
  const sb = await supabaseServer();
  const { error } = await sb.rpc('set_partner_pair_active', {
    p_partner_pair_id: partnerPairId,
    p_active: active,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/partner/pairs');
  revalidatePath('/partner');
  return { ok: true };
}

export async function setQuoteMode(partnerPairId: string, mode: string): Promise<ActionResult> {
  const sb = await supabaseServer();
  const { error } = await sb.rpc('set_partner_pair_quote_mode', {
    p_partner_pair_id: partnerPairId,
    p_mode: mode,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/partner/pairs');
  return { ok: true };
}
