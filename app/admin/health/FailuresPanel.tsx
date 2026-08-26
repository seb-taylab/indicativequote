import { sgt } from '@/components/fmt';

export interface PartnerFailures {
  partner_id: string;
  partner_name: string;
  failures: number;
  in_last_hour: number;
  last_at: string;
  reasons: string[] | null;
}

/**
 * §9's "recent failures", which until now could not be built.
 *
 * §6.4 makes a submission atomic, so a batch that fails validation is
 * discarded whole and leaves no envelope — `error_count` could only ever be 0.
 * The signal an operator most needs was the one the table could not hold
 * (F10). These rows come from `submission_failures`, written by a separate
 * transaction after the failure has already rolled back.
 *
 * §18.2 alerts on "more than 2 for one partner in an hour", so that count is
 * shown as its own figure rather than left to be worked out from a list — and
 * §2 explains why it earns the space: "a partner hitting errors silently stops
 * using the product". A partner failing repeatedly is not a log line, it is an
 * account about to go quiet.
 */
export function FailuresPanel({ failures }: { failures: PartnerFailures[] }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold">Recent submission failures</h2>

      {failures.length === 0 ? (
        <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          No failed submissions in the last 24 hours.
        </p>
      ) : (
        <ul className="mt-2 space-y-3">
          {failures.map((f) => {
            // §18.2's threshold, stated rather than implied.
            const alerting = f.in_last_hour > 2;
            return (
              <li
                key={f.partner_id}
                className="rounded border px-3 py-2"
                style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{f.partner_name}</span>
                  <span className={`status ${alerting ? 'status-expired' : 'status-expiring'}`}>
                    {f.failures} in 24h
                  </span>
                  {alerting && (
                    <span className="status status-expired">
                      {f.in_last_hour} in the last hour
                    </span>
                  )}
                  <span className="num text-xs" style={{ color: 'var(--muted)' }}>
                    last {sgt(f.last_at)}
                  </span>
                </div>

                {f.reasons && f.reasons.length > 0 && (
                  // §9: "with the reasons". An operator cannot help a partner
                  // without knowing what they were told.
                  <ul className="mt-1 space-y-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                    {f.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                )}

                {alerting && (
                  <p className="mt-1 text-xs" style={{ color: 'var(--expired)' }}>
                    Above the alert threshold. This partner may be about to stop trying.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
        A failed submission is discarded whole, so these are recorded separately from
        submissions themselves. No pasted text and no rate values are kept here.
      </p>
    </section>
  );
}
