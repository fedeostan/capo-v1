import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getAuthState } from '@capo/db/session';
import { getCatalog } from '@capo/i18n/catalog';
import { LOCALES } from '@capo/i18n/locale';
import { metadataTitle, publicCatalog } from '@/lib/i18n';
import { completeOnboarding } from './actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.onboarding.title) };
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string }>;
}) {
  // Session required; already-onboarded users skip straight to the app.
  const state = await getAuthState();
  if (state.status === 'unauthenticated') redirect('/login');
  if (state.status === 'ok') redirect('/');

  const { erro } = await searchParams;
  const { locale, t } = await publicCatalog();
  const errors = t.onboarding.errors;
  const errorText = erro ? errors[erro as keyof typeof errors] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">👷</p>
        <h1 className="text-2xl font-semibold">{t.onboarding.title}</h1>
        <p className="text-sm text-zinc-500">{t.onboarding.subtitle}</p>
      </div>

      <form action={completeOnboarding} className="space-y-3">
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t.onboarding.companyName}</span>
          <input
            type="text"
            name="empresa"
            required
            maxLength={120}
            placeholder={t.onboarding.companyPlaceholder}
            className="w-full rounded-lg border border-zinc-500/30 bg-background px-3 py-2.5 text-base outline-none focus:border-orange-600"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t.onboarding.yourName}</span>
          <input
            type="text"
            name="nome"
            required
            maxLength={120}
            autoComplete="name"
            placeholder={t.onboarding.yourNamePlaceholder}
            className="w-full rounded-lg border border-zinc-500/30 bg-background px-3 py-2.5 text-base outline-none focus:border-orange-600"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t.onboarding.phone}</span>
          <input
            type="tel"
            name="telemovel"
            required
            autoComplete="tel"
            inputMode="tel"
            placeholder={t.onboarding.phonePlaceholder}
            className="w-full rounded-lg border border-zinc-500/30 bg-background px-3 py-2.5 text-base outline-none focus:border-orange-600"
          />
          <span className="block text-xs text-zinc-500">{t.onboarding.phoneHint}</span>
        </label>

        {/* Radio pills rather than a <select>: three options, mobile-first, and
            no JS needed for the choice to submit. Pre-selected to whatever the
            page is already rendering in, so the common case is one less tap.
            This sets BOTH dials at signup — the company starts out speaking the
            language of whoever created it. */}
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t.onboarding.language}</legend>
          <div className="flex gap-2 pt-1">
            {LOCALES.map(option => (
              <label key={option} className="flex-1">
                <input
                  type="radio"
                  name="idioma"
                  value={option}
                  defaultChecked={option === locale}
                  className="peer sr-only"
                />
                <span className="block cursor-pointer rounded-lg border border-zinc-500/30 py-2 text-center text-sm peer-checked:border-orange-600 peer-checked:bg-orange-600/10 peer-checked:font-semibold">
                  {getCatalog(option).meta.languageName}
                </span>
              </label>
            ))}
          </div>
          <span className="block text-xs text-zinc-500">{t.onboarding.languageHint}</span>
        </fieldset>

        <button
          type="submit"
          className="w-full rounded-lg bg-orange-600 py-2.5 font-semibold text-white active:bg-orange-700"
        >
          {t.onboarding.submit}
        </button>
      </form>

      {errorText && (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-center text-sm text-red-700 dark:text-red-400">
          {errorText}
        </p>
      )}
    </div>
  );
}
