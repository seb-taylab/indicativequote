import { redirect } from 'next/navigation';
import { currentPrincipal, zoneFor } from '@/lib/auth';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const p = await currentPrincipal();
  if (p) redirect(zoneFor(p));

  const { error } = await searchParams;

  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">MetaComp Rate Hub</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
        Internal rate board. Sign in with your work address.
      </p>

      {error === 'link' && (
        <p role="alert" className="status status-expired mt-6 block px-3 py-2">
          That sign-in link has expired or has already been used. Request a new one below.
        </p>
      )}
      {error === 'access' && (
        <p role="alert" className="status status-expired mt-6 block px-3 py-2">
          That address does not currently have access to the Rate Hub.
        </p>
      )}

      <LoginForm />

      <p className="mt-8 text-xs" style={{ color: 'var(--muted)' }}>
        Access is managed by the backbone team. There are no passwords &mdash; sign-in is by
        single-use link.
      </p>
    </main>
  );
}
