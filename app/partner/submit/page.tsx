import { requirePartner } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { AppShell } from '@/components/AppShell';
import { SubmitGrid, type CurrentRow, type PairInfo } from './SubmitGrid';

export const dynamic = 'force-dynamic';

export default async function SubmitPage() {
  const principal = await requirePartner(['partner_user', 'partner_admin']);
  const sb = await supabaseServer();

  // RLS restricts all of this to the caller's own partner.
  const { data: partnerPairs } = await sb
    .from('partner_pairs')
    .select('id, quote_mode, currency_pair_id, currency_pairs(id, base_ccy, quote_ccy)')
    .eq('active', true);

  const pairs: PairInfo[] = (partnerPairs ?? []).flatMap((pp) => {
    const cp = pp.currency_pairs as unknown as
      { id: string; base_ccy: string; quote_ccy: string } | null;
    if (!cp) return [];
    return [{
      id: cp.id,
      base_ccy: cp.base_ccy,
      quote_ccy: cp.quote_ccy,
      quote_mode: pp.quote_mode as PairInfo['quote_mode'],
    }];
  });

  const { data: currentRows } = await sb
    .from('v_current_rates')
    .select('currency_pair_id, partner_bid, partner_ask, size_status, min_size, max_size');

  const current: CurrentRow[] = (currentRows ?? []).map((r) => ({
    currency_pair_id: r.currency_pair_id as string,
    bid: r.partner_bid as string | null,
    ask: r.partner_ask as string | null,
    size_status: r.size_status as string,
    min_size: r.min_size as string | null,
    max_size: r.max_size as string | null,
  }));

  const { data: partner } = await sb
    .from('partners')
    .select('hard_ttl_minutes')
    .eq('id', principal.partnerId!)
    .maybeSingle();

  // §6.1: the partner's own last-known format, used as the placeholder.
  const { data: lastSub } = await sb
    .from('rate_submissions')
    .select('raw_input')
    .not('raw_input', 'is', null)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pairs.length === 0) {
    // §16.1 "Partner home, no pairs yet": explain who adds the first pair.
    return (
      <AppShell principal={principal} title="Submit rates">
        <div className="mt-6 rounded border px-4 py-6"
             style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <p className="font-medium">No currency pairs are set up for you yet.</p>
          <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
            The MetaComp backbone team adds your first pair. Contact your relationship manager
            and they will arrange it.
          </p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell principal={principal} title="Submit rates">
      <SubmitGrid
        pairs={pairs}
        current={current}
        defaultValidHours={Math.round((partner?.hard_ttl_minutes ?? 480) / 60)}
        lastRaw={(lastSub?.raw_input as string | null) ?? null}
      />
    </AppShell>
  );
}
