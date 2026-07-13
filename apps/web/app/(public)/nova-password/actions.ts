'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@capo/db/user-client';

// Reachable only with a session established by the recovery link's
// /auth/confirm verifyOtp call — updateUser operates on the caller's own
// current session, never takes an email/id.
export async function setNewPassword(formData: FormData): Promise<void> {
  const password = String(formData.get('password') ?? '');
  if (!password || password.length < 8) redirect('/nova-password?erro=curta');

  const supabase = await createUserClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    console.error('updateUser failed:', error.message);
    redirect('/nova-password?erro=guardar');
  }

  redirect('/');
}
