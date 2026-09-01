import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getAuthState } from '@capo/db/session';
import { Button } from '@capo/ui/button';
import { Field, Input } from '@capo/ui/field';
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
        <h1 className="text-title font-semibold">{t.onboarding.title}</h1>
        <p className="text-callout text-fg-muted">{t.onboarding.subtitle}</p>
      </div>

      <form action={completeOnboarding} className="space-y-3">
        <Field id="onboarding-empresa" label={t.onboarding.companyName}>
          {a11y => (
            <Input
              {...a11y}
              type="text"
              name="empresa"
              required
              maxLength={120}
              placeholder={t.onboarding.companyPlaceholder}
            />
          )}
        </Field>
        <Field id="onboarding-nome" label={t.onboarding.yourName}>
          {a11y => (
            <Input
              {...a11y}
              type="text"
              name="nome"
              required
              maxLength={120}
              autoComplete="name"
              placeholder={t.onboarding.yourNamePlaceholder}
            />
          )}
        </Field>
        <Field id="onboarding-telemovel" label={t.onboarding.phone} hint={t.onboarding.phoneHint}>
          {a11y => (
            <Input
              {...a11y}
              type="tel"
              name="telemovel"
              required
              autoComplete="tel"
              inputMode="tel"
              placeholder={t.onboarding.phonePlaceholder}
            />
          )}
        </Field>

        {/* Radio pills rather than a <select>: three options, mobile-first, and
            no JS needed for the choice to submit. Pre-selected to whatever the
            page is already rendering in, so the common case is one less tap.
            This sets BOTH dials at signup — the company starts out speaking the
            language of whoever created it. Same pill spelling as theme-pills on
            /perfil/definicoes, lifted to the 44px floor. */}
        <fieldset className="space-y-1">
          <legend className="text-callout font-medium text-fg">{t.onboarding.language}</legend>
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
                <span className="flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-control text-center text-callout peer-checked:border-brand peer-checked:bg-brand-quiet peer-checked:font-semibold">
                  {getCatalog(option).meta.languageName}
                </span>
              </label>
            ))}
          </div>
          <span className="block text-caption text-fg-muted">{t.onboarding.languageHint}</span>
        </fieldset>

        <Button type="submit" fullWidth>
          {t.onboarding.submit}
        </Button>
      </form>

      {errorText && (
        <p className="rounded-lg bg-danger-quiet px-3 py-2 text-center text-callout text-danger">
          {errorText}
        </p>
      )}
    </div>
  );
}
