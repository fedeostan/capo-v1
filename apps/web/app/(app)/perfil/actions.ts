'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAuth } from '@capo/db/session';
import { getCatalog } from '@capo/i18n/catalog';
import { asLocale } from '@capo/i18n/locale';
import { localeCookieOptions, LOCALE_COOKIE } from '@/lib/i18n';
import { asTheme, themeCookieOptions, THEME_COOKIE } from '@/lib/theme';
import { logEvent } from '@/lib/log';

// Editing your own company name or contact details is a manager command, the
// same category as tapping "Concluir" — a sanctioned non-chat write path.
//
// Deliberately NO assertNotBlocked here, unlike every other write path in the
// app: a tenant whose subscription lapsed must still be able to correct their
// details and reach the billing page. Blocking that would be blocking them
// from paying us.
//
// The real guard is at the grant level, not here: migration 0011 revokes
// UPDATE on companies and re-grants only (name), and 0007 grants only
// (full_name, phone) on profiles. Even a forged request cannot touch
// company_id or the billing columns.

export type FormState = { ok?: true; error?: string } | null;

// Same normalization stance as onboarding/actions.ts: a bare PT mobile
// ("912345678") becomes +351912345678; anything else must already be E.164.
// The DB check constraint re-validates — this is UX, not the guard.
function normalizePhone(raw: string): string | null {
  const compact = raw.replace(/[\s\-().]/g, '');
  const phone = /^9\d{8}$/.test(compact) ? `+351${compact}` : compact;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

function validName(value: string): boolean {
  return value.length >= 1 && value.length <= 120;
}

export async function updateCompanyName(_prev: FormState, formData: FormData): Promise<FormState> {
  const { db, companyId, locale } = await requireAuth();
  const t = getCatalog(locale).profile.errors;

  const name = String(formData.get('nome') ?? '').trim();
  if (!validName(name)) return { error: t.companyName };

  const { error } = await db.from('companies').update({ name }).eq('id', companyId);
  if (error) {
    console.error('updateCompanyName failed:', error.message);
    return { error: t.save };
  }

  logEvent('profile.company_renamed', { companyId });
  revalidatePath('/perfil');
  return { ok: true };
}

export async function updateProfile(_prev: FormState, formData: FormData): Promise<FormState> {
  const { db, userId, companyId, locale } = await requireAuth();
  const t = getCatalog(locale).profile.errors;

  const fullName = String(formData.get('nome') ?? '').trim();
  const phone = normalizePhone(String(formData.get('telemovel') ?? ''));
  if (!validName(fullName)) return { error: t.fullName };
  if (!phone) return { error: t.phone };

  const { error } = await db.from('profiles').update({ full_name: fullName, phone }).eq('id', userId);
  if (error) {
    // profiles.phone is unique — the manager's number is how inbound routing
    // resolves a sender, so a collision is a real conflict, not a glitch.
    if (error.code === '23505') return { error: t.phoneTaken };
    console.error('updateProfile failed:', error.message);
    return { error: t.save };
  }

  logEvent('profile.updated', { companyId, userId });
  revalidatePath('/perfil');
  return { ok: true };
}

// ── language ────────────────────────────────────────────────────────────────
// Two independent dials, and only ONE of them is reachable from chat.
//
//   profiles.language  — what Capo speaks to you and what this app renders in.
//                        Also settable by telling Capo "talk to me in English"
//                        (the set_language tool).
//   companies.language — what Capo WRITES: task titles, job names, memories.
//                        Deliberately NOT reachable from chat: switching it
//                        does not retranslate anything already stored, so a
//                        casual "let's use English" would leave the shared
//                        dashboard permanently half-translated.
//
// Plain redirects rather than useActionState: these are radio-pill forms that
// must work before client JS hydrates, same posture as sign-out above.
//
// The real guard is the grant level, as everywhere else here: migration 0014
// re-grants UPDATE only on (full_name, phone, language) for profiles and
// (name, language) for companies.

export async function setUserLanguage(formData: FormData): Promise<void> {
  const language = asLocale(String(formData.get('idioma') ?? ''));
  if (!language) redirect('/perfil?erro=idioma');

  const { db, userId, companyId } = await requireAuth();
  const { error } = await db.from('profiles').update({ language }).eq('id', userId);
  if (error) {
    console.error('setUserLanguage failed:', error.message);
    redirect('/perfil?erro=idioma');
  }

  // Keep the signed-out surface and <html lang> in step with the DB.
  (await cookies()).set(LOCALE_COOKIE, language, localeCookieOptions);
  logEvent('profile.language_changed', { companyId, userId, language });
  // 'layout' scope, not the page: the nav and <html lang> live above this
  // route and both just changed language.
  revalidatePath('/', 'layout');
  redirect('/perfil?guardado=idioma');
}

export async function setCompanyLanguage(formData: FormData): Promise<void> {
  const language = asLocale(String(formData.get('idioma') ?? ''));
  if (!language) redirect('/perfil?erro=idioma');

  const { db, companyId } = await requireAuth();
  const { error } = await db.from('companies').update({ language }).eq('id', companyId);
  if (error) {
    console.error('setCompanyLanguage failed:', error.message);
    redirect('/perfil?erro=idioma');
  }

  logEvent('profile.company_language_changed', { companyId, language });
  revalidatePath('/', 'layout');
  redirect('/perfil?guardado=idioma');
}

// ── appearance ──────────────────────────────────────────────────────────────
// A third dial, and the odd one out: per DEVICE, not per user or per tenant.
// Cookie only, no DB write, so dark on the van tablet and light on the office
// laptop are both true at once.
//
// Deliberately no requireAuth(): this writes one cookie on the caller's own
// browser and reads nothing. A session round trip would buy nothing that
// document.cookie does not already allow.
//
// Constants live in lib/theme.ts, not here — a 'use server' module may only
// export async functions.

export async function setTheme(formData: FormData): Promise<void> {
  const theme = asTheme(String(formData.get('tema') ?? ''));
  if (!theme) redirect('/perfil?erro=tema');

  (await cookies()).set(THEME_COOKIE, theme, themeCookieOptions);
  logEvent('profile.theme_changed', { theme });
  // 'layout' scope, not the page: the class this sets lives on <html> in the
  // ROOT layout, above this route. Without it the change needs a hard reload.
  revalidatePath('/', 'layout');
  redirect('/perfil?guardado=tema');
}
