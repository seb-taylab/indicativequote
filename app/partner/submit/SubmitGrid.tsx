'use client';

import { useMemo, useState } from 'react';
import { buildRegistry, parseRateBlock, type ParsedRow, type RejectedLine, type IgnoredLine } from '@/src/domain/parser';
import { isCrossed } from '@/src/domain/rates';
import { submitRates, type SubmitResult, type SubmitRow } from './actions';

export interface PairInfo {
  id: string;
  base_ccy: string;
  quote_ccy: string;
  quote_mode: 'two_way' | 'bid_only' | 'ask_only' | 'either_side';
}

export interface CurrentRow {
  currency_pair_id: string;
  bid: string | null;
  ask: string | null;
  size_status: string;
  min_size: string | null;
  max_size: string | null;
}

type RowState = 'new' | 'updated' | 'renewed' | 'normalised' | 'error';

interface GridRow {
  key: string;
  currencyPairId: string;
  bid: string;
  ask: string;
  sizeConfirmed: boolean;
  minSize: string;
  maxSize: string;
  include: boolean;
  normalised: boolean;
  originalNote?: string;
  acknowledged: boolean;
}

let seq = 0;
const nextKey = () => `r${seq++}`;

/**
 * §6.2, the grid. "An editable table, and THE COMPLETE ENTRY SURFACE."
 *
 * A partner with no text block can build a submission here from nothing: D7
 * means there is no paste-only dead end and no second entry page.
 */
