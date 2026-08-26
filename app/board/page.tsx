import { Suspense } from 'react';
import { requireStaff } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { AppShell } from '@/components/AppShell';
import { BoardTable } from './BoardTable';
import { Controls } from './Controls';
import type { BoardResult, PairOption } from './types';

export const dynamic = 'force-dynamic';

/** §16.1: skeleton rows, never a spinner over an empty page. */
function BoardSkeleton() {
  return (
    <div className="mt-6 space-y-2" aria-hidden>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="skeleton h-9 rounded" />
      ))}
    </div>
  );
}

async function Board({
  pairId, direction, amount, markup,
}: { pairId: string; direction: string; amount: string; markup: string }) {
  const sb = await supabaseServer();

  const { data, error } = await sb.rpc('board_rates', {
    p_currency_pair_id: pairId,
    p_direction: direction,
    p_amount: amount || null,
    p_markup_bps: markup || null,
  });

  if (error) {
    // §16.1 RPC error: banner the failure and offer retry. There is no last
    // good result on a fresh server render, so say so plainly rather than
    // rendering an empty table that looks like "no rates".
    return (
      <div role="alert" className="mt-6 rounded border px-4 py-3"
           style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
        <p className="font-medium">The board could not be loaded.</p>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>{error.message}</p>
        <a href="/board" className="mt-2 inline-block text-sm" style={{ color: 'var(--accent)' }}>
          Try again
        </a>
      </div>
    );
  }

  const result = data as unknown as BoardResult;

  if (result.eligible.length === 0 && result.ineligible.length === 0) {
    // §16.1 empty state: name the partners who support the pair and when each
    // last submitted, rather than showing nothing.
    const { data: supporters } = await sb
      .from('v_current_rates')
      .select('partner_name, submitted_at')
      .eq('currency_pair_id', pairId)
      .order('submitted_at', { ascending: false });

    return (
      <div className="mt-6 rounded border px-4 py-6"
           style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
        <p className="font-medium">No rates on the board for this pair.</p>
        {supporters && supporters.length > 0 ? (
          <ul className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            {supporters.map((s, i) => (
              <li key={i} className="num">
                {s.partner_name} — last submitted{' '}
                {new Intl.DateTimeFormat('en-GB', {
                  timeZone: 'Asia/Singapore', day: '2-digit', month: 'short',
                  hour: '2-digit', minute: '2-digit', hour12: false,
                }).format(new Date(s.submitted_at))} SGT
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
            No partner currently offers this pair.
          </p>
        )}
      </div>
    );
  }

  return <BoardTable result={result} />;
}

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ pair?: string; direction?: string; amount?: string; markup?: string }>;
}) {
  const principal = await requireStaff(['rm_viewer', 'backbone_operator', 'backbone_admin']);
  const sp = await searchParams;

  const sb = await supabaseServer();
  const { data: pairRows } = await sb
    .from('currency_pairs')
    .select('id, base_ccy, quote_ccy')
    .eq('active', true)
    .order('base_ccy');

  const pairs = (pairRows ?? []) as PairOption[];

  if (pairs.length === 0) {
    return (
      <AppShell principal={principal} title="Rate board">
        <div className="mt-6 rounded border px-4 py-6"
             style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <p className="font-medium">No currency pairs are registered yet.</p>
          <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
            A backbone admin registers the canonical pairs before rates can be posted.
          </p>
        </div>
      </AppShell>
    );
  }

  const pairId = sp.pair && pairs.some((p) => p.id === sp.pair) ? sp.pair : pairs[0]!.id;
  const direction =
    sp.direction === 'client_buys_base' ? 'client_buys_base' : 'client_sells_base';
  const amount = sp.amount ?? '';
  const markup = sp.markup ?? '';

  // The active version drives the control's band; board_rates re-checks it.
  const { data: mv } = await sb
    .from('markup_versions')
    .select('id, default_bps, min_bps, max_bps')
    .eq('currency_pair_id', pairId)
    .eq('status', 'active')
    .maybeSingle();

  return (
    <AppShell principal={principal} title="Rate board">
      <Controls
        pairs={pairs}
        pairId={pairId}
        direction={direction}
        amount={amount}
        markupBps={markup || (mv?.default_bps ?? '')}
        markupVersion={mv ?? null}
      />
      <Suspense key={`${pairId}-${direction}-${amount}-${markup}`} fallback={<BoardSkeleton />}>
        <Board pairId={pairId} direction={direction} amount={amount} markup={markup} />
      </Suspense>
    </AppShell>
  );
}
