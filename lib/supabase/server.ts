import 'server-only';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

type CookieToSet = { name: string; value: string; options?: CookieOptions };

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * The caller's own session, cookie-backed.
 *
 * Every query made through this client is subject to RLS as that principal.
 * §5: "Route guards are convenience; the database is the boundary." This is
 * the client that boundary applies to, and it is the one almost everything
 * should use.
 */
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(URL, ANON, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list: CookieToSet[]) => {
        try {
          for (const { name, value, options } of list) {
            // §18.5: secure, HttpOnly, SameSite=Lax.
            store.set(name, value, { ...options, httpOnly: true, sameSite: 'lax', secure: true });
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Refresh happens in middleware instead.
        }
      },
    },
  });
}

/**
 * The service-role client. BYPASSES RLS.
 *
 * §12.3: "used only in server-side routes and MUST NOT appear in any browser
 * bundle." `import 'server-only'` makes importing this from a client component
 * a build error, and scripts/assert-no-service-key.mjs fails the build if the
 * key ever reaches the output.
 *
 * There are exactly two legitimate uses in this application, both in the auth
 * route: sign_in_allowed and record_sign_in, which run before the caller has a
 * session and therefore cannot be authorised as a principal. Anything else
 * belongs on supabaseServer().
 */
export function supabaseService() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createClient(URL, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
