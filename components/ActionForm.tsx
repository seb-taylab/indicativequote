'use client';

import { useState, useTransition } from 'react';
import type { R } from '@/app/admin/actions';

/**
 * A form that calls a Server Action and reports the outcome inline.
 *
 * §16.1: a failed action MUST NOT clear the work. The form is left populated
 * on error, and only reset on success.
 */
export function ActionForm({
  action,
  submitLabel,
  children,
  confirm,
  danger,
}: {
  action: (fd: FormData) => Promise<R>;
  submitLabel: string;
  children: React.ReactNode;
  confirm?: string;
  danger?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        if (confirm && !window.confirm(confirm)) return;
        const fd = new FormData(form);
        setError(null);
        setDone(false);
        start(async () => {
          const res = await action(fd);
          if (res.ok) {
            setDone(true);
            form.reset();
          } else {
            setError(res.error ?? 'That did not work.');
          }
        });
      }}
      className="space-y-3"
    >
      {children}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: danger ? 'var(--expired)' : 'var(--accent)' }}
        >
          {pending ? 'Working…' : submitLabel}
        </button>
        {done && <span role="status" className="status status-live">done</span>}
      </div>
      {error && (
        <p role="alert" className="text-sm" style={{ color: 'var(--expired)' }}>
          {error}
        </p>
      )}
    </form>
  );
}

export function Field({
  label, name, type = 'text', defaultValue, required, hint, options, mono,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number;
  required?: boolean;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  mono?: boolean;
}) {
  const id = `f-${name}-${label.replace(/\W+/g, '')}`;
  const cls = `mt-1 w-full rounded border px-2 py-1.5 ${mono ? 'num' : ''}`;
  const style = { borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' };

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium">{label}</label>
      {options ? (
        <select id={id} name={name} defaultValue={defaultValue} required={required}
                className={cls} style={style}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input id={id} name={name} type={type} defaultValue={defaultValue} required={required}
               className={cls} style={style} />
      )}
      {hint && <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{hint}</p>}
    </div>
  );
}
