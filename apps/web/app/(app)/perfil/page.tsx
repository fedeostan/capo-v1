import type { Metadata } from 'next';
import Link from 'next/link';
import { getCatalog, type Catalog } from '@capo/i18n/catalog';
import { LOCALES, type Locale } from '@capo/i18n/locale';
import { CONFIRM_POSTURES, type ConfirmPosture } from '@capo/db/posture';
import { EmptyState, ScreenShell } from '@capo/ui/dashboard-ui';
import { loadTeam, loadTeamLoad } from '@/app/dashboard-data';
import { getBillingState } from '@/lib/billing';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { countTranslatable } from '@capo/core/translation';
import { hasWhatsAppConsent } from '@capo/core/channels/whatsapp';
import { resolveTheme } from '@/lib/theme';
import { vapidPublicKey } from '@/lib/push';
import {
  revertTranslation,
  saveLanguage,
  setCompanyLanguage,
  setConfirmPosture,
  setUserLanguage,
  setWhatsAppConsent,
} from './actions';
import PullToRefresh from '@/app/pull-to-refresh';
import { AccountForm, CompanyForm } from './profile-forms';
import PushCard from './push-card';
import SignOutButton from './sign-out-button';
import ThemePills from './theme-pills';
import { TranslationProgress } from './translation-progress';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.profile.title) };
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-zinc-500/20 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
      {children}
    </section>
  );
}

