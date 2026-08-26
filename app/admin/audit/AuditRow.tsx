'use client';

import { useState } from 'react';

/** §16.3: "Every row expandable to its `detail`." */
export function AuditRow({
  when, actor, role, action, subject, detail,
}: {
  when: string; actor: string; role: string; action: string; subject: string; detail: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr style={{ borderBottom: `1px solid var(--border)` }}>
        <td className="num px-2 py-2 whitespace-nowrap">{when}</td>
        <td className="num px-2 py-2">{actor}</td>
        <td className="px-2 py-2">{role}</td>
        <td className="px-2 py-2 font-medium">{action}</td>
        <td className="num px-2 py-2">{subject}</td>
        <td className="px-2 py-2">
          <button
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="rounded border px-2 py-1 text-xs"
            style={{ borderColor: 'var(--border)' }}
          >
            {open ? 'Hide' : 'Show'}
          </button>
        </td>
      </tr>
      {open && (
        <tr style={{ borderBottom: `1px solid var(--border)` }}>
          <td colSpan={6} className="px-2 pb-3">
            <pre className="num overflow-x-auto rounded p-2 text-xs"
                 style={{ background: 'var(--surface)' }}>{detail}</pre>
          </td>
        </tr>
      )}
    </>
  );
}
