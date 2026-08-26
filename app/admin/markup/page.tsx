import Decimal from 'decimal.js';
import { requireStaff } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { AppShell } from '@/components/AppShell';
import { ActionForm, Field } from '@/components/ActionForm';
import { sgt } from '@/components/fmt';
import { applyMarkup } from '@/src/domain/rates';
import { createMarkupVersion } from '../actions';
import { RetireButton } from './RetireButton';

export const dynamic = 'force-dynamic';

/**
 * §16.3 /admin/markup. Admin only for writes.
 *
 * "Create version: the four values plus a mandatory reason, admin only, with
 *  the previous version shown for comparison and A PREVIEW OF THE CLIENT RATE
 *  at the new default against the current best partner rate."
 *
 * The preview is the part that matters. A markup is four abstract numbers
 * until you see what it does to a real price, and §15.1 warns that getting the
 * direction wrong makes half of all quotes wrong in the client's favour. The
 * preview shows BOTH sides, so a mistake is visible rather than inferred.
 */
export default async function MarkupPage() {
  const principal = await requireStaff(['rm_viewer', 'backbone_operator', 'backbone_admin']);
  const isAdmin = principal.staffRole === 'backbone_admin';
  const sb = await supabaseServer();

  const [{ data: pairs }, { data: versions }, { data: current }] = await Promise.all([
    sb.from('currency_pairs').select('id, base_ccy, quote_ccy').eq('active', true).order('base_ccy'),
    sb.from('markup_versions').select('*').order('created_at', { ascending: false }),
    sb.from('v_current_rates').select('currency_pair_id, partner_bid, partner_ask, status'),
  ]);

  // Best current partner rate per pair, for the preview.
  const best = new Map<string, { bid: string | null; ask: string | null }>();
  for (const r of current ?? []) {
    if (r.status !== 'live' && r.status !== 'expiring') continue;
    const key = r.currency_pair_id as string;
    const prev = best.get(key);
    const bid = r.partner_bid as string | null;
    const ask = r.partner_ask as string | null;
    if (!prev) { best.set(key, { bid, ask }); continue; }
    best.set(key, {
      bid: bid && (!prev.bid || new Decimal(bid).greaterThan(prev.bid)) ? bid : prev.bid,
      ask: ask && (!prev.ask || new Decimal(ask).lessThan(prev.ask)) ? ask : prev.ask,
    });
  }

  return (
    <AppShell principal={principal} title="Markup">
      <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
        One active version per pair. Every change is a new immutable version with an audit
        event — nothing is edited in place, so the version that priced any past quote can
        always be recovered.
      </p>

      <div className="mt-6 space-y-8">
        {(pairs ?? []).map((pair) => {
          const pairId = pair.id as string;
          const all = (versions ?? []).filter((v) => v.currency_pair_id === pairId);
          const active = all.find((v) => v.status === 'active');
          const history = all.filter((v) => v.status !== 'active');
          const b = best.get(pairId);

          const preview = active && (b?.bid || b?.ask)
            ? applyMarkup(b.bid ?? null, b.ask ?? null, String(active.default_bps))
            : null;

          return (
            <section key={pairId} className="rounded border p-4"
                     style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
              <h2 className="num text-base font-semibold">{pair.base_ccy}/{pair.quote_ccy}</h2>

              {active ? (
                <div className="mt-2 flex flex-wrap items-start gap-x-10 gap-y-3 text-sm">
                  <div>
                    <div className="text-xs" style={{ color: 'var(--muted)' }}>Active version</div>
                    <div className="num">
                      default <strong>{String(active.default_bps)}</strong> bps,
                      band {String(active.min_bps)}–{String(active.max_bps)}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--muted)' }}>
                      {sgt(active.created_at as string)} · {String(active.reason)}
                    </div>
                  </div>

                  {preview && (
                    <div>
                      <div className="text-xs" style={{ color: 'var(--muted)' }}>
                        At the default, against the best current partner rate
                      </div>
                      <div className="num">
                        Client sells {pair.base_ccy}:{' '}
                        {b?.bid ? <>{b.bid} &rarr; <strong>{preview.clientBid}</strong></> : '—'}
                      </div>
                      <div className="num">
                        Client buys {pair.base_ccy}:{' '}
                        {b?.ask ? <>{b.ask} &rarr; <strong>{preview.clientAsk}</strong></> : '—'}
                      </div>
                      <div className="text-xs" style={{ color: 'var(--muted)' }}>
                        Both sides move away from the partner price.
                      </div>
                    </div>
                  )}

                  {isAdmin && (
                    <RetireButton id={active.id as string} pair={`${pair.base_ccy}/${pair.quote_ccy}`} />
                  )}
                </div>
              ) : (
                <p className="mt-2 text-sm">
                  <span className="status status-expired">no active markup</span>
                  <span className="ml-2" style={{ color: 'var(--muted)' }}>
                    The board withholds every row for this pair until a version exists.
                  </span>
                </p>
              )}

              {isAdmin && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm font-medium">
                    Create a new version
                  </summary>
                  <div className="mt-3 max-w-md">
                    <ActionForm action={createMarkupVersion} submitLabel="Create version">
                      <input type="hidden" name="pair_id" value={pairId} />
                      <Field label="Default (bps)" name="default_bps" required mono
                             defaultValue={active ? String(active.default_bps) : ''} />
                      <Field label="Minimum (bps)" name="min_bps" required mono
                             defaultValue={active ? String(active.min_bps) : '0'} />
                      <Field label="Maximum (bps)" name="max_bps" required mono
                             defaultValue={active ? String(active.max_bps) : ''}
                             hint="An RM may adjust only within this band." />
                      <Field label="Reason" name="reason" required
                             hint="Mandatory. It becomes the version history." />
                    </ActionForm>
                    <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
                      Creating a version retires the current one in the same transaction.
                    </p>
                  </div>
                </details>
              )}

              {history.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm" style={{ color: 'var(--muted)' }}>
                    Version history ({history.length})
                  </summary>
                  <ul className="num mt-2 space-y-1 text-xs">
                    {history.map((v) => (
                      <li key={v.id as string}>
                        {String(v.default_bps)} bps [{String(v.min_bps)}–{String(v.max_bps)}] ·
                        created {sgt(v.created_at as string)} ·
                        retired {sgt(v.retired_at as string)} · {String(v.reason)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          );
        })}
      </div>

      {(pairs ?? []).length === 0 && (
        <p className="mt-6 text-sm" style={{ color: 'var(--muted)' }}>
          No currency pairs are registered yet.
        </p>
      )}
    </AppShell>
  );
}
