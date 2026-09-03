'use server';

import { redirect } from 'next/navigation';
import { sendAuthEmail } from '@/lib/auth-email';
import { publicLocale } from '@/lib/i18n';
import { setPendingEmail } from '@/lib/pending-email';

// Self-serve signup. Confirmation lands on /auth/confirm, which resolves the
// session and sends the user into /onboarding — the existing
// complete_onboarding() RPC and trial-start column default need no new code.
//
// The email itself is Capo's now, not Supabase's: sendAuthEmail mints the token
// through generateLink and delivers our own template through Resend (W1). The
// account is still created by GoTrue, and this action's `?erro=` contract and
// pending-email behaviour are unchanged.
export async function signUp(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const password = String(formData.get('password') ?? '');
  if (!email || !password || password.length < 8) redirect('/registar?erro=dados');

  // The visitor's own language, from the same cookie the public pages read, so
  // the email arrives in the language the signup form was written in.
  const locale = await publicLocale();
  // The result is deliberately not inspected. Sent, throttled, and skipped
  // because the address already has a confirmed account all get the same
  // success screen a real signup gets: anything else would make this form a way
  // to test whether a given person has a Capo account. Real infra failures stay
  // visible server-side in the auth_email.* log lines.
  await sendAuthEmail({ kind: 'confirm', email, password, locale });

  // Remembered so /confirmar-email can name the address (the typo check) and
  // offer a resend without asking for it again. Set on every path, so
  // "already registered" keeps looking exactly like a fresh signup.
  await setPendingEmail(email);
  redirect('/confirmar-email');
}
