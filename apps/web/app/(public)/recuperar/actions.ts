'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@capo/db/user-client';
import { siteUrl } from '@/lib/site-url';

// Password reset request. Always answers with the same "if an account
// exists…" message, regardless of whether the email is registered — no
// account enumeration.
export async function requestPasswordReset(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  if (!email) redirect('/recuperar?erro=dados');

  const supabase = await createUserClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${siteUrl()}/auth/confirm?next=/nova-password`,
  });
  if (error) console.error('resetPasswordForEmail failed:', error.message);

  redirect('/recuperar?enviado=1');
}
