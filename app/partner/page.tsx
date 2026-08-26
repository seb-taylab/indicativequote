import { requirePartner } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { AppShell } from '@/components/AppShell';
import { age, band, dec, sgt } from '@/components/fmt';

export const dynamic = 'force-dynamic';

/**
 * §5: "/partner -- home: pairs, last submission, what is expiring."
 *
 * The point of this page is the third of those. §2 names the risk that decides
 * the outcome: partners do not keep rates current, RMs find stale data, and
 * they revert to asking backbone. So what is expiring goes first and is stated
 * in plain words, not left for the partner to work out from timestamps.
 */
export default async function PartnerHome() {
  const principal = await requirePartner(['partner_user', 'partner_admin']);
  const sb = await supabaseServer();

  const { data: rows } = await sb
    .from('v_current_rates')
    .select('id, base_ccy, quote_ccy, partner_bid, partner_ask, size_status, min_size, max_size, submitted_at, valid_until, expiry_warning_at, status')
    .order('valid_until');

  const { data: pairs } = await sb
    .from('partner_pairs')
    .select('id, active, quote_mode, currency_pairs(base_ccy, quote_ccy)')
    .eq('active', true);

  const current = rows ?? [];
  const needsAttention = current.filter((r) => r.status === 'expiring' || r.status === 'expired');
  const lastSubmitted = current.reduce<string | null>(
    (acc, r) => (!acc || r.submitted_at > acc ? (r.submitted_at as string) : acc),
    null,
  );

  return (
    <AppShell principal={principal} title={principal.partnerName ?? 'Your rates'}>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <section className="rounded border p-4" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <h2 className="text-sm font-semibold">Needs attention</h2>
          {needsAttention.length === 0 ? (
            <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
              Nothing is expiring. Every current rate is live.
            </p>
          ) : (
            <ul className="mt-2 space-y-2 text-sm">
              {needsAttention.map((r) => (
                <li key={r.id as string}>
                  <span className="num font-medium">{r.base_ccy}/{r.quote_ccy}</span>{' '}
                  <span className={`status ${r.status === 'expired' ? 'status-expired' : 'status-expiring'}`}>
                    {r.status}
                  </span>
                  <div className="num text-xs" style={{ color: 'var(--muted)' }}>
                    valid until {sgt(r.valid_until as string)}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <a href="/partner/submit" className="mt-3 inline-block text-sm" style={{ color: 'var(--accent)' }}>
            Re-send your rates &rarr;
          </a>
        </section>

        <section className="rounded border p-4" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <h2 className="text-sm font-semibold">Last submission</h2>
          <p className="num mt-2 text-sm">
            {lastSubmitted ? `${sgt(lastSubmitted)} (${age(lastSubmitted)})` : 'No rates submitted yet'}
          </p>
          <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
            Re-sending the same numbers renews their validity — it is not discarded as
            &ldquo;no change&rdquo;.
          </p>
        </section>

        <section className="rounded border p-4" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <h2 className="text-sm font-semibold">Your pairs</h2>
          {(pairs ?? []).length === 0 ? (
            <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
              None yet. The MetaComp backbone team adds your first pair — contact your
              relationship manager.
            </p>
          ) : (
            <ul className="num mt-2 space-y-1 text-sm">
              {(pairs ?? []).map((p) => {
                const cp = p.currency_pairs as unknown as { base_ccy: string; quote_ccy: string } | null;
                return (
                  <li key={p.id as string}>
                    {cp?.base_ccy}/{cp?.quote_ccy}
                    {p.quote_mode !== 'two_way' && (
                      <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                        {String(p.quote_mode).replace('_', ' ')}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Current rates</h2>
        {current.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            You have no current rates on the board.
          </p>
        ) : (
          <div className="table-scroll mt-2">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr style={{ borderBottom: `2px solid var(--border)` }}>
                  <th scope="col" className="px-2 py-2 text-left">Pair</th>
                  <th scope="col" className="px-2 py-2 text-right">Bid</th>
                  <th scope="col" className="px-2 py-2 text-right">Ask</th>
                  <th scope="col" className="px-2 py-2 text-left">Size band</th>
                  <th scope="col" className="px-2 py-2 text-left">Submitted</th>
                  <th scope="col" className="px-2 py-2 text-left">Expires</th>
                  <th scope="col" className="px-2 py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {current.map((r) => (
                  <tr key={r.id as string} style={{ borderBottom: `1px solid var(--border)` }}>
                    <td className="num px-2 py-2">{r.base_ccy}/{r.quote_ccy}</td>
                    <td className="num px-2 py-2 text-right">{dec(r.partner_bid as string | null)}</td>
                    <td className="num px-2 py-2 text-right">{dec(r.partner_ask as string | null)}</td>
                    <td className="num px-2 py-2">
                      {band(r.size_status as string, r.min_size as string | null, r.max_size as string | null)}
                    </td>
                    <td className="num px-2 py-2">{sgt(r.submitted_at as string)}</td>
                    <td className="num px-2 py-2">{sgt(r.valid_until as string)}</td>
                    <td className="px-2 py-2">
                      <span className={`status ${
                        r.status === 'live' ? 'status-live'
                        : r.status === 'expiring' ? 'status-expiring'
                        : r.status === 'expired' ? 'status-expired' : 'status-neutral'
                      }`}>{r.status as string}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AppShell>
  );
}
