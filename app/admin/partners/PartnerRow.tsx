'use client';

import { useState, useTransition } from 'react';
import { confirmConvention, setPartnerPolicy, setPartnerStatus } from '../actions';
import { ActionForm, Field } from '@/components/ActionForm';

export function PartnerRow({
  id, name, slug, status, pairCount, soft, hard, moveWarn, confirmedAt, confirmedRef, canAdmin,
}: {
  id: string; name: string; slug: string; status: string; pairCount: number;
  soft: number; hard: number; moveWarn: string;
  confirmedAt: string | null; confirmedRef: string | null; canAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [ref, setRef] = useState('');

  const active = status === 'active';

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? 'That did not work.');
    });
  }

  return (
    <>
      <tr style={{ borderBottom: `1px solid var(--border)` }}>
        <td className="px-2 py-2 font-medium">{name}</td>
        <td className="num px-2 py-2">{slug}</td>
        <td className="px-2 py-2">
          <span className={`status ${active ? 'status-live' : 'status-neutral'}`}>{status}</span>
        </td>
        <td className="num px-2 py-2 text-right">{pairCount}</td>
        <td className="num px-2 py-2">
          {soft}m soft / {hard}m hard / {moveWarn}%
        </td>
        <td className="px-2 py-2">
          {confirmedAt ? (
            <span className="status status-live">confirmed {confirmedAt}</span>
          ) : (
            // The [A-1] gate. This partner cannot reach the board at all.
            <span className="status status-expired">not confirmed</span>
          )}
        </td>
        <td className="px-2 py-2">
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
                  className="rounded border px-2 py-1 text-xs" style={{ borderColor: 'var(--border)' }}>
            {open ? 'Close' : 'Manage'}
          </button>
        </td>
      </tr>

      {open && (
        <tr style={{ borderBottom: `1px solid var(--border)` }}>
          <td colSpan={7} className="px-2 pb-4">
            {error && (
              <p role="alert" className="mb-3 text-sm" style={{ color: 'var(--expired)' }}>{error}</p>
            )}
            <div className="grid gap-6 lg:grid-cols-3">
              <div className="rounded border p-3" style={{ borderColor: 'var(--border)' }}>
                <h3 className="text-xs font-semibold uppercase">Validity policy</h3>
                <p className="mb-2 mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                  Applies to <strong>future submissions only</strong>. Every stored rate keeps
                  the stamps it was written with.
                </p>
                <ActionForm action={setPartnerPolicy} submitLabel="Update policy">
                  <input type="hidden" name="partner_id" value={id} />
                  <Field label="Soft TTL (minutes)" name="soft" type="number" defaultValue={soft} mono />
                  <Field label="Hard TTL (minutes)" name="hard" type="number" defaultValue={hard} mono />
                  <Field label="Large-move warning (%)" name="move_warn" defaultValue={moveWarn} mono />
                </ActionForm>
              </div>

              <div className="rounded border p-3" style={{ borderColor: 'var(--border)' }}>
                <h3 className="text-xs font-semibold uppercase">Bid/ask convention</h3>
                {confirmedAt ? (
                  <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                    Confirmed {confirmedAt}
                    {confirmedRef ? <> · reference <span className="num">{confirmedRef}</span></> : null}
                  </p>
                ) : (
                  <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                    Until this is confirmed <strong>in writing</strong>, this partner&rsquo;s rates
                    are stored but never usable. Confirming asserts that the lower of the two
                    numbers they send is their bid. If that is wrong, every price derived from
                    them inverts.
                  </p>
                )}
                {canAdmin ? (
                  <div className="mt-2 space-y-2">
                    <label htmlFor={`ref-${id}`} className="block text-xs font-medium">
                      Written confirmation reference
                    </label>
                    <input
                      id={`ref-${id}`}
                      value={ref}
                      onChange={(e) => setRef(e.target.value)}
                      placeholder="e.g. signed e-mail 2026-08-26"
                      className="w-full rounded border px-2 py-1.5 text-sm"
                      style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                    />
                    <button
                      disabled={pending || !ref.trim()}
                      onClick={() => run(() => confirmConvention(id, ref.trim()))}
                      className="rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                      style={{ background: 'var(--accent)' }}
                    >
                      {confirmedAt ? 'Re-confirm' : 'Confirm convention'}
                    </button>
                  </div>
                ) : (
                  <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
                    Only a backbone admin can confirm a convention.
                  </p>
                )}
              </div>

              <div className="rounded border p-3" style={{ borderColor: 'var(--border)' }}>
                <h3 className="text-xs font-semibold uppercase">Status</h3>
                <p className="mb-2 mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                  {active
                    ? 'Deactivating makes every one of this partner’s rates unavailable immediately. Reactivating does not resurrect expired rates.'
                    : 'Reactivating restores this partner’s pairs. Rates that have already expired stay expired.'}
                </p>
                <button
                  disabled={pending}
                  onClick={() => {
                    const msg = active
                      ? `Deactivate ${name}? Every rate they have posted becomes unavailable immediately.`
                      : `Reactivate ${name}?`;
                    if (window.confirm(msg)) {
                      run(() => setPartnerStatus(id, active ? 'inactive' : 'active'));
                    }
                  }}
                  className="rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  style={{ background: active ? 'var(--expired)' : 'var(--accent)' }}
                >
                  {active ? 'Deactivate partner' : 'Reactivate partner'}
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
