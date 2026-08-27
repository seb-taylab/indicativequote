import { sgt } from '@/components/fmt';

export interface Signal {
  key: string;
  label: string;
  definition: string;
  threshold: string;
  action: string;
  observable: boolean;
  value?: number | string | null;
  breached?: boolean;
  subject?: string | null;
  note?: string;
}

/**
 * §18.2, which existed only as a table in the specification. One of its seven
 * rows had been implemented -- the purge job's 25-hour check, in 0024.
 *
 * The row that matters most here is sign-in denials. §19/TM12 makes the
 * sign-in response byte-identical whether an address is known, unknown or
 * revoked, which is the right defence against enumeration and also means an
 * enumeration attempt is invisible from the application BY DESIGN. This count
 * is the compensating control; without it the byte-identical response is a
 * blindfold rather than a defence.
 *
 * Two signals cannot be answered from the database -- RPC error rate and board
 * latency are properties of the edge. They are shown anyway, marked as measured
 * elsewhere and naming where. A panel that silently listed the five it could
 * answer would read as "all clear" -- the same failure N8 records for a suite
 * that quietly skips.
 */
export function MonitoringPanel({ signals }: { signals: Signal[] | null }) {
  if (!signals || signals.length === 0) {
    return (
      <section className="mt-8">
        <h2 className="text-sm font-semibold">Monitoring (§18.2)</h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          Monitoring signals unavailable.
        </p>
      </section>
    );
  }

  const breached = signals.filter((s) => s.observable && s.breached);
  const elsewhere = signals.filter((s) => !s.observable);

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold">Monitoring (§18.2)</h2>

      {/*
        Stated in words, not inferred from a row colour. §16.2: status is never
        encoded by colour alone, and this panel is read by someone who is not
        thinking about monitoring today.
      */}
      <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
        {breached.length === 0
          ? `No threshold breached. ${elsewhere.length} of ${signals.length} signals are measured outside the database — see below.`
          : `${breached.length} threshold${breached.length === 1 ? '' : 's'} breached.`}
      </p>

      <div className="table-scroll mt-3">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Monitoring signals, their thresholds, current values and whether each is breached
          </caption>
          <thead>
            <tr style={{ borderBottom: `2px solid var(--border)` }}>
              <th scope="col" className="px-2 py-2 text-left">Signal</th>
              <th scope="col" className="px-2 py-2 text-right">Now</th>
              <th scope="col" className="px-2 py-2 text-left">Threshold</th>
              <th scope="col" className="px-2 py-2 text-left">State</th>
              <th scope="col" className="px-2 py-2 text-left">Action</th>
            </tr>
          </thead>
          <tbody>
            {signals.map((s) => (
              <tr key={s.key} style={{ borderBottom: `1px solid var(--border)` }}>
                <th scope="row" className="px-2 py-2 text-left font-medium">
                  {s.label}
                  <span className="block text-xs font-normal" style={{ color: 'var(--muted)' }}>
                    {s.definition}
                    {s.subject && s.breached ? ` — worst: ${s.subject}` : ''}
                  </span>
                </th>
                <td className="num px-2 py-2 text-right">{renderValue(s)}</td>
                <td className="px-2 py-2">{s.threshold}</td>
                <td className="px-2 py-2">
                  {!s.observable ? (
                    <span className="status status-neutral">measured elsewhere</span>
                  ) : s.breached ? (
                    <span className="status status-bad">breached</span>
                  ) : (
                    <span className="status status-ok">within threshold</span>
                  )}
                </td>
                <td className="px-2 py-2" style={{ color: 'var(--muted)' }}>
                  {s.observable ? s.action : s.note}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * A signal measured elsewhere has no value, and an em dash says so honestly.
 * Rendering a 0 there would be a lie an operator could act on.
 */
function renderValue(s: Signal) {
  if (!s.observable || s.value === null || s.value === undefined) return '—';
  // purge_job carries a timestamp rather than a count.
  if (typeof s.value === 'string' && s.value.includes('T')) return sgt(s.value);
  return String(s.value);
}
