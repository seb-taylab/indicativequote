import { requirePartner } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { AppShell } from '@/components/AppShell';
import { PairManager, type AvailablePair, type OwnPair } from './PairManager';

export const dynamic = 'force-dynamic';

export default async function PairsPage() {
  // D15: partner_admin manages pairs. It cannot invite anyone -- there is no
  // such RPC anywhere in the surface.
  const principal = await requirePartner(['partner_admin']);
  const sb = await supabaseServer();

  const { data: mine } = await sb
    .from('partner_pairs')
    .select('id, active, quote_mode, currency_pair_id, currency_pairs(base_ccy, quote_ccy)');

  const own: OwnPair[] = (mine ?? []).flatMap((p) => {
    const cp = p.currency_pairs as unknown as { base_ccy: string; quote_ccy: string } | null;
    if (!cp) return [];
    return [{
      id: p.id as string,
      active: p.active as boolean,
      quote_mode: p.quote_mode as string,
      base_ccy: cp.base_ccy,
      quote_ccy: cp.quote_ccy,
    }];
  }).sort((a, b) => `${a.base_ccy}${a.quote_ccy}`.localeCompare(`${b.base_ccy}${b.quote_ccy}`));

  const held = new Set((mine ?? []).map((p) => p.currency_pair_id as string));

  const { data: all } = await sb
    .from('currency_pairs')
    .select('id, base_ccy, quote_ccy')
    .eq('active', true)
    .order('base_ccy');

  const available: AvailablePair[] = (all ?? [])
    .filter((p) => !held.has(p.id as string))
    .map((p) => ({ id: p.id as string, base_ccy: p.base_ccy as string, quote_ccy: p.quote_ccy as string }));

  return (
    <AppShell principal={principal} title="Pairs and quote modes">
      <PairManager own={own} available={available} />
    </AppShell>
  );
}
