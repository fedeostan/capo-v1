'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@capo/db/user-client';

// Same normalization stance as the workers backfill in migration 0003: a bare
// PT mobile ("912345678") becomes +351912345678; anything else must already
// be E.164. The DB check constraint re-validates — this is UX, not the guard.
function normalizePhone(raw: string): string | null {
  const compact = raw.replace(/[\s\-().]/g, '');
  const phone = /^9\d{8}$/.test(compact) ? `+351${compact}` : compact;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

// Creates company + profile atomically via the complete_onboarding RPC — the
// only door into those tables (no INSERT policies exist). Runs on the user's
// JWT: the SQL function takes its identity from auth.uid(), never from here.
export async function completeOnboarding(formData: FormData): Promise<void> {
  const companyName = String(formData.get('empresa') ?? '').trim();
  const fullName = String(formData.get('nome') ?? '').trim();
  const phone = normalizePhone(String(formData.get('telemovel') ?? ''));

  if (!companyName || !fullName) redirect('/onboarding?erro=dados');
  if (!phone) redirect('/onboarding?erro=telemovel');

  const supabase = await createUserClient();
  const { error } = await supabase.rpc('complete_onboarding', {
    p_company_name: companyName,
    p_full_name: fullName,
    p_phone: phone,
  });

  if (error) {
    // double-submit / already onboarded: just proceed into the app
    if (error.message.includes('profile already exists')) redirect('/instalar');
    if (error.message.includes('profiles_phone_key')) redirect('/onboarding?erro=telemovel-usado');
    console.error('complete_onboarding failed:', error.message);
    redirect('/onboarding?erro=guardar');
  }

  redirect('/instalar');
}
