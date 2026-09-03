'use server';

import { redirect } from 'next/navigation';
import { sendAuthEmail } from '@/lib/auth-email';
import { publicLocale } from '@/lib/i18n';
import { readPendingEmail } from '@/lib/pending-email';

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

  const locale = await publicLocale();
  // A magic link rather than a second signup token: there is no password at
  // this point (the person typed it minutes ago and we never kept it), and
  // verifying a magic link confirms an unconfirmed email, which is the whole
  // job. See OTP_TYPE in lib/auth-email.ts.
  await sendAuthEmail({ kind: 'resend', email, locale });

  // Same posture as requestPasswordReset: the screen answers identically
  // whatever happened, so it can never become an oracle for "does this address
  // have a signup waiting". The result is deliberately not inspected — the
  // commonest non-send is now our own hourly throttle, which the `resent` copy
  // already prepares the reader for ("it can take a minute to arrive").
  redirect(`${back}${blocked ? '&' : '?'}reenviado=1`);
}
