'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@capo/db/user-client';

// Magic-link request. shouldCreateUser: false is the structural invite-only
// boundary — an unknown email can never create an account, whatever the
// dashboard toggle says. The response is deliberately identical for known
// and unknown emails (no account enumeration), so errors are swallowed after
// logging.
export async function sendMagicLink(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    redirect('/login?erro=email');
  }

  const supabase = await createUserClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });
  if (error) {
    // "Signups not allowed for otp" (unknown email) lands here too — same UX
    // as success, but keep a server-side trace for real delivery failures.
    console.error('signInWithOtp failed:', error.message);
  }

  redirect('/login?enviado=1');
}
