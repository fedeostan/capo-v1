'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createUserClient } from '@capo/db/user-client';
import { asLocale } from '@capo/i18n/locale';
import { localeCookieOptions, LOCALE_COOKIE, publicLocale } from '@/lib/i18n';

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
  // Falls back to whatever the page was already rendering in, so a submission
  // without the field (older cached HTML) still lands somewhere sensible. The
  // SQL function coerces an unknown value again — this is UX, not the guard.
  const language = asLocale(String(formData.get('idioma') ?? '')) ?? (await publicLocale());

  if (!companyName || !fullName) redirect('/onboarding?erro=dados');
  if (!phone) redirect('/onboarding?erro=telemovel');

  const supabase = await createUserClient();
  const { error } = await supabase.rpc('complete_onboarding', {
    p_company_name: companyName,
    p_full_name: fullName,
    p_phone: phone,
    p_language: language,
  });

  if (error) {
    // double-submit / already onboarded: just proceed into the app
    if (error.message.includes('profile already exists')) redirect('/whatsapp');
    if (error.message.includes('profiles_phone_key')) redirect('/onboarding?erro=telemovel-usado');
    console.error('complete_onboarding failed:', error.message);
    redirect('/onboarding?erro=guardar');
  }

  // Keep the hint cookie in step with what we just wrote to the DB, so the
  // signed-out surface and <html lang> agree from here on.
  (await cookies()).set(LOCALE_COOKIE, language, localeCookieOptions);

  // On to the WhatsApp handshake (issue #84), which then hands over to
  // /instalar. This step sits AFTER the profile row exists and not before, and
  // that ordering is load-bearing: Capo recognises an inbound WhatsApp message
  // by matching the sender against profiles.phone, which complete_onboarding
  // has only just written.
  //
  // `?novo=1` rides the rest of the chain so its last step lands the manager in
  // the CONVERSATION rather than on Home: the company has a name and a phone
  // number and nothing else, and the setup is finished by talking to Capo. It is
  // carried as a flag rather than baked into /instalar's button because that
  // screen is also reachable from Profile, where an established manager tapping
  // "open Capo" means Home.
  redirect('/whatsapp?novo=1');
}
