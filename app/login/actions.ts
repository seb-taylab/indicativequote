'use server';

import { headers } from 'next/headers';
import { supabaseServer, supabaseService } from '@/lib/supabase/server';

export interface SignInState {
  sent: boolean;
  message: string;
}

/**
 * §19 sign-in. Magic link only -- no passwords anywhere.
 *
 * TM12, e-mail enumeration: "The response is BYTE-IDENTICAL whether or not the
 * address is known."
 *
 * That is why this function has exactly one success return and never branches
 * its message. An unknown address, a revoked principal and a valid one all
 * produce the same words, the same shape and no observable difference. The
 * denial is recorded server-side by sign_in_allowed, where the caller cannot
 * see it.
 */
const IDENTICAL_RESPONSE: SignInState = {
  sent: true,
  message:
    'If that address has access, a sign-in link is on its way. ' +
    'The link is single-use and expires shortly.',
};

export async function requestMagicLink(
  _prev: SignInState | null,
  formData: FormData,
): Promise<SignInState> {
  const raw = String(formData.get('email') ?? '').trim();

  // Shape check only. An invalid address still returns the identical response,
  // because "that is not a valid e-mail" is itself a signal on some inputs.
  const looksLikeEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw);
  if (!looksLikeEmail) return IDENTICAL_RESPONSE;

  const service = supabaseService();

  // Records access.signin_denied itself when it returns false (§11.7).
  const { data: allowed, error } = await service.rpc('sign_in_allowed', { p_email: raw });

  if (error || allowed !== true) {
    // Deliberately identical. Do not add logging here that varies by branch in
    // a way that could surface in a timing or error channel.
    return IDENTICAL_RESPONSE;
  }

  const h = await headers();
  const origin = h.get('origin') ?? process.env.NEXT_PUBLIC_SITE_URL ?? '';

  const sb = await supabaseServer();
  await sb.auth.signInWithOtp({
    email: raw,
    options: {
      // The principal exists but has no auth user until the first click (§19).
      shouldCreateUser: true,
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });

  return IDENTICAL_RESPONSE;
}

export async function signOut(): Promise<void> {
  const sb = await supabaseServer();
  await sb.auth.signOut();
}