// Plain radio pills: no client JS, same posture as sign-out below. Three
// options is not worth a client component.
function Pills({ current }: { current: Locale }) {
  return (
    <div className="flex gap-2">
      {LOCALES.map(option => (
        <label key={option} className="flex-1">
          <input
            type="radio"
            name="idioma"
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
  );
}

function SubmitButton({ label }: { label: string }) {
  return (
    <button
      type="submit"
      className="w-full rounded-lg border border-zinc-500/30 py-2 text-sm font-semibold hover:bg-zinc-500/10"
    >
      {label}
    </button>
  );
}

function LanguagePills({
  current,
  action,
  save,
}: {
  current: Locale;
  action: (formData: FormData) => Promise<void>;
  save: string;
}) {
  return (
    <form action={action} className="space-y-2">
      <Pills current={current} />
      <SubmitButton label={save} />
    </form>
  );
}

// Same shape again — two options, no client JS, works before hydration on a
// cold PWA. A radio pair rather than a checkbox on purpose: a checkbox that
// submits on change can be toggled by a mis-tap and would silently withdraw
// consent, whereas this needs an explicit choice AND an explicit save.
function WhatsAppConsentPills({ consenting, t }: { consenting: boolean; t: Catalog }) {
  return (
    <form action={setWhatsAppConsent} className="space-y-2">
      <div className="flex gap-2">
        {([true, false] as const).map(option => (
          <label key={String(option)} className="flex-1">
            <input
              type="radio"
              name="consentimento"
              value={option ? '1' : '0'}
              defaultChecked={option === consenting}
              className="peer sr-only"
            />
            <span className="block cursor-pointer rounded-lg border border-zinc-500/30 py-2 text-center text-sm peer-checked:border-orange-600 peer-checked:bg-orange-600/10 peer-checked:font-semibold">
              {option ? t.settings.whatsappConsentOption.yes : t.settings.whatsappConsentOption.no}
            </span>
          </label>
        ))}
      </div>
      <SubmitButton label={t.common.save} />
    </form>
  );
}

// The confirmation posture (0031, issue #57): does an instruction to Capo that
// CHANGES something act immediately, or show an approval card first?
//
// Two options with a line of explanation UNDER each, rather than the bare pills
// used for language and theme. Those three are all reversible in one tap and
// their names say what they do; this one is a genuine safety/speed trade-off,
// and a manager cannot pick between "Always ask" and "Go ahead" from the labels
// alone. The hint under each option is the control, not decoration.
function ConfirmPosturePills({ current, t }: { current: ConfirmPosture; t: Catalog }) {
  return (
    <form action={setConfirmPosture} className="space-y-2">
      <div className="space-y-2">
        {/* Indexing the two catalog records with a ConfirmPosture is the same
            tripwire themeOption uses: widen the union in @capo/db/posture
            without widening the copy and tsc fails right here. */}
        {CONFIRM_POSTURES.map(option => (
          <label key={option} className="block">
            <input
              type="radio"
              name="confirmacao"
              value={option}
              defaultChecked={option === current}
              className="peer sr-only"
            />
            <span className="block cursor-pointer rounded-lg border border-zinc-500/30 p-3 peer-checked:border-orange-600 peer-checked:bg-orange-600/10">
              <span className="block text-sm font-semibold">{t.settings.confirmPostureOption[option]}</span>
              <span className="mt-0.5 block text-xs text-zinc-500">
                {t.settings.confirmPostureOptionHint[option]}
              </span>
            </span>
          </label>
        ))}
      </div>
      <SubmitButton label={t.common.save} />
    </form>
  );
}

// The appearance pills used to live here, in the same shape as LanguagePills.
// They are a client component now (./theme-pills) because tapping one has to
// repaint the app before Save is pressed, and only the browser can do that.

// Everything about the company and the account lives here: it is the only tab
// that owns settings, so nothing else in the app needs a header action.
export default async function PerfilPage({
  searchParams,
}: {
  searchParams: Promise<{ guardado?: string; erro?: string; traducao?: string }>;
}) {
  const { ctx, locale, t } = await requireAuthT();
  const { db, userId, companyId } = ctx;
  const { guardado, erro } = await searchParams;
  const pushKey = vapidPublicKey();

  const [
    { data: company },
    { data: profile },
    { data: claims },
    team,
    billing,
    counts,
    { data: batch },
    theme,
  ] = await Promise.all([
    db.from('companies').select('name').eq('id', companyId).maybeSingle(),
    // select('*') for the deploy-ordering reason in AGENTS.md: 0025 adds the two
    // consent columns, and a bundle served before its migration should degrade
    // to "no consent on record" rather than fail the whole page.
    db.from('profiles').select('*').eq('id', userId).maybeSingle(),
    db.auth.getClaims(),
    loadTeam(ctx),
    getBillingState(ctx),
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
  const teamLoad = await loadTeamLoad(ctx);

  const email = typeof claims?.claims?.email === 'string' ? claims.claims.email : null;
  const whatsappConsenting = profile ? hasWhatsAppConsent(profile) : false;

  const batchInFlight = batch?.status === 'pending' || batch?.status === 'running' || batch?.status === 'failed';
  const canRevert = batch?.status === 'completed' && new Date(batch.expires_at) > new Date();

  return (
    <ScreenShell title={t.profile.title} subtitle={company?.name ?? undefined}>
      <PullToRefresh locale={locale}>
        {guardado && (
          <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-center text-sm text-emerald-700 dark:text-emerald-400">
            {guardado === 'reversao' ? t.settings.reverted : t.settings.saved}
          </p>
        )}
        {erro && (
          <p className="rounded-lg bg-red-500/10 px-3 py-2 text-center text-sm text-red-700 dark:text-red-400">
            {erro === 'reversao' ? t.settings.revertFailed : t.settings.failed}
          </p>
        )}

        <Card title={t.profile.company}>
          <CompanyForm name={company?.name ?? ''} locale={locale} />
        </Card>

        <Card title={t.profile.yourAccount}>
          {/* Changing the login email is a Supabase auth flow with its own
              confirmation round trip — out of scope here, so it is read-only. */}
          {email && <p className="text-xs text-zinc-500">{email}</p>}
          <AccountForm fullName={profile?.full_name ?? ''} phone={profile?.phone ?? ''} locale={locale} />
        </Card>

        {/* Directly under the account card, because it is about the phone number
            immediately above it. Nothing proactive is sent without this — see
            hasWhatsAppConsent and 0025_whatsapp_optin.sql. */}
        <Card title={t.settings.whatsappConsent}>
          <p className="text-xs text-zinc-500">{t.settings.whatsappConsentHint}</p>
          <p className={`text-xs ${whatsappConsenting ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
            {whatsappConsenting ? t.settings.whatsappConsentOn : t.settings.whatsappConsentOff}
          </p>
          <WhatsAppConsentPills consenting={whatsappConsenting} t={t} />
        </Card>

        {/* Not wrapped in <Card>: this component owns its own container so it
            can render nothing at all when push is unconfigured or unsupported,
            rather than leaving an empty bordered box on the screen. */}
        {pushKey && <PushCard locale={locale} vapidPublicKey={pushKey} />}

        {/* Directly above appearance, and deliberately not buried in the
            "advanced" disclosure the two language dials use: this is the one
            setting on the page that changes what Capo is allowed to do to the
            board without asking, so a manager has to be able to find it without
            knowing it exists. It reads off ctx, which is the same value the
            chat route and the WhatsApp webhook hand the guard — one source, so
            the screen cannot promise a posture the agent is not using. */}
        <Card title={t.settings.confirmPosture}>
          <p className="text-xs text-zinc-500">{t.settings.confirmPostureHint}</p>
          <ConfirmPosturePills current={ctx.confirmPosture} t={t} />
        </Card>

        {/* Above the language dials on purpose: appearance is personal and
            reversible, while the company language card carries a warning. */}
        <Card title={t.settings.appearance}>
          <p className="text-xs text-zinc-500">{t.settings.appearanceHint}</p>
          <ThemePills current={theme} locale={locale} />
        </Card>

        {/* One control, because "the language" is one thing to the manager. The
            two-dial split underneath is real and load-bearing, but it is an edge
            case (a foreman who speaks a different language from the crew), so it
            lives in the disclosure rather than on the surface. */}
        <Card title={t.settings.language}>
          <p className="text-xs text-zinc-500">{t.settings.languageHint}</p>

          <form action={saveLanguage} className="space-y-3">
            {/* Both dials move together here, so the pills show the one the
                manager thinks of as "the language" — what he reads. */}
            <Pills current={ctx.locale} />

            {counts.total > 0 ? (
              <>
                <label className="flex items-start gap-2 text-sm">
                  {/* Checked by default: carrying the data across is what he
                      means by changing the language. Unchecking is the escape
                      hatch, not the norm. */}
                  <input
                    type="checkbox"
                    name="traduzir"
                    defaultChecked
                    className="mt-0.5 size-4 shrink-0 accent-orange-600"
                  />
                  <span>{t.settings.translateExisting(counts)}</span>
                </label>
                <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  {t.settings.translateWarning}
                </p>
              </>
            ) : (
              <p className="text-xs text-zinc-500">{t.settings.translateNothing}</p>
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
            <form action={revertTranslation} className="space-y-2 border-t border-zinc-500/20 pt-3">
              <input type="hidden" name="lote" value={batch.id} />
              <p className="text-xs text-zinc-500">{t.settings.revertHint(30)}</p>
              <button
                type="submit"
                className="w-full rounded-lg border border-zinc-500/30 py-2 text-sm font-medium text-red-600 hover:bg-red-600/5"
              >
                {t.settings.revert}
              </button>
            </form>
          )}

          <details className="border-t border-zinc-500/20 pt-3">
            <summary className="cursor-pointer text-xs font-medium text-zinc-500">{t.settings.advanced}</summary>
            <div className="space-y-4 pt-3">
              <p className="text-xs text-zinc-500">{t.settings.advancedHint}</p>

              <div className="space-y-2">
                <h3 className="text-xs font-semibold">{t.settings.yourLanguage}</h3>
                <p className="text-xs text-zinc-500">{t.settings.yourLanguageHint}</p>
                <LanguagePills current={ctx.locale} action={setUserLanguage} save={t.common.save} />
              </div>

              <div className="space-y-2">
                <h3 className="text-xs font-semibold">{t.settings.companyLanguage}</h3>
                <p className="text-xs text-zinc-500">{t.settings.companyLanguageHint}</p>
                {/* Still the honest warning for THIS form: setting the dial on
                    its own is the one path that does not retranslate anything. */}
                <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  {t.settings.companyLanguageWarning}
                </p>
                <LanguagePills current={ctx.companyLocale} action={setCompanyLanguage} save={t.common.save} />
              </div>
            </div>
          </details>
        </Card>

        <Card title={t.profile.team}>
          {/* Read-only on purpose: worker CRUD stays on Capo's add_worker tool.
              The chat writes. */}
          {team.length === 0 ? (
            <EmptyState text={t.profile.teamEmpty} cta={{ href: '/', label: t.profile.teamEmptyCta }} />
          ) : (
            <>
              <ul className="space-y-3">
                {team.map(worker => {
                  const load = teamLoad[worker.id];
                  return (
                    <li key={worker.id} className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{worker.name}</p>
                        <p className="text-xs text-zinc-500">
                          {[worker.trade, worker.phone].filter(Boolean).join(' · ') || t.profile.noContact}
                        </p>
                        {/* Load turns the crew list from a phone book into an
                            answer to "who is free?" — the question actually
                            asked before assigning work. */}
                        {load && load.open > 0 && (
                          <p className="text-xs text-zinc-500">
                            {t.profile.workerLoad(load.today, load.tomorrow, load.open)}
                          </p>
                        )}
                        {/* THREE states, not two, and the middle one is new.
                            An active worker with no number was always the silent
                            failure worth shouting about — the daily WhatsApp
                            messages are addressed to workers.phone, so without
                            one they reach nobody. Since 0025 there is a second
                            way to be unreachable while looking fine: a number on
                            file but no recorded consent. Reporting that as
                            "receives WhatsApp" would be the product lying about
                            the very thing the manager needs to act on. */}
                        {worker.active &&
                          (!worker.phone ? (
                            <p className="mt-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                              {t.profile.noWhatsAppWarning}
                            </p>
                          ) : !hasWhatsAppConsent(worker) ? (
                            <p className="mt-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                              {t.profile.noConsentWarning}
                            </p>
                          ) : (
                            <p className="mt-0.5 text-[11px] text-zinc-500">{t.profile.receivesWhatsApp}</p>
                          ))}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {!worker.active && (
                          <span className="rounded-full bg-zinc-500/10 px-2 py-0.5 text-[11px] text-zinc-500">
                            {t.profile.inactive}
                          </span>
                        )}
                        {load && load.overdue > 0 && (
                          <span className="text-[11px] font-medium text-red-600">
                            {t.dashboard.overdueCount(load.overdue)}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="text-xs text-zinc-500">
                {t.profile.teamHint}{' '}
                <Link href="/" className="underline">
                  {t.profile.teamHintLink}
                </Link>
                .
              </p>
            </>
          )}
        </Card>

        {/* The inbox has no tab of its own (see (app)/layout.tsx). The shell
            strip is the way in while something is unread; this row is the way
            in the rest of the time, so the history stays reachable. */}
        <Card title={t.notifications.title}>
          <Link href="/notificacoes" className="inline-block text-sm text-orange-600 underline">
            {t.notifications.profileLink}
          </Link>
        </Card>

        <Card title={t.profile.subscription}>
          <p className="text-sm">
            {!billing.enabled
              ? t.billing.unavailable
              : billing.status === 'trialing'
                ? billing.daysLeft >= 0
                  ? t.billing.trialDaysLeft(billing.daysLeft)
                  : t.billing.trialEnded
                : (t.billing.statusLabel[billing.status as keyof typeof t.billing.statusLabel] ?? billing.status)}
          </p>
          <Link href="/subscricao" className="inline-block text-sm text-orange-600 underline">
            {t.profile.manageSubscription}
          </Link>
        </Card>

        <Card title={t.profile.app}>
          <Link href="/instalar" className="inline-block text-sm text-orange-600 underline">
            {t.profile.install}
          </Link>
        </Card>

        <SignOutButton locale={locale} />
      </PullToRefresh>
    </ScreenShell>
  );
}
