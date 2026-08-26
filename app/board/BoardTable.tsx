'use client';

import { useState } from 'react';
import { copyQuote } from './actions';
import { band, dec, sgt } from '@/components/fmt';
import type { BoardResult, BoardRow } from './types';

/** §16.2: status is never encoded by colour alone -- each carries its word. */
function Status({ value }: { value: BoardRow['status'] }) {
  const cls =
    value === 'live' ? 'status-live' : value === 'expiring' ? 'status-expiring' : 'status-expired';
  return <span className={`status ${cls}`}>{value}</span>;
}

export function BoardTable({ result }: { result: BoardResult }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function onCopy(row: BoardRow) {
    setBusy(row.rate_id);
    setCopyError(null);
    const res = await copyQuote(
      row.rate_id,
      result.direction,
      result.amount,
      result.markup_bps,
    );
    setBusy(null);
    if (!res.ok || !res.text) {
      setCopyError(res.error ?? 'Could not compose the quote.');
      return;
    }
    try {
      await navigator.clipboard.writeText(res.text);
      setCopied(row.rate_id);
      setTimeout(() => setCopied(null), 4000);
    } catch {
      // Clipboard denied. Show the text so the RM can copy it by hand rather
      // than losing the quote that has already been recorded.
      setCopyError(res.text);
    }
  }

  const hasAny = result.eligible.length > 0 || result.ineligible.length > 0;

  return (
    <>
      {!result.rankable && result.eligible.length === 0 && result.ineligible.length > 0 && (
        // §16.1 "No active markup": withhold every row, state why, link to the fix.
        <p role="status" className="mb-4 rounded border px-3 py-2 text-sm"
           style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          Nothing is quotable for this pair: there is no active markup version.{' '}
          <a href="/admin/markup" style={{ color: 'var(--accent)' }}>Set one on /admin/markup</a>.
        </p>
      )}

      {result.rankable === false && result.eligible.length > 0 && (
        // §15.2 rule 5: unranked and LABELLED. Never a rank badge on an
        // unordered list -- that is a false winner.
        <p role="status" className="mb-4 rounded border px-3 py-2 text-sm"
           style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          Shown <strong>unranked</strong> — ranking inputs are missing for this pair.
        </p>
      )}

      {copyError && (
        <div role="alert" className="mb-4 rounded border px-3 py-2 text-sm"
             style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <p className="font-medium">Copy the quote manually</p>
          <pre className="num mt-2 whitespace-pre-wrap text-xs">{copyError}</pre>
        </div>
      )}

      {!hasAny ? null : (
        <div className="table-scroll">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Partner rates for {result.currency_pair.base_ccy}/{result.currency_pair.quote_ccy},
              {result.direction === 'client_sells_base' ? ' client sells ' : ' client buys '}
              {result.currency_pair.base_ccy}
            </caption>
            <thead>
              <tr style={{ borderBottom: `2px solid var(--border)` }}>
                <th scope="col" className="px-2 py-2 text-left">#</th>
                <th scope="col" className="px-2 py-2 text-left">Partner</th>
                <th scope="col" className="px-2 py-2 text-right">Bid</th>
                <th scope="col" className="px-2 py-2 text-right">Ask</th>
                <th scope="col" className="px-2 py-2 text-right">Spread</th>
                <th scope="col" className="px-2 py-2 text-left">Size band</th>
                <th scope="col" className="px-2 py-2 text-right">Markup</th>
                <th scope="col" className="px-2 py-2 text-right">Client rate</th>
                {/* §7: the header changes with the direction, because the
                    client's position changes with it. */}
                <th scope="col" className="px-2 py-2 text-right">{result.amount_header}</th>
                <th scope="col" className="px-2 py-2 text-left">Submitted</th>
                <th scope="col" className="px-2 py-2 text-left">Expires</th>
                <th scope="col" className="px-2 py-2 text-left">Status</th>
                <th scope="col" className="px-2 py-2 text-left">Source</th>
                <th scope="col" className="px-2 py-2"><span className="sr-only">Copy quote</span></th>
              </tr>
            </thead>
            <tbody>
              {result.eligible.map((row) => (
                <tr key={row.rate_id} style={{ borderBottom: `1px solid var(--border)` }}>
                  <td className="num px-2 py-2">{result.rankable ? row.rank : '—'}</td>
                  <td className="px-2 py-2 font-medium">{row.partner_name}</td>
                  <td className="num px-2 py-2 text-right">{dec(row.partner_bid)}</td>
                  <td className="num px-2 py-2 text-right">{dec(row.partner_ask)}</td>
                  <td className="num px-2 py-2 text-right">{dec(row.spread)}</td>
                  <td className="num px-2 py-2">{band(row.size_status, row.min_size, row.max_size)}</td>
                  <td className="num px-2 py-2 text-right">{dec(row.markup_bps)} bps</td>
                  <td className="num px-2 py-2 text-right font-semibold">{dec(row.client_rate)}</td>
                  <td className="num px-2 py-2 text-right">{dec(row.counter_amount, { group: true, minDp: 2 })}</td>
                  <td className="num px-2 py-2">{sgt(row.submitted_at)}</td>
                  <td className="num px-2 py-2">{sgt(row.valid_until)}</td>
                  <td className="px-2 py-2"><Status value={row.status} /></td>
                  <td className="px-2 py-2">{row.source}</td>
                  <td className="px-2 py-2">
                    <button
                      onClick={() => onCopy(row)}
                      disabled={busy === row.rate_id}
                      className="rounded border px-2 py-1 text-xs font-medium"
                      style={{ borderColor: 'var(--control-border)' }}
                    >
                      {copied === row.rate_id ? 'Copied' : busy === row.rate_id ? '…' : 'Copy quote'}
                    </button>
                  </td>
                </tr>
              ))}

              {result.ineligible.length > 0 && (
                <>
                  {/* §7: ineligible rows sit BELOW a divider, each with its
                      reason. "Withheld rows are counted and named, never
                      silently dropped." */}
                  <tr>
                    <td colSpan={14} className="px-2 pt-6 pb-2 text-xs font-semibold uppercase"
                        style={{ color: 'var(--muted)' }}>
                      Not quotable — {result.withheld_count} withheld
                    </td>
                  </tr>
                  {result.ineligible.map((row) => (
                    <tr key={row.rate_id} style={{ borderBottom: `1px solid var(--border)`, opacity: 0.75 }}>
                      <td className="px-2 py-2">—</td>
                      <td className="px-2 py-2 font-medium">{row.partner_name}</td>
                      <td className="num px-2 py-2 text-right">{dec(row.partner_bid)}</td>
                      <td className="num px-2 py-2 text-right">{dec(row.partner_ask)}</td>
                      <td className="num px-2 py-2 text-right">{dec(row.spread)}</td>
                      <td className="num px-2 py-2">{band(row.size_status, row.min_size, row.max_size)}</td>
                      <td className="px-2 py-2 text-right">—</td>
                      <td className="px-2 py-2 text-right">—</td>
                      <td className="px-2 py-2 text-right">—</td>
                      <td className="num px-2 py-2">{sgt(row.submitted_at)}</td>
                      <td className="num px-2 py-2">{sgt(row.valid_until)}</td>
                      <td className="px-2 py-2" colSpan={3}>
                        <span className="status status-neutral">{row.reason}</span>
                      </td>
                    </tr>
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* §7: the disclaimer sits directly beneath the table, not in a page
          footer. The phrase "best execution" appears nowhere. */}
      <p className="mt-4 text-xs" style={{ color: 'var(--muted)' }}>
        Indicative only. Rates are supplied by partners and are not firm quotes or offers to
        trade. The best eligible displayed rate is subject to confirmation and availability at
        the time of dealing.
      </p>
    </>
  );
}
