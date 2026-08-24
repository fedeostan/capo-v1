import type { Metadata } from 'next';
import Link from 'next/link';
import { countTranslatable } from '@capo/core/translation';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { resolveTheme } from '@/lib/theme';
import { LanguageDriftNote } from '@/app/(app)/language-drift';
import { revertTranslation, saveLanguage, setCompanyLanguage, setUserLanguage } from '../actions';
import { RoomShell } from '../room-shell';
import {
  Card,
  ConfirmPosturePills,
  Flash,
  LanguagePills,
  Pills,
  SubmitButton,
} from '../settings-controls';
import ThemePills from '../theme-pills';
import { TranslationProgress } from '../translation-progress';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.shell.rooms.settings.title) };
}

export default async function DefinicoesPage({
  searchParams,
}: {
  searchParams: Promise<{ guardado?: string; erro?: string; traducao?: string }>;
}) {
  const { ctx, locale, t } = await requireAuthT();
  const { db, companyId } = ctx;
  const { guardado, erro } = await searchParams;

  const [counts, { data: batch }, theme] = await Promise.all([
    countTranslatable(db, companyId),
    // Only the most recent batch matters: the partial unique index in 0015
    // means at most one can be live, and undo is offered for the last one.
    db
      .from('translation_batches')
      .select('id, status, done_count, item_count, expires_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // A cookie read, not a query — it rides along here only to keep the
    // awaits in one place.
    resolveTheme(),
  ]);

  const batchInFlight = batch?.status === 'pending' || batch?.status === 'running' || batch?.status === 'failed';
  const canRevert = batch?.status === 'completed' && new Date(batch.expires_at) > new Date();

  return (
    <RoomShell title={t.shell.rooms.settings.title} backLabel={t.profile.title} locale={locale}>
      <Flash guardado={guardado} erro={erro} t={t} />

      {/* Deliberately not buried in the "advanced" disclosure the two language
          dials use: this is the one setting on the page that changes what Capo
          is allowed to do to the board without asking, so a manager has to be
          able to find it without knowing it exists. It reads off ctx, which is
          the same value the chat route and the WhatsApp webhook hand the guard
          — one source, so the screen cannot promise a posture the agent is not
          using. */}
      <Card title={t.settings.confirmPosture}>
        <p className="text-caption text-fg-muted">{t.settings.confirmPostureHint}</p>
        <ConfirmPosturePills current={ctx.confirmPosture} t={t} />
      </Card>

      {/* Above the language dials on purpose: appearance is personal and
          reversible, while the company language card carries a warning. */}
      <Card title={t.settings.appearance}>
        <p className="text-caption text-fg-muted">{t.settings.appearanceHint}</p>
        <ThemePills current={theme} locale={locale} />
      </Card>

      {/* One control, because "the language" is one thing to the manager. The
          two-dial split underneath is real and load-bearing, but it is an edge
          case (a foreman who speaks a different language from the crew), so it
          lives in the disclosure rather than on the surface. */}
      <Card title={t.settings.language}>
        <p className="text-caption text-fg-muted">{t.settings.languageHint}</p>

        {/* Above the control, not inside the "advanced" disclosure: the whole
            failure this notice exists for is a manager who does not know the
            two dials are two settings, and he will never open a disclosure
            about a split he has not heard of. Saving through the form below
            with both dials moving together is what makes it disappear. */}
        <LanguageDriftNote locale={ctx.locale} companyLocale={ctx.companyLocale} />

        <form action={saveLanguage} className="space-y-3">
          {/* Both dials move together here, so the pills show the one the
              manager thinks of as "the language" — what he reads. */}
          <Pills current={ctx.locale} />

          {counts.total > 0 ? (
            <>
              <label className="flex items-start gap-2 text-callout">
                {/* Checked by default: carrying the data across is what he
                    means by changing the language. Unchecking is the escape
                    hatch, not the norm. */}
                <input
                  type="checkbox"
                  name="traduzir"
                  defaultChecked
                  className="mt-1 size-4 shrink-0 accent-brand"
                />
                <span>{t.settings.translateExisting(counts)}</span>
              </label>
              <p className="rounded-lg bg-warn-quiet px-3 py-2 text-caption text-warn">
                {t.settings.translateWarning}
              </p>
            </>
          ) : (
            <p className="text-caption text-fg-muted">{t.settings.translateNothing}</p>
          )}

          <SubmitButton label={t.common.save} />
        </form>

        {/* Rendered from the batch row, not from the redirect param: a reload,
            a second tab, or a batch started from chat all show the same thing. */}
        {batch && batchInFlight && (
          <TranslationProgress
            batchId={batch.id}
            initialDone={batch.done_count}
            initialTotal={batch.item_count}
            initialStatus={batch.status as 'pending' | 'running' | 'failed'}
            locale={locale}
          />
        )}

        {batch && canRevert && (
          <form action={revertTranslation} className="space-y-2 border-t border-hairline pt-3">
            <input type="hidden" name="lote" value={batch.id} />
            <p className="text-caption text-fg-muted">{t.settings.revertHint(30)}</p>
            <button
              type="submit"
              className="w-full rounded-lg border border-control py-2 text-callout font-medium text-danger hover:bg-danger-quiet"
            >
              {t.settings.revert}
            </button>
          </form>
        )}

        <details className="border-t border-hairline pt-3">
          <summary className="cursor-pointer text-caption font-medium text-fg-muted">{t.settings.advanced}</summary>
          <div className="space-y-4 pt-3">
            <p className="text-caption text-fg-muted">{t.settings.advancedHint}</p>

            <div className="space-y-2">
              <h3 className="text-caption font-semibold">{t.settings.yourLanguage}</h3>
              <p className="text-caption text-fg-muted">{t.settings.yourLanguageHint}</p>
              <LanguagePills current={ctx.locale} action={setUserLanguage} save={t.common.save} />
            </div>

            <div className="space-y-2">
              <h3 className="text-caption font-semibold">{t.settings.companyLanguage}</h3>
              <p className="text-caption text-fg-muted">{t.settings.companyLanguageHint}</p>
              {/* Still the honest warning for THIS form: setting the dial on
                  its own is the one path that does not retranslate anything. */}
              <p className="rounded-lg bg-warn-quiet px-3 py-2 text-caption text-warn">
                {t.settings.companyLanguageWarning}
              </p>
              <LanguagePills current={ctx.companyLocale} action={setCompanyLanguage} save={t.common.save} />
            </div>
          </div>
        </details>
      </Card>

      {/* Federico's own words for issue #51: "you go to profile, then you
          have the cron jobs section. You press on the cron jobs section, and
          then you go inside." It sits in Settings rather than Privacy
          (Federico, 2026-08-24): a daily summary at 07:00 is about how Capo is
          used, not about what it discloses. */}
      <Card title={t.automations.title}>
        <p className="text-caption text-fg-muted">{t.automations.subtitle}</p>
        <Link href="/perfil/automacoes" className="inline-block text-callout text-brand underline">
          {t.automations.profileLink}
        </Link>
      </Card>

      <Card title={t.profile.app}>
        <Link href="/instalar" className="inline-block text-callout text-brand underline">
          {t.profile.install}
        </Link>
      </Card>
    </RoomShell>
  );
}
