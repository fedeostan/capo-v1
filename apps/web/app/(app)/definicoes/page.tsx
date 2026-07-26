import type { Metadata } from 'next';
import Link from 'next/link';
import { getCatalog } from '@capo/i18n/catalog';
import { LOCALES, type Locale } from '@capo/i18n/locale';
import { ScreenShell } from '@capo/ui/dashboard-ui';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { setCompanyLanguage, setUserLanguage } from './actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.settings.title) };
}

// Submits on selection where JS is available, and still works without it —
// the visible Save button is the no-JS path.
function LanguagePills({
  name,
  current,
  action,
  save,
}: {
  name: string;
  current: Locale;
  action: (formData: FormData) => Promise<void>;
  save: string;
}) {
  return (
    <form action={action} className="space-y-2">
      <div className="flex gap-2">
        {LOCALES.map(option => (
          <label key={option} className="flex-1">
            <input
              type="radio"
              name={name}
              value={option}
              defaultChecked={option === current}
              className="peer sr-only"
            />
            <span className="block cursor-pointer rounded-lg border border-zinc-500/30 py-2 text-center text-sm peer-checked:border-orange-600 peer-checked:bg-orange-600/10 peer-checked:font-semibold">
              {getCatalog(option).meta.languageName}
            </span>
          </label>
        ))}
      </div>
      <button
        type="submit"
        className="w-full rounded-lg border border-zinc-500/30 py-2 text-sm font-semibold hover:bg-zinc-500/10"
      >
        {save}
      </button>
    </form>
  );
}

export default async function DefinicoesPage({
  searchParams,
}: {
  searchParams: Promise<{ guardado?: string; erro?: string }>;
}) {
  const { ctx, locale, t } = await requireAuthT();
  const { guardado, erro } = await searchParams;

  return (
    <ScreenShell title={t.settings.title} locale={locale}>
      {guardado && (
        <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-center text-sm text-emerald-700 dark:text-emerald-400">
          {t.settings.saved}
        </p>
      )}
      {erro && (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-center text-sm text-red-700 dark:text-red-400">
          {t.settings.failed}
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t.settings.yourLanguage}</h2>
        <p className="text-xs text-zinc-500">{t.settings.yourLanguageHint}</p>
        <LanguagePills name="idioma" current={ctx.locale} action={setUserLanguage} save={t.common.save} />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t.settings.companyLanguage}</h2>
        <p className="text-xs text-zinc-500">{t.settings.companyLanguageHint}</p>
        {/* The warning is the whole reason this dial is not reachable from chat:
            switching it does not retranslate anything already stored. */}
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {t.settings.companyLanguageWarning}
        </p>
        <LanguagePills name="idioma" current={ctx.companyLocale} action={setCompanyLanguage} save={t.common.save} />
      </section>

      <section className="pt-2">
        <Link href="/subscricao" className="text-sm text-orange-600 underline">
          {t.settings.billingLink}
        </Link>
      </section>
    </ScreenShell>
  );
}
