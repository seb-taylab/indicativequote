import './env';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Accept either name: the app needs the NEXT_PUBLIC_ prefix to reach the
// browser bundle, and there is no reason to make anyone set both.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/**
 * Service-role client. Used ONLY to build and tear down fixtures -- creating
 * partners, principals and rates that the RPC surface cannot yet create.
 *
 * §20.2 is explicit that the assertions themselves must never be made through
 * a service-role query: it bypasses RLS and would prove nothing. Every
 * assertion in tests/access uses a session client from signInAs().
 */
export function adminClient(): SupabaseClient {
  return createClient(required('NEXT_PUBLIC_SUPABASE_URL', url), required('SUPABASE_SERVICE_ROLE_KEY', serviceKey), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** An unauthenticated client, for T21. */
export function anonClient(): SupabaseClient {
  return createClient(required('NEXT_PUBLIC_SUPABASE_URL', url), required('NEXT_PUBLIC_SUPABASE_ANON_KEY', anonKey), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * A real signed-in session for `email`, obtained through the real magic-link
 * flow -- generateLink then verifyOtp -- rather than a password.
 *
 * §19: "No passwords anywhere." The test harness does not get to invent a
 * password path the application does not have.
 */
export async function signInAs(email: string): Promise<SupabaseClient> {
  const admin = adminClient();
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (error) throw new Error(`generateLink failed for ${email}: ${error.message}`);

  const tokenHash = data.properties?.hashed_token;
  if (!tokenHash) throw new Error(`no hashed_token returned for ${email}`);

  const session = createClient(
    required('NEXT_PUBLIC_SUPABASE_URL', url),
    required('NEXT_PUBLIC_SUPABASE_ANON_KEY', anonKey),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const verified = await session.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'magiclink',
  });
  if (verified.error) {
    throw new Error(`verifyOtp failed for ${email}: ${verified.error.message}`);
  }
  return session;
}

/** Create (or reuse) an auth user and return its id. Fixture setup only. */
export async function ensureAuthUser(email: string): Promise<string> {
  const admin = adminClient();
  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (created.data?.user) return created.data.user.id;

  // Already exists -- find it.
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(`listUsers failed: ${error.message}`);
  const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!found) throw new Error(`could not create or find auth user ${email}`);
  return found.id;
}
