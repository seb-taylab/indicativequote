'use client';

import { useActionState } from 'react';
import { requestMagicLink, type SignInState } from './actions';

export function LoginForm() {
  const [state, action, pending] = useActionState<SignInState | null, FormData>(
    requestMagicLink,
    null,
  );

  // TM12: the same response object for every outcome, so the interface cannot
  // leak what the server deliberately concealed.
  if (state?.sent) {
    return (
      <div role="status" className="mt-8 rounded border p-4" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
        <p className="font-medium">Check your inbox</p>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>{state.message}</p>
      </div>
    );
  }

  return (
    <form action={action} className="mt-8 space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium">
          Work e-mail address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          className="mt-1 w-full rounded border px-3 py-2"
          style={{ borderColor: 'var(--control-border)', background: 'var(--bg)', color: 'var(--text)' }}
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded px-4 py-2 font-medium text-white disabled:opacity-60"
        style={{ background: 'var(--accent)' }}
      >
        {pending ? 'Sending…' : 'Send sign-in link'}
      </button>
    </form>
  );
}
