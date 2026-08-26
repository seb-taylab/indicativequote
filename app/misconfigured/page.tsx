export const dynamic = 'force-dynamic';

/**
 * Shown when the deployment is missing the configuration it needs to run.
 *
 * This exists because of a real incident: on the first Vercel deploy the
 * Supabase environment variables were unset, `createServerClient` threw inside
 * middleware, and every route -- including /login -- returned
 * MIDDLEWARE_INVOCATION_FAILED. A 500 with no detail, on a site that had built
 * successfully.
 *
 * The page names exactly which variables are missing and never prints a value.
 * `SUPABASE_SERVICE_ROLE_KEY` is reported only as present or absent, because
 * §12.3 keeps it out of anything a browser can see.
 */
export default function MisconfiguredPage() {
  const required = [
    { name: 'NEXT_PUBLIC_SUPABASE_URL', set: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) },
    { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', set: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) },
    { name: 'SUPABASE_SERVICE_ROLE_KEY', set: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY) },
  ];
  const missing = required.filter((r) => !r.set);

  return (
    <main id="main" className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-xl font-semibold">This deployment is not configured</h1>
      <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
        The Rate Hub built successfully but cannot reach its database. No data is at risk and
        nothing is broken in the code — the deployment is missing environment variables.
      </p>

      <ul className="mt-6 space-y-1 text-sm">
        {required.map((r) => (
          <li key={r.name} className="num">
            <span className={`status ${r.set ? 'status-live' : 'status-expired'}`}>
              {r.set ? 'set' : 'missing'}
            </span>{' '}
            {r.name}
          </li>
        ))}
      </ul>

      {missing.length > 0 && (
        <p className="mt-6 text-sm">
          Add {missing.length === 1 ? 'it' : 'them'} in the Vercel dashboard under{' '}
          <strong>Settings → Environment Variables</strong>, then redeploy. Values are never
          shown on this page.
        </p>
      )}

      <p className="mt-6 text-xs" style={{ color: 'var(--muted)' }}>
        Magic-link sign-in also needs this deployment&rsquo;s URL registered in Supabase under
        Authentication → URL Configuration, including the <code>/auth/callback</code> path.
      </p>
    </main>
  );
}
