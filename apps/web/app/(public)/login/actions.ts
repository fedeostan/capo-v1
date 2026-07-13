'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@capo/db/user-client';
import { siteUrl } from '@/lib/site-url';

// Password sign-in. Invite-only is structural: signInWithPassword can never
// create an account, so unknown emails simply fail. The error message is
// deliberately identical for "unknown email" and "wrong password" (no account
// enumeration) — errors are swallowed after logging.
export async function signIn(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) {
    redirect('/login?erro=credenciais');
  }

  const supabase = await createUserClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Wrong password and unknown email both land here — same UX, but keep a
    // server-side trace for real outages (rate limits, network).
    console.error('signInWithPassword failed:', error.message);
    redirect('/login?erro=credenciais');
  }

  // Session cookie is already set by createUserClient's SSR cookie adapter.
  redirect('/');
}

// Google OAuth — the button that calls this only renders when
// NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=1, but this action is harmless if invoked
// without a configured provider: signInWithOAuth just errors and we bounce
// back to /login.
export async function signInWithGoogle(): Promise<void> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${siteUrl()}/auth/callback` },
  });
  if (error || !data.url) {
    console.error('signInWithOAuth failed:', error?.message);
    redirect('/login?erro=credenciais');
  }
  redirect(data.url);
}
