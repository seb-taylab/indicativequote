'use client';

import { useState, useTransition } from 'react';
import { retireMarkupVersion } from '../actions';

export function RetireButton({ id, pair }: { id: string; pair: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div>
      <button
        disabled={pending}
        onClick={() => {
          const reason = window.prompt(
            `Retire the active markup for ${pair}?\n\n` +
              'The board will then withhold every row for this pair with "no active markup", ' +
              'and nothing on it can be quoted until a new version exists.\n\n' +
              'Reason (recorded in the audit):',
          );
          if (!reason || !reason.trim()) return;
          setError(null);
          start(async () => {
            const res = await retireMarkupVersion(id, reason.trim());
            if (!res.ok) setError(res.error ?? 'That did not work.');
          });
        }}
        className="rounded border px-2 py-1 text-xs"
        style={{ borderColor: 'var(--border)' }}
      >
        Retire version
      </button>
      {error && (
        <p role="alert" className="mt-1 text-xs" style={{ color: 'var(--expired)' }}>{error}</p>
      )}
    </div>
  );
}
