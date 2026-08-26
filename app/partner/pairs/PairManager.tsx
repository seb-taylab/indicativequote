'use client';

import { useState, useTransition } from 'react';
import { addPair, setPairActive, setQuoteMode } from './actions';

export interface OwnPair {
  id: string;
  active: boolean;
  quote_mode: string;
  base_ccy: string;
  quote_ccy: string;
}

export interface AvailablePair {
  id: string;
  base_ccy: string;
  quote_ccy: string;
}

const MODES = [
  { value: 'two_way', label: 'Two-way — both sides, and only both' },
  { value: 'bid_only', label: 'Bid only — a bid alone' },
  { value: 'ask_only', label: 'Ask only — an ask alone' },
  { value: 'either_side', label: 'Either side — one side or both' },
];

export function PairManager({ own, available }: { own: OwnPair[]; available: AvailablePair[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [toAdd, setToAdd] = useState(available[0]?.id ?? '');

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? 'That did not work.');
    });
  }

  return (
    <div className="mt-6 space-y-8">
      {error && (
        <p role="alert" className="rounded border px-3 py-2 text-sm"
           style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--expired)' }}>
          {error}
        </p>
      )}

      <section>
        <h2 className="text-sm font-semibold">Your pairs</h2>
        {own.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            You have no pairs yet.
          </p>
        ) : (
          <div className="table-scroll mt-2">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr style={{ borderBottom: `2px solid var(--border)` }}>
                  <th scope="col" className="px-2 py-2 text-left">Pair</th>
                  <th scope="col" className="px-2 py-2 text-left">Quote mode</th>
                  <th scope="col" className="px-2 py-2 text-left">Status</th>
                  <th scope="col" className="px-2 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {own.map((p) => (
                  <tr key={p.id} style={{ borderBottom: `1px solid var(--border)` }}>
                    <td className="num px-2 py-2 font-medium">{p.base_ccy}/{p.quote_ccy}</td>
                    <td className="px-2 py-2">
                      <label className="sr-only" htmlFor={`mode-${p.id}`}>
                        Quote mode for {p.base_ccy}/{p.quote_ccy}
                      </label>
                      <select
                        id={`mode-${p.id}`}
                        defaultValue={p.quote_mode}
                        disabled={pending || !p.active}
                        onChange={(e) => run(() => setQuoteMode(p.id, e.target.value))}
                        className="rounded border px-1 py-1"
                        style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                      >
                        {MODES.map((m) => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-2">
                      <span className={`status ${p.active ? 'status-live' : 'status-neutral'}`}>
                        {p.active ? 'active' : 'inactive'}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <button
                        disabled={pending}
                        onClick={() => run(() => setPairActive(p.id, !p.active))}
                        className="rounded border px-2 py-1 text-xs"
                        style={{ borderColor: 'var(--border)' }}
                      >
                        {p.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
          Deactivating a pair does not withdraw its rates. They stop being quotable immediately
          and return, subject to their own expiry, if you reactivate it.
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold">Add a pair</h2>
        {available.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            Every registered pair is already on your book. New pairs are added to the canonical
            registry by MetaComp.
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="add-pair" className="block text-xs font-medium">Canonical pair</label>
              <select
                id="add-pair"
                value={toAdd}
                onChange={(e) => setToAdd(e.target.value)}
                className="num mt-1 rounded border px-2 py-1.5"
                style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
              >
                {available.map((p) => (
                  <option key={p.id} value={p.id}>{p.base_ccy}/{p.quote_ccy}</option>
                ))}
              </select>
            </div>
            <button
              disabled={pending || !toAdd}
              onClick={() => run(() => addPair(toAdd))}
              className="rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              Add pair
            </button>
          </div>
        )}
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
          Pairs come from the canonical registry in one approved orientation. If you quote the
          inverse, submit it as you normally would — it is normalised and shown to you for
          confirmation.
        </p>
      </section>
    </div>
  );
}