export function SubmitGrid({
  pairs,
  current,
  defaultValidHours,
  lastRaw,
}: {
  pairs: PairInfo[];
  current: CurrentRow[];
  defaultValidHours: number;
  lastRaw: string | null;
}) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<GridRow[]>([]);
  const [rejected, setRejected] = useState<RejectedLine[]>([]);
  const [ignored, setIgnored] = useState<IgnoredLine[]>([]);
  const [parsed, setParsed] = useState(false);
  const [validOverride, setValidOverride] = useState('');
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [busy, setBusy] = useState(false);

  const registry = useMemo(
    () =>
      buildRegistry(
        Array.from(new Set(pairs.flatMap((p) => [p.base_ccy, p.quote_ccy]))),
        pairs.map((p) => ({ id: p.id, baseCcy: p.base_ccy, quoteCcy: p.quote_ccy })),
      ),
    [pairs],
  );

  const currentByPair = useMemo(() => {
    const m = new Map<string, CurrentRow[]>();
    for (const c of current) {
      const list = m.get(c.currency_pair_id) ?? [];
      list.push(c);
      m.set(c.currency_pair_id, list);
    }
    return m;
  }, [current]);

  function pairOf(id: string): PairInfo | undefined {
    return pairs.find((p) => p.id === id);
  }

  /** §6.2 row states, computed for display only; the server decides for real. */
  function stateOf(row: GridRow): RowState {
    const pair = pairOf(row.currencyPairId);
    if (!pair) return 'error';
    if (isCrossed(row.bid || null, row.ask || null)) return 'error';
    if (pair.quote_mode === 'two_way' && (!row.bid || !row.ask)) return 'error';
    if (pair.quote_mode === 'bid_only' && row.ask) return 'error';
    if (pair.quote_mode === 'ask_only' && row.bid) return 'error';
    if (row.sizeConfirmed && !row.minSize) return 'error';
    if (row.normalised && !row.acknowledged) return 'normalised';

    const existing = currentByPair.get(row.currencyPairId) ?? [];
    const match = existing.find((e) =>
      row.sizeConfirmed
        ? e.size_status === 'confirmed' && e.min_size === (row.minSize || null)
        : e.size_status === 'unconfirmed',
    );
    if (!match) return 'new';
    // §6.2: identical values are a RENEWAL, not "no change". The partner is
    // asserting the numbers are still good, and that assertion must refresh
    // validity rather than being silently discarded.
    if (match.bid === (row.bid || null) && match.ask === (row.ask || null)) return 'renewed';
    return 'updated';
  }

  function priorFor(row: GridRow): CurrentRow | undefined {
    const existing = currentByPair.get(row.currencyPairId) ?? [];
    return existing.find((e) =>
      row.sizeConfirmed
        ? e.size_status === 'confirmed' && e.min_size === (row.minSize || null)
        : e.size_status === 'unconfirmed',
    );
  }

  function fromParsed(p: ParsedRow): GridRow {
    return {
      key: nextKey(),
      currencyPairId: p.currencyPairId,
      bid: p.bid ?? '',
      ask: p.ask ?? '',
      // §10.3: size does not survive normalisation and must be restated.
      sizeConfirmed: false,
      minSize: '',
      maxSize: '',
      include: true,
      normalised: p.normalisedFromInverse,
      originalNote: p.warnings.find((w) => w.code === 'normalised_from_inverse')?.message,
      acknowledged: false,
    };
  }

  function onParse() {
    const out = parseRateBlock(text, registry);
    setRows(out.rows.map(fromParsed));
    setRejected(out.rejected);
    setIgnored(out.ignored);
    setParsed(true);
    setResult(null);
  }

  function addBlankRow() {
    setRows((r) => [
      ...r,
      {
        key: nextKey(),
        currencyPairId: pairs[0]?.id ?? '',
        bid: '', ask: '',
        sizeConfirmed: false, minSize: '', maxSize: '',
        include: true, normalised: false, acknowledged: false,
      },
    ]);
    setParsed(true);
    setResult(null);
  }

  function update(key: string, patch: Partial<GridRow>) {
    setRows((r) => r.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function remove(key: string) {
    setRows((r) => r.filter((row) => row.key !== key));
  }

  const includable = rows.filter((r) => r.include && stateOf(r) !== 'error');
  const blocked = rows.filter((r) => r.include && stateOf(r) === 'error');
  const unacknowledged = rows.filter((r) => r.include && stateOf(r) === 'normalised');

  async function onSubmit() {
    setBusy(true);
    setResult(null);

    const payload: SubmitRow[] = includable.map((r) => ({
      currency_pair_id: r.currencyPairId,
      bid: r.bid.trim() || null,
      ask: r.ask.trim() || null,
      size_status: r.sizeConfirmed ? 'confirmed' : 'unconfirmed',
      min_size: r.sizeConfirmed ? (r.minSize.trim() || null) : null,
      max_size: r.sizeConfirmed ? (r.maxSize.trim() || null) : null,
      normalised_from_inverse: r.normalised,
    }));

    const validUntil = validOverride
      ? new Date(validOverride).toISOString()
      : null;

    const res = await submitRates(payload, validUntil, text || null, crypto.randomUUID());
    setBusy(false);
    setResult(res);
    // §16.1: on failure the grid keeps every value entered. Nothing is cleared
    // here, deliberately.
    if (res.ok) {
      setRows([]);
      setText('');
      setParsed(false);
    }
  }

  return (
    <div className="mt-6 space-y-6">
      {/* Step 1 -- §6.1 */}
      <section>
        <label htmlFor="paste" className="block text-sm font-medium">
          Paste your rates
        </label>
        <textarea
          id="paste"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          autoFocus
          placeholder={lastRaw ?? 'USD/NGN 1392 | 1394\nUSD/GHS 11.77-11.81'}
          className="num mt-1 w-full rounded border p-3 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            onClick={onParse}
            disabled={!text.trim()}
            className="rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            Parse
          </button>
          <span className="text-sm" style={{ color: 'var(--muted)' }}>or</span>
          <button onClick={addBlankRow} className="rounded border px-3 py-1.5 text-sm"
                  style={{ borderColor: 'var(--border)' }}>
            start with an empty row
          </button>
        </div>
      </section>

      {/* §16.1: parse produced nothing -- keep the text, offer one empty row. */}
      {parsed && rows.length === 0 && (
        <p role="status" className="rounded border px-3 py-2 text-sm"
           style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          Nothing recognised — add rows manually.
        </p>
      )}

      {/* §6.3 errors 2: unrecognised lines shown VERBATIM, never dropped. */}
      {rejected.length > 0 && (
        <section className="rounded border px-3 py-2"
                 style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <h2 className="text-sm font-semibold">Lines that could not be used</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {rejected.map((r) => (
              <li key={r.lineNumber}>
                <code className="num">{r.raw}</code>
                <span className="ml-2" style={{ color: 'var(--expired)' }}>{r.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {ignored.length > 0 && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {ignored.length} line{ignored.length === 1 ? '' : 's'} ignored as greetings or notes.
        </p>
      )}

      {/* Step 2 -- the grid */}
      {rows.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold">Check and confirm</h2>
          <div className="table-scroll mt-2">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr style={{ borderBottom: `2px solid var(--border)` }}>
                  <th scope="col" className="px-2 py-2 text-left">Include</th>
                  <th scope="col" className="px-2 py-2 text-left">Pair</th>
                  <th scope="col" className="px-2 py-2 text-right">Bid</th>
                  <th scope="col" className="px-2 py-2 text-right">Ask</th>
                  <th scope="col" className="px-2 py-2 text-left">Size</th>
                  <th scope="col" className="px-2 py-2 text-left">State</th>
                  <th scope="col" className="px-2 py-2"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const st = stateOf(row);
                  const prior = priorFor(row);
                  const pair = pairOf(row.currencyPairId);
                  return (
                    <tr key={row.key} style={{ borderBottom: `1px solid var(--border)` }}>
                      <td className="px-2 py-2">
                        <input
                          type="checkbox"
                          checked={row.include}
                          onChange={(e) => update(row.key, { include: e.target.checked })}
                          aria-label={`Include ${pair?.base_ccy}/${pair?.quote_ccy}`}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <select
                          value={row.currencyPairId}
                          onChange={(e) => update(row.key, { currencyPairId: e.target.value })}
                          aria-label="Currency pair"
                          className="num rounded border px-1 py-1"
                          style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                        >
                          {pairs.map((p) => (
                            <option key={p.id} value={p.id}>{p.base_ccy}/{p.quote_ccy}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-2 text-right">
                        <input
                          value={row.bid}
                          onChange={(e) => update(row.key, { bid: e.target.value })}
                          aria-label="Bid"
                          disabled={pair?.quote_mode === 'ask_only'}
                          className="num w-28 rounded border px-1 py-1 text-right disabled:opacity-40"
                          style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                        />
                        {prior && prior.bid && prior.bid !== row.bid && (
                          <div className="num text-xs line-through" style={{ color: 'var(--muted)' }}>
                            {prior.bid}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <input
                          value={row.ask}
                          onChange={(e) => update(row.key, { ask: e.target.value })}
                          aria-label="Ask"
                          disabled={pair?.quote_mode === 'bid_only'}
                          className="num w-28 rounded border px-1 py-1 text-right disabled:opacity-40"
                          style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                        />
                        {prior && prior.ask && prior.ask !== row.ask && (
                          <div className="num text-xs line-through" style={{ color: 'var(--muted)' }}>
                            {prior.ask}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <label className="flex items-center gap-1 text-xs">
                          <input
                            type="checkbox"
                            checked={row.sizeConfirmed}
                            onChange={(e) => update(row.key, { sizeConfirmed: e.target.checked })}
                          />
                          confirmed
                        </label>
                        {row.sizeConfirmed && (
                          <div className="mt-1 flex gap-1">
                            <input value={row.minSize} onChange={(e) => update(row.key, { minSize: e.target.value })}
                                   aria-label="Minimum size" placeholder="min"
                                   className="num w-24 rounded border px-1 py-1"
                                   style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
                            <input value={row.maxSize} onChange={(e) => update(row.key, { maxSize: e.target.value })}
                                   aria-label="Maximum size" placeholder="max"
                                   className="num w-24 rounded border px-1 py-1"
                                   style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {st === 'error' && <span className="status status-expired">error</span>}
                        {st === 'renewed' && (
                          <span className="status status-neutral">no change — validity renewed</span>
                        )}
                        {st === 'updated' && <span className="status status-neutral">updated</span>}
                        {st === 'new' && <span className="status status-live">new</span>}
                        {st === 'normalised' && (
                          <div>
                            <span className="status status-expiring">normalised</span>
                            <p className="mt-1 max-w-xs text-xs" style={{ color: 'var(--muted)' }}>
                              {row.originalNote}
                            </p>
                            <label className="mt-1 flex items-center gap-1 text-xs">
                              <input type="checkbox" checked={row.acknowledged}
                                     onChange={(e) => update(row.key, { acknowledged: e.target.checked })} />
                              I confirm the canonical form
                            </label>
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <button onClick={() => remove(row.key)}
                                className="rounded border px-2 py-1 text-xs"
                                style={{ borderColor: 'var(--border)' }}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <button onClick={addBlankRow} className="mt-2 rounded border px-3 py-1.5 text-sm"
                  style={{ borderColor: 'var(--border)' }}>
            Add row
          </button>

          {/* D6: batch validity, displayed and overridable ONCE for the whole
              batch. Never per row. */}
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="valid" className="block text-xs font-medium">
                Valid until
              </label>
              <input
                id="valid"
                type="datetime-local"
                value={validOverride}
                onChange={(e) => setValidOverride(e.target.value)}
                className="num mt-1 rounded border px-2 py-1.5"
                style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
              />
            </div>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Defaults to {defaultValidHours} hours from now. Applies to the whole batch.
            </p>
          </div>

          {blocked.length > 0 && (
            <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--expired)' }}>
              {blocked.length} row{blocked.length === 1 ? '' : 's'} cannot be submitted as
              they stand. Fix or deselect them — the rest are unaffected.
            </p>
          )}
          {unacknowledged.length > 0 && (
            <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--expiring)' }}>
              Confirm the canonical form for {unacknowledged.length} normalised row
              {unacknowledged.length === 1 ? '' : 's'} before submitting.
            </p>
          )}

          <button
            onClick={onSubmit}
            disabled={busy || includable.length === 0 || unacknowledged.length > 0}
            className="mt-4 rounded px-4 py-2 font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            {busy ? 'Submitting…' : `Submit ${includable.length} row${includable.length === 1 ? '' : 's'}`}
          </button>
        </section>
      )}

      {result && !result.ok && (
        <p role="alert" className="rounded border px-3 py-2 text-sm"
           style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--expired)' }}>
          {result.error}
        </p>
      )}
      {result?.ok && (
        <p role="status" className="rounded border px-3 py-2 text-sm"
           style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          Submitted {result.rows?.length} row{result.rows?.length === 1 ? '' : 's'}
          {result.rows?.some((r) => r.state === 'renewed') && ' (including renewals)'}. Valid
          until{' '}
          <span className="num">
            {result.validUntil &&
              new Intl.DateTimeFormat('en-GB', {
                timeZone: 'Asia/Singapore', day: '2-digit', month: 'short',
                hour: '2-digit', minute: '2-digit', hour12: false,
              }).format(new Date(result.validUntil))}{' '}
            SGT
          </span>
          .
        </p>
      )}
    </div>
  );
}
