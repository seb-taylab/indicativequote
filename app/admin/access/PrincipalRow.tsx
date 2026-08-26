'use client';

import { useState, useTransition } from 'react';
import { revokePartnerUser, revokeStaff, setStaffRole } from '../actions';

const STAFF_ROLES = [
  { value: 'rm_viewer', label: 'RM viewer' },
  { value: 'backbone_operator', label: 'Backbone operator' },
  { value: 'backbone_admin', label: 'Backbone admin' },
];

/** §16.3: "Revoke shows what the person loses." */
function losesWhat(kind: 'staff' | 'partner', role: string): string {
  if (kind === 'partner') {
    return role === 'partner_admin'
      ? 'They lose the ability to submit, correct and withdraw rates, and to manage pairs and quote modes.'
      : 'They lose the ability to submit, correct and withdraw rates, and to see their own submission history.';
  }
  switch (role) {
    case 'rm_viewer':
      return 'They lose access to the rate board and to copying quotes.';
    case 'backbone_operator':
      return 'They lose the board, partner administration, partner access management, health and audit.';
    case 'backbone_admin':
      return 'They lose everything an operator has, plus staff access management, markup versions, partner creation and convention confirmation.';
    default:
      return 'They lose all access to the Rate Hub.';
  }
}

export function PrincipalRow({
  id, email, kind, role, invited, first, last, status, canAdmin, isSelf, isLastActiveAdmin,
}: {
  id: string; email: string; kind: 'staff' | 'partner'; role: string;
  invited: string; first: string; last: string; status: string;
  canAdmin: boolean; isSelf?: boolean; isLastActiveAdmin: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const revoked = status === 'revoked';

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? 'That did not work.');
    });
  }

  function onRevoke() {
    const reason = window.prompt(
      `Revoke access for ${email}?\n\n${losesWhat(kind, role)}\n\nReason (recorded in the audit):`,
    );
    if (!reason || !reason.trim()) return;
    run(() =>
      kind === 'staff'
        ? revokeStaff(id, reason.trim())
        : revokePartnerUser(id, reason.trim()),
    );
  }

  // The UI states the rule; the database enforces it. §13.2 refuses both cases
  // regardless of what this component renders.
  const revokeBlocked = isSelf || isLastActiveAdmin;
  const revokeBlockedWhy = isSelf
    ? 'You cannot revoke yourself.'
    : 'This is the last active backbone admin. Appoint another first.';

  return (
    <>
      <tr style={{ borderBottom: `1px solid var(--border)`, opacity: revoked ? 0.6 : 1 }}>
        <td className="num px-2 py-1.5">{email}</td>
        <td className="px-2 py-1.5">
          {kind === 'staff' && canAdmin && !revoked && !isSelf ? (
            <>
              <label htmlFor={`role-${id}`} className="sr-only">Role for {email}</label>
              <select
                id={`role-${id}`}
                defaultValue={role}
                disabled={pending}
                onChange={(e) => run(() => setStaffRole(id, e.target.value))}
                className="rounded border px-1 py-0.5 text-xs"
                style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
              >
                {STAFF_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </>
          ) : (
            <span>{role.replace(/_/g, ' ')}</span>
          )}
        </td>
        <td className="num px-2 py-1.5">{invited}</td>
        <td className="num px-2 py-1.5">{first}</td>
        <td className="num px-2 py-1.5">{last}</td>
        <td className="px-2 py-1.5">
          <span className={`status ${
            status === 'active' ? 'status-live'
            : status === 'invited' ? 'status-neutral' : 'status-expired'
          }`}>{status}</span>
        </td>
        <td className="px-2 py-1.5">
          {!revoked && (
            <button
              onClick={onRevoke}
              disabled={pending || revokeBlocked || (kind === 'staff' && !canAdmin)}
              title={revokeBlocked ? revokeBlockedWhy : undefined}
              className="rounded border px-2 py-1 text-xs disabled:opacity-40"
              style={{ borderColor: 'var(--border)' }}
            >
              Revoke
            </button>
          )}
        </td>
      </tr>
      {(error || revokeBlocked) && !revoked && (
        <tr>
          <td colSpan={7} className="px-2 pb-2 text-xs"
              style={{ color: error ? 'var(--expired)' : 'var(--muted)' }}>
            {error ?? revokeBlockedWhy}
          </td>
        </tr>
      )}
    </>
  );
}
