'use server';

import { redirect } from 'next/navigation';
import { sendAuthEmail } from '@/lib/auth-email';
import { publicLocale } from '@/lib/i18n';

// Password reset request. Always answers with the same "if an account
// exists…" message, regardless of whether the email is registered — no
// account enumeration. sendAuthEmail is built to keep that true: it returns
// 'skipped' both for an unknown address and for a delivery failure, and this
// action does not look at the answer at all.
export async function requestPasswordReset(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  if (!email) redirect('/recuperar?erro=dados');

  const locale = await publicLocale();
  await sendAuthEmail({ kind: 'recovery', email, locale });

  redirect('/recuperar?enviado=1');
}
