'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAuth } from '@capo/db/session';
import { asLocale } from '@capo/i18n/locale';
import { localeCookieOptions, LOCALE_COOKIE } from '@/lib/i18n';

// Both actions run on the user's RLS-scoped client. The DB is the real gate,
// twice over:
//   - profiles_update_own / companies_update_own restrict WHICH row,
//   - the column grants from migration 0013 restrict WHICH columns.
// If either were missing, these would fail with 42501 rather than write
// something they shouldn't.

export async function setUserLanguage(formData: FormData): Promise<void> {
  const language = asLocale(String(formData.get('idioma') ?? ''));
  if (!language) redirect('/definicoes?erro=1');

  const { db, userId } = await requireAuth();
  const { error } = await db.from('profiles').update({ language }).eq('id', userId);
  if (error) {
    console.error('setUserLanguage failed:', error.message);
    redirect('/definicoes?erro=1');
  }

  (await cookies()).set(LOCALE_COOKIE, language, localeCookieOptions);
  // 'layout' scope, not the page: the nav, the billing banner and <html lang>
  // all live above this route and every one of them just changed language.
  revalidatePath('/', 'layout');
  redirect('/definicoes?guardado=1');
}

export async function setCompanyLanguage(formData: FormData): Promise<void> {
  const language = asLocale(String(formData.get('idioma') ?? ''));
  if (!language) redirect('/definicoes?erro=1');

  const { db, companyId } = await requireAuth();
  // NOTE: this changes the language Capo WRITES IN from here on. It does not
  // retranslate existing tasks, jobs, or memories — nothing does. That is why
  // the UI warns, and why the set_language chat tool deliberately cannot reach
  // this dial.
  const { error } = await db.from('companies').update({ language }).eq('id', companyId);
  if (error) {
    console.error('setCompanyLanguage failed:', error.message);
    redirect('/definicoes?erro=1');
  }

  revalidatePath('/', 'layout');
  redirect('/definicoes?guardado=1');
}
