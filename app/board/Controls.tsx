'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { MarkupVersion, PairOption } from './types';

/**
 * §7, one row of controls.
 *
 * Direction is stated in CLIENT-ACTION language. "The words bid and ask never
 * appear as a control label."
 *
 * The amount is always the pair's BASE currency (D9), shown as a fixed suffix
 * rather than a selector -- there is no amount-currency choice to get wrong,
 * and so no cross-currency conversion anywhere in this application.
 */
export function Controls({
  pairs,
  pairId,
  direction,
  amount,
  markupBps,
  markupVersion,
}: {
  pairs: PairOption[];
  pairId: string;
  direction: string;
  amount: string;
  markupBps: string;
  markupVersion: MarkupVersion | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [amountDraft, setAmountDraft] = useState(amount);
  const [amountError, setAmountError] = useState<string | null>(null);

  const pair = pairs.find((p) => p.id === pairId);

  function push(next: Record<string, string>) {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    router.push(`/board?${q.toString()}`);
  }

  function commitAmount() {
    const trimmed = amountDraft.trim();
    if (trimmed === '') {
      setAmountError(null);
      push({ amount: '' });
      return;
    }
    // §12.7: "The amount an RM types is the one number that enters as user
    // text; it is validated as a decimal string and sent as one." Never
    // Number() or parseFloat.
    if (!/^\d{1,15}(\.\d{1,6})?$/.test(trimmed.replace(/,/g, ''))) {
      setAmountError('Enter a plain amount, digits only.');
      return;
    }
    setAmountError(null);
    push({ amount: trimmed.replace(/,/g, '') });
  }

  return (
    <div className="flex flex-wrap items-end gap-4">
      <div>
        <label htmlFor="pair" className="block text-xs font-medium">Pair</label>
        <select
          id="pair"
          value={pairId}
          onChange={(e) => push({ pair: e.target.value })}
          className="num mt-1 rounded border px-2 py-1.5"
          style={{ borderColor: 'var(--control-border)', background: 'var(--bg)', color: 'var(--text)' }}
        >
          {pairs.map((p) => (
            <option key={p.id} value={p.id}>{p.base_ccy}/{p.quote_ccy}</option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="direction" className="block text-xs font-medium">Direction</label>
        <select
          id="direction"
          value={direction}
          onChange={(e) => push({ direction: e.target.value })}
          className="mt-1 rounded border px-2 py-1.5"
          style={{ borderColor: 'var(--control-border)', background: 'var(--bg)', color: 'var(--text)' }}
        >
          <option value="client_sells_base">Client sells {pair?.base_ccy ?? 'base'}</option>
          <option value="client_buys_base">Client buys {pair?.base_ccy ?? 'base'}</option>
        </select>
      </div>

      <div>
        <label htmlFor="amount" className="block text-xs font-medium">
          Amount <span style={{ color: 'var(--muted)' }}>(optional)</span>
        </label>
        {/* This wrapper carries the amount field's visible boundary -- the
            input inside it is borderless so the currency suffix sits flush --
            so it takes the control token, not the decorative one (WCAG 1.4.11). */}
        <div className="focus-ring-within mt-1 flex items-center rounded border" style={{ borderColor: 'var(--control-border)' }}>
          <input
            id="amount"
            inputMode="decimal"
            value={amountDraft}
            onChange={(e) => setAmountDraft(e.target.value)}
            onBlur={commitAmount}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitAmount(); } }}
            aria-describedby={amountError ? 'amount-error' : undefined}
            aria-invalid={amountError ? true : undefined}
            className="num w-40 bg-transparent px-2 py-1.5 outline-none"
            /* The wrapper shows the focus ring via :focus-within, so suppressing
               it on the input itself does not lose the indicator (WCAG 2.4.7). */
            style={{ color: 'var(--text)' }}
          />
          {/* D9: a fixed suffix, never a selector. */}
          <span className="num px-2 text-sm" style={{ color: 'var(--muted)' }}>
            {pair?.base_ccy ?? ''}
          </span>
        </div>
        {amountError && (
          <p id="amount-error" role="alert" className="mt-1 text-xs" style={{ color: 'var(--expired)' }}>
            {amountError}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="markup" className="block text-xs font-medium">
          Markup (bps)
          {markupVersion && (
            <span className="num ml-1 font-normal" style={{ color: 'var(--muted)' }}>
              {markupVersion.min_bps}–{markupVersion.max_bps}
            </span>
          )}
        </label>
        <input
          id="markup"
          inputMode="decimal"
          defaultValue={markupBps}
          disabled={!markupVersion}
          onBlur={(e) => push({ markup: e.target.value.trim() })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); push({ markup: e.currentTarget.value.trim() }); }
          }}
          className="num mt-1 w-28 rounded border px-2 py-1.5 disabled:opacity-50"
          style={{ borderColor: 'var(--control-border)', background: 'var(--bg)', color: 'var(--text)' }}
        />
      </div>
    </div>
  );
}
