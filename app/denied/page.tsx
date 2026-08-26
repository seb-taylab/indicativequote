import { currentPrincipal, zoneFor } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * §16.1 "Permission denied": a plain statement of what is not permitted.
 * "Never an empty page that looks broken."
 */
export default async function DeniedPage() {
  const p = await currentPrincipal();

  return (
    <main id="main" className="mx-auto max-w-lg px-6 py-16">
      <h1 className="text-xl font-semibold">You do not have access to that page</h1>
      <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
        Your account is signed in, but your role does not permit this section. Nothing is
        broken and nothing was recorded against you.
      </p>
      {p && (
        <p className="mt-4 text-sm">
          <a href={zoneFor(p)} style={{ color: 'var(--accent)' }}>
            Back to {p.kind === 'staff' ? 'the board' : 'your partner home'}
          </a>
        </p>
      )}
      <p className="mt-6 text-xs" style={{ color: 'var(--muted)' }}>
        Access is managed by the backbone team.
      </p>
    </main>
  );
}
