'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@capo/db/user-client';
import { siteUrl } from '@/lib/site-url';

// Self-serve signup. Confirmation lands on /auth/confirm, which resolves the
// session and sends the user into /onboarding — the existing
// complete_onboarding() RPC and trial-start column default need no new code.
export async function signUp(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const password = String(formData.get('password') ?? '');
  if (!email || !password || password.length < 8) redirect('/registar?erro=dados');

  const supabase = await createUserClient();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${siteUrl()}/auth/confirm?next=/onboarding` },
  });

  if (error) {
    // Signups disabled at the Supabase dashboard level (docs/human-todo.md
    // step 2 flips this on) — the only case worth a distinct message, since
    // it's a config state, not something about this particular email.
    if (/sign\s*ups?/i.test(error.message) && /not allowed|disabled/i.test(error.message)) {
      redirect('/registar?erro=fechado');
    }
    // Any other failure (including "already registered") gets the same
    // success screen as a real signup — no account enumeration. Real infra
    // failures are still visible server-side via this log line.
    console.error('signUp failed:', error.message);
  }

  redirect('/registar?sucesso=1');
}
