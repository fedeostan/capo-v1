'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@capo/db/user-client';
import { readPendingEmail } from '@/lib/pending-email';
import { siteUrl } from '@/lib/site-url';

// Resend the signup confirmation to whichever address this browser is waiting
// on. The address comes from the pending-email cookie and never from the
// request body: a form field would let anyone point our mailer at any address
// they liked, one message per click.
export async function resendConfirmation(formData: FormData): Promise<void> {
  // Carried through so the "your password didn't work because…" line survives
  // the round trip; it is still true after a resend.
  const blocked = formData.get('pendente') != null;
  const back = blocked ? '/confirmar-email?pendente=1' : '/confirmar-email';

  const email = await readPendingEmail();
  // The cookie has expired. The screen does not render the button in that
  // state, so this is a stale submit — send them back rather than pretending.
  if (!email) redirect(back);

  const supabase = await createUserClient();
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: `${siteUrl()}/auth/confirm?next=/onboarding` },
  });

  // Same posture as requestPasswordReset: the screen answers identically
  // whatever happened, so it can never become an oracle for "does this address
  // have a signup waiting". The commonest real error is
  // over_email_send_rate_limit — Supabase refuses a second send inside a
  // minute — which is exactly what the `resent` copy prepares the reader for.
  if (error) console.error('resend signup confirmation failed:', error.message);

  redirect(`${back}${blocked ? '&' : '?'}reenviado=1`);
}
