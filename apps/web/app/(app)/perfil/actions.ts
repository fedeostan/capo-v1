'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAuth } from '@capo/db/session';
import { ActiveBatchError, createTranslationBatch, revertTranslationBatch } from '@capo/core/translation';
import { getCatalog } from '@capo/i18n/catalog';
import { asLocale } from '@capo/i18n/locale';
import { assertNotBlocked } from '@/lib/billing';
import { localeCookieOptions, LOCALE_COOKIE } from '@/lib/i18n';
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
// Two independent dials:
//
//   profiles.language  — what Capo speaks to you and what this app renders in.
//                        Also settable by telling Capo "talk to me in English"
//                        (the set_language tool).
//   companies.language — what Capo WRITES: task titles, job names, memories.
//                        Moving it alone does not retranslate anything already
//                        stored, which is why the primary control below moves
//                        it together with a translation batch, and why the bare
//                        dial is demoted into the advanced disclosure.
//
// Plain redirects rather than useActionState: these are radio-pill forms that
// must work before client JS hydrates, same posture as sign-out above.
//
// The real guard is the grant level, as everywhere else here: migration 0014
// re-grants UPDATE only on (full_name, phone, language) for profiles and
// (name, language) for companies; 0015 does the same for the batch tables so
// the undo snapshot is immutable.

/**
 * The primary control: set what you read AND, optionally, bring the company's
 * stored data with it.
 *
 * Creates the batch but never runs it — translating hundreds of rows does not
 * fit in a server action, and a redirecting action has nowhere to report
 * progress. The client island on /perfil drives /api/translation/[id]/run.
 */
export async function saveLanguage(formData: FormData): Promise<void> {
  const language = asLocale(String(formData.get('idioma') ?? ''));
  if (!language) redirect('/perfil?erro=idioma');
  const translate = formData.get('traduzir') != null;

  const ctx = await requireAuth();
  const { db, userId, companyId, companyLocale } = ctx;

  const { error } = await db.from('profiles').update({ language }).eq('id', userId);
  if (error) {
    console.error('saveLanguage failed:', error.message);
    redirect('/perfil?erro=idioma');
  }
  (await cookies()).set(LOCALE_COOKIE, language, localeCookieOptions);

  let batchId: string | null = null;
  if (language !== companyLocale) {
    if (translate) {
      // assertNotBlocked ONLY on this branch, and the asymmetry is deliberate
      // rather than an oversight: a lapsed tenant must keep every dial on this
      // page (see the header comment), but must not be able to spend our model
      // budget on a few thousand translation calls.
      await assertNotBlocked(ctx);
      try {
        // Also flips companies.language — the dial and the rewrite move
        // together or not at all.
        ({ batchId } = await createTranslationBatch({
          db,
          companyId,
          userId,
          from: companyLocale,
          to: language,
          origin: 'web',
        }));
      } catch (e) {
        // ActiveBatchError is the partial unique index doing its job: a second
        // tab, or an impatient double-submit. Not worth its own message — the
        // running batch is already rendered on the page they land back on.
        console.error('saveLanguage translation failed:', e instanceof Error ? e.message : e);
        redirect(e instanceof ActiveBatchError ? '/perfil' : '/perfil?erro=idioma');
      }
    } else {
      const { error: dialError } = await db.from('companies').update({ language }).eq('id', companyId);
      if (dialError) {
        console.error('saveLanguage company dial failed:', dialError.message);
        redirect('/perfil?erro=idioma');
      }
    }
  }

  logEvent('profile.language_saved', { companyId, userId, language, translated: translate, batchId });
  // 'layout' scope, not the page: the nav and <html lang> live above this route
  // and both just changed language.
  revalidatePath('/', 'layout');
  redirect(batchId ? `/perfil?traducao=${batchId}` : '/perfil?guardado=idioma');
}

/** Undo, delegated wholesale to the security-definer RPC in 0015 so the replay
 *  is one atomic statement rather than hundreds of round trips. */
export async function revertTranslation(formData: FormData): Promise<void> {
  const batchId = String(formData.get('lote') ?? '');
  if (!batchId) redirect('/perfil?erro=reversao');

  const { db, companyId, userId } = await requireAuth();
  try {
    // The RPC re-checks the tenant itself (it is SECURITY DEFINER, so RLS does
    // not cover it) and restores companies.language along with the text.
    const result = await revertTranslationBatch(db, batchId);
    logEvent('profile.translation_reverted', { companyId, userId, batchId, ...result });
  } catch (e) {
    console.error('revertTranslation failed:', e instanceof Error ? e.message : e);
    redirect('/perfil?erro=reversao');
  }

  revalidatePath('/', 'layout');
  redirect('/perfil?guardado=reversao');
}

// ── the advanced dials ──────────────────────────────────────────────────────
// Unchanged, and still needed: a Spanish-speaking foreman joining a Portuguese
// company sets only his own dial and leaves the shared board alone.

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
