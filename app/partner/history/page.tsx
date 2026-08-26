import { requirePartner } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { AppShell } from '@/components/AppShell';
import { band, dec, sgt } from '@/components/fmt';

export const dynamic = 'force-dynamic';

/**
 * §5: "/partner/history -- own submissions, read only."
 *
 * Rates are append-only and never deleted, so this is the full record: every
 * row a partner has ever submitted, including the superseded, the corrected
 * and the withdrawn. That is the point -- it is what a dispute is settled
 * against.
 */
export default async function HistoryPage() {
  const principal = await requirePartner(['partner_user', 'partner_admin']);
  const sb = await supabaseServer();

  // §12.7: v_rate_history emits decimals as text. Reading `rates` directly
  // would deliver them as JSON numbers, i.e. as binary doubles.
  const { data: rates } = await sb
    .from('v_rate_history')
    .select(`
      id, partner_bid, partner_ask, size_status, min_size, max_size,
      observed_at, submitted_at, valid_until, superseded_at, withdrawn_at,
      withdrawn_reason, correction_of, normalised_from_inverse,
      base_ccy, quote_ccy, lifecycle
    `)
    .order('submitted_at', { ascending: false })
    .limit(200);

  const rows = rates ?? [];

  return (
    <AppShell principal={principal} title="Submission history">
      {rows.length === 0 ? (
        <p className="mt-6 text-sm" style={{ color: 'var(--muted)' }}>
          You have not submitted any rates yet.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            Every row you have submitted, most recent first. Rates are never deleted — a
            correction or a withdrawal adds to this record rather than changing it.
          </p>
          <div className="table-scroll mt-4">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr style={{ borderBottom: `2px solid var(--border)` }}>
                  <th scope="col" className="px-2 py-2 text-left">Pair</th>
                  <th scope="col" className="px-2 py-2 text-right">Bid</th>
                  <th scope="col" className="px-2 py-2 text-right">Ask</th>
                  <th scope="col" className="px-2 py-2 text-left">Size band</th>
                  <th scope="col" className="px-2 py-2 text-left">Submitted</th>
                  <th scope="col" className="px-2 py-2 text-left">Valid until</th>
                  <th scope="col" className="px-2 py-2 text-left">State</th>
                  <th scope="col" className="px-2 py-2 text-left">Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const life = {
                    label: r.lifecycle as string,
                    cls:
                      r.lifecycle === 'withdrawn' ? 'status-expired'
                      : r.lifecycle === 'superseded' ? 'status-neutral'
                      : r.lifecycle === 'expired' ? 'status-expired'
                      : 'status-live',
                  };
                  return (
                    <tr key={r.id as string} style={{ borderBottom: `1px solid var(--border)` }}>
                      <td className="num px-2 py-2">{r.base_ccy as string}/{r.quote_ccy as string}</td>
                      <td className="num px-2 py-2 text-right">{dec(r.partner_bid as string | null)}</td>
                      <td className="num px-2 py-2 text-right">{dec(r.partner_ask as string | null)}</td>
                      <td className="num px-2 py-2">
                        {band(r.size_status as string, r.min_size as string | null, r.max_size as string | null)}
                      </td>
                      <td className="num px-2 py-2">{sgt(r.submitted_at as string)}</td>
                      <td className="num px-2 py-2">{sgt(r.valid_until as string)}</td>
                      <td className="px-2 py-2">
                        <span className={`status ${life.cls}`}>{life.label}</span>
                      </td>
                      <td className="px-2 py-2 text-xs" style={{ color: 'var(--muted)' }}>
                        {r.correction_of ? 'correction' : null}
                        {r.normalised_from_inverse ? ' normalised from inverse' : null}
                        {r.withdrawn_reason ? ` ${r.withdrawn_reason}` : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </AppShell>
  );
}
