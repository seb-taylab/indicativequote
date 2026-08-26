import { requireStaff } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { AppShell } from '@/components/AppShell';
import { age, sgt } from '@/components/fmt';

export const dynamic = 'force-dynamic';

interface HealthRow {
  partner_id: string;
  partner_name: string;
  partner_status: string;
  pair: string;
  partner_pair_id: string;
  current_rates: number;
  last_submission_at: string | null;
  soonest_expiry: string | null;
  state:
    | 'healthy' | 'missing' | 'expired' | 'expiring'
    | 'unconfirmed_convention' | 'no_active_markup' | 'partner_inactive';
}

const LABEL: Record<HealthRow['state'], string> = {
  healthy: 'healthy',
  missing: 'missing',
  expired: 'expired',
  expiring: 'expiring',
  unconfirmed_convention: 'convention not confirmed',
  no_active_markup: 'no active markup',
  partner_inactive: 'partner inactive',
};

const CLS: Record<HealthRow['state'], string> = {
  healthy: 'status-live',
  missing: 'status-expired',
  expired: 'status-expired',
  expiring: 'status-expiring',
  unconfirmed_convention: 'status-neutral',
  no_active_markup: 'status-neutral',
  partner_inactive: 'status-neutral',
};

/**
 * §9. "The page states the count of partner-pairs in each state at the top,
 *  and lists them beneath. A partner is 'healthy' only when EVERY active pair
 *  is healthy."
 *
 * Which is why the summary counts partner-PAIRS, never partners: a partner
 * with one fresh pair and five expired ones is not 60 per cent healthy, and a
 * partner-level number would say it was.
 */
export default async function HealthPage() {
  const principal = await requireStaff(['backbone_operator', 'backbone_admin']);
  const sb = await supabaseServer();

  const { data, error } = await sb.rpc('partner_health');

  if (error) {
    return (
      <AppShell principal={principal} title="Coverage health">
        <div role="alert" className="mt-6 rounded border px-4 py-3"
             style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <p className="font-medium">Health could not be loaded.</p>
          <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>{error.message}</p>
        </div>
      </AppShell>
    );
  }

  const result = data as unknown as {
    counts: Record<string, number>;
    partner_pairs: HealthRow[];
    recent_failures: Array<{ submission_id: string; submitted_at: string; error_count: number }>;
  };

  // Worst first: an operator opens this page to find what is broken.
  const ORDER: HealthRow['state'][] = [
    'missing', 'expired', 'expiring', 'unconfirmed_convention',
    'no_active_markup', 'partner_inactive', 'healthy',
  ];
  const rows = [...result.partner_pairs].sort(
    (a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state)
      || a.partner_name.localeCompare(b.partner_name),
  );

  return (
    <AppShell principal={principal} title="Coverage health">
      <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
        Per partner-pair. A partner is healthy only when every active pair of theirs is.
      </p>

      <div className="mt-4 flex flex-wrap gap-3">
        {ORDER.filter((s) => result.counts[s]).map((s) => (
          <div key={s} className="rounded border px-3 py-2"
               style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
            <div className="num text-xl font-semibold">{result.counts[s]}</div>
            <div className="text-xs" style={{ color: 'var(--muted)' }}>{LABEL[s]}</div>
          </div>
        ))}
      </div>

      <div className="table-scroll mt-6">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr style={{ borderBottom: `2px solid var(--border)` }}>
              <th scope="col" className="px-2 py-2 text-left">Partner</th>
              <th scope="col" className="px-2 py-2 text-left">Pair</th>
              <th scope="col" className="px-2 py-2 text-left">State</th>
              <th scope="col" className="px-2 py-2 text-right">Current rows</th>
              <th scope="col" className="px-2 py-2 text-left">Last submission</th>
              <th scope="col" className="px-2 py-2 text-left">Soonest expiry</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.partner_pair_id} style={{ borderBottom: `1px solid var(--border)` }}>
                <td className="px-2 py-2 font-medium">{r.partner_name}</td>
                <td className="num px-2 py-2">{r.pair}</td>
                <td className="px-2 py-2">
                  <span className={`status ${CLS[r.state]}`}>{LABEL[r.state]}</span>
                </td>
                <td className="num px-2 py-2 text-right">{r.current_rates}</td>
                <td className="num px-2 py-2">
                  {r.last_submission_at ? `${sgt(r.last_submission_at)} (${age(r.last_submission_at)})` : '—'}
                </td>
                <td className="num px-2 py-2">{sgt(r.soonest_expiry)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Recent submission failures</h2>
        {result.recent_failures.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            None recorded in the last 24 hours.{' '}
            <span title="See docs/spec-findings.md F10">
              Note: a submission that fails validation is discarded whole and leaves no row,
              so this panel cannot yet show partners bouncing off errors.
            </span>
          </p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {result.recent_failures.map((f) => (
              <li key={f.submission_id} className="num">
                {sgt(f.submitted_at)} — {f.error_count} error{f.error_count === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
