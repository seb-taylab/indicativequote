import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/**
 * Two jobs: refresh the session cookie, and set the Content-Security-Policy.
 *
 * §19 sessions: access tokens last an hour and refresh tokens rotate, so the
 * cookie is refreshed on navigation and a working session is not lost mid-task.
 * This deliberately authorises NOTHING -- role and partner are resolved from
 * the live tables on every request (lib/auth.ts), because §19 rejects carrying
 * them in a claim.
 *
 * §18.5 CSP -- WHY THIS IS A NONCE AND NOT `script-src 'self'`.
 *
 * The spec asks for "a CSP denying inline script". Implemented literally as
 * `script-src 'self'`, that denies Next.js's own bootstrap and flight-data
 * scripts, which are inline by construction. The result is a site that
 * SERVER-RENDERS PERFECTLY AND NEVER HYDRATES: every page looks right, and
 * every button, form and grid is dead.
 *
 * That was the observed behaviour before this change -- the board rendered
 * with correct rates and ranking, and Copy quote silently did nothing, because
 * React had never attached. A quote an RM believes they copied and which was
 * never recorded is precisely the failure §8 is written to prevent.
 *
 * The fix keeps the spec's intent -- no arbitrary inline script -- by issuing a
 * fresh nonce per request. Next.js reads the nonce out of this header and
 * stamps it on its own scripts; nothing else inline can run. 'strict-dynamic'
 * lets those nonced scripts load the chunks they need without whitelisting
 * origins.
 *
 * 'unsafe-eval' is added in development ONLY, because the dev-mode React
 * refresh runtime evaluates strings. It is absent from production.
 */
export async function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''}${isDev ? ' ws: http://localhost:*' : ''}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list: CookieToSet[]) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request: { headers: requestHeaders } });
          for (const { name, value, options } of list) {
            response.cookies.set(name, value, {
              ...options,
              httpOnly: true,
              sameSite: 'lax',
              secure: !isDev,
            });
          }
        },
      },
    },
  );

  await supabase.auth.getUser();

  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
