import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/**
 * §19 sessions: access tokens last an hour and refresh tokens rotate. This
 * refreshes the session cookie on navigation so a working session is not lost
 * mid-task.
 *
 * It deliberately does NOT authorise anything. Role and partner are resolved
 * from the live tables in every page (lib/auth.ts), because §19 rejects
 * carrying them in a claim: "a claim would need re-checking against the live
 * table anyway, which is the complexity of both approaches and the guarantee
 * of neither."
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list: CookieToSet[]) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) {
            response.cookies.set(name, value, {
              ...options,
              httpOnly: true,
              sameSite: 'lax',
              secure: true,
            });
          }
        },
      },
    },
  );

  await supabase.auth.getUser();
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
