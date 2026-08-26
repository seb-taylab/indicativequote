import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer, supabaseService } from '@/lib/supabase/server';

/**
 * Magic-link landing. §19: "On first click, auth_user_id and first_seen_at are
 * set."
 *
 * The binding runs through record_sign_in with the service role, because at
 * this instant the caller has a session but is not yet a resolvable principal
 * -- there is nothing for RLS to match on until auth_user_id is written. It
 * also writes the access.signin audit event, in the same transaction.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  // §16.1: "Return to /login with the destination preserved, no data cached in
  // the URL." `next` is a path only -- see the guard below.
  const next = url.searchParams.get('next');

  const sb = await supabaseServer();

  let email: string | null = null;
  let userId: string | null = null;

  if (code) {
    const { data, error } = await sb.auth.exchangeCodeForSession(code);
    if (error) return NextResponse.redirect(new URL('/login?error=link', url.origin));
    email = data.user?.email ?? null;
    userId = data.user?.id ?? null;
  } else if (tokenHash) {
    const { data, error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
    if (error) return NextResponse.redirect(new URL('/login?error=link', url.origin));
    email = data.user?.email ?? null;
    userId = data.user?.id ?? null;
  } else {
    return NextResponse.redirect(new URL('/login', url.origin));
  }

  if (!email || !userId) {
    return NextResponse.redirect(new URL('/login?error=link', url.origin));
  }

  const service = supabaseService();
  const { data: bound, error: bindError } = await service.rpc('record_sign_in', {
    p_auth_user_id: userId,
    p_email: email,
  });

  if (bindError) {
    // A valid Supabase login that maps to no active principal, or to one bound
    // to a different login. Drop the session rather than leaving a signed-in
    // user with no zone.
    await sb.auth.signOut();
    return NextResponse.redirect(new URL('/login?error=access', url.origin));
  }

  // §5: a principal only ever sees one zone.
  const home = bound?.kind === 'staff' ? '/board' : '/partner';

  // Only ever redirect to a same-origin PATH. An open redirect here would let
  // a crafted sign-in link land a signed-in RM on someone else's page.
  const dest = next && next.startsWith('/') && !next.startsWith('//') ? next : home;

  return NextResponse.redirect(new URL(dest, url.origin));
}
