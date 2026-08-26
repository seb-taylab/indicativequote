import { sgt } from '@/components/fmt';

export interface JobHealth {
  job: string;
  last_run_at: string | null;
  last_run_ok: boolean | null;
  last_run_rows: number | null;
  overdue: boolean;
  retained_raw_inputs: number;
  purged_to_date: number;
}

/**
 * §18.4 retention, surfaced where an operator actually looks.
 *
 * The purge function existed from 0020 and nothing called it, so the guarantee
 * §21.2 lists — "raw_input older than 90 days is nulled and stamped" — was
 * simply false. A scheduled job nobody can see is the same failure one step
 * later: it stops, and the first anyone knows is a data-protection review.
 *
 * §18.2 alerts when the purge "did not run in 25 hours". That is `overdue`
 * here, and it is stated in words rather than left to be inferred from a
 * timestamp, because the point of this panel is to be readable at a glance by
 * someone who is not thinking about retention today.
 */
export function RetentionPanel({ job }: { job: JobHealth | null }) {
  if (!job) {
    return (
      <section className="mt-8">
        <h2 className="text-sm font-semibold">Retention</h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          Retention status unavailable.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold">Retention</h2>

      <p className="mt-2 text-sm">
        <span className={`status ${job.overdue ? 'status-expired' : 'status-live'}`}>
          {job.overdue ? 'overdue' : 'on schedule'}
        </span>{' '}
        <span className="num">
          {job.last_run_at ? `last purge ${sgt(job.last_run_at)}` : 'the purge has never run'}
        </span>
      </p>

      {job.last_run_ok === false && (
        <p role="alert" className="mt-1 text-sm" style={{ color: 'var(--expired)' }}>
          The last purge run failed. Raw partner text is being retained past 90 days.
        </p>
      )}

      <p className="num mt-1 text-sm" style={{ color: 'var(--muted)' }}>
        {job.retained_raw_inputs} submission{job.retained_raw_inputs === 1 ? '' : 's'} still
        holding raw text &middot; {job.purged_to_date} purged to date
      </p>

      <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
        A partner&rsquo;s pasted text may carry greetings, names or unrelated content. It is kept
        for 90 days to settle a dispute over a live rate, then nulled and stamped &mdash; the
        stamp is what distinguishes deleted text from a submission that never had any.
      </p>
    </section>
  );
}
