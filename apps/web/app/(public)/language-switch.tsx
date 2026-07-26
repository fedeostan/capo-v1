import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { getCatalog } from '@capo/i18n/catalog';
import { asLocale, LOCALES, type Locale } from '@capo/i18n/locale';
import { localeCookieOptions, LOCALE_COOKIE } from '@/lib/i18n';

// Language switch for the signed-out surface.
//
// It exists because Accept-Language is a guess: a Portuguese manager on a phone
// set to English would otherwise land on an English signup page with no way
// out. Once signed in, profiles.language takes over and this disappears.
//
// Plain form POSTs, one per locale — no client JS, so it works on the first
// paint of a cold PWA.
async function setPublicLocale(formData: FormData): Promise<void> {
  'use server';
  const locale = asLocale(String(formData.get('locale')));
  if (!locale) return;
  (await cookies()).set(LOCALE_COOKIE, locale, localeCookieOptions);
  revalidatePath('/', 'layout');
}

export default function LanguageSwitch({ current }: { current: Locale }) {
  return (
    <div className="flex justify-center gap-1 pt-3 text-xs">
      {LOCALES.map(locale => (
        <form key={locale} action={setPublicLocale}>
          <input type="hidden" name="locale" value={locale} />
          <button
            type="submit"
            aria-current={locale === current ? 'true' : undefined}
            className={
              locale === current
                ? 'rounded-full bg-zinc-500/15 px-2.5 py-1 font-semibold'
                : 'rounded-full px-2.5 py-1 text-zinc-500 hover:bg-zinc-500/10'
            }
          >
            {getCatalog(locale).meta.languageName}
          </button>
        </form>
      ))}
    </div>
  );
}
