import type { Metadata } from 'next';
import Link from 'next/link';
import { getCatalog } from '@capo/i18n/catalog';
import { LOCALES, type Locale } from '@capo/i18n/locale';
import { EmptyState, ScreenShell } from '@capo/ui/dashboard-ui';
import { loadTeam } from '@/app/dashboard-data';
import { getBillingState } from '@/lib/billing';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { setCompanyLanguage, setUserLanguage } from './actions';
import { AccountForm, CompanyForm } from './profile-forms';

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

// Plain radio pills + a submit button: no client JS, same posture as sign-out
// below. Three options is not worth a client component.
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
      <button
        type="submit"
        className="w-full rounded-lg border border-zinc-500/30 py-2 text-sm font-semibold hover:bg-zinc-500/10"
      >
        {save}
      </button>
    </form>
  );
}

// Everything about the company and the account lives here: it is the only tab
// that owns settings, so nothing else in the app needs a header action.
export default async function PerfilPage({
  searchParams,
}: {
  searchParams: Promise<{ guardado?: string; erro?: string }>;
}) {
  const { ctx, locale, t } = await requireAuthT();
  const { db, userId, companyId } = ctx;
  const { guardado, erro } = await searchParams;

  const [{ data: company }, { data: profile }, { data: claims }, team, billing] = await Promise.all([
    db.from('companies').select('name').eq('id', companyId).maybeSingle(),
    db.from('profiles').select('full_name, phone').eq('id', userId).maybeSingle(),
    db.auth.getClaims(),
    loadTeam(ctx),
    getBillingState(ctx),
  ]);

  const email = typeof claims?.claims?.email === 'string' ? claims.claims.email : null;

  return (
    <ScreenShell title={t.profile.title} subtitle={company?.name ?? undefined}>
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

      <Card title={t.profile.company}>
        <CompanyForm name={company?.name ?? ''} locale={locale} />
      </Card>

      <Card title={t.profile.yourAccount}>
        {/* Changing the login email is a Supabase auth flow with its own
            confirmation round trip — out of scope here, so it is read-only. */}
        {email && <p className="text-xs text-zinc-500">{email}</p>}
        <AccountForm fullName={profile?.full_name ?? ''} phone={profile?.phone ?? ''} locale={locale} />
      </Card>

      <Card title={t.settings.yourLanguage}>
        <p className="text-xs text-zinc-500">{t.settings.yourLanguageHint}</p>
        <LanguagePills current={ctx.locale} action={setUserLanguage} save={t.common.save} />
      </Card>

      <Card title={t.settings.companyLanguage}>
        <p className="text-xs text-zinc-500">{t.settings.companyLanguageHint}</p>
        {/* The warning is the whole reason this dial is unreachable from chat:
            switching it does not retranslate anything already stored. */}
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {t.settings.companyLanguageWarning}
        </p>
        <LanguagePills current={ctx.companyLocale} action={setCompanyLanguage} save={t.common.save} />
      </Card>

      <Card title={t.profile.team}>
        {/* Read-only on purpose: worker CRUD stays on Capo's add_worker tool.
            The chat writes. */}
        {team.length === 0 ? (
          <EmptyState text={t.profile.teamEmpty} cta={{ href: '/', label: t.profile.teamEmptyCta }} />
        ) : (
          <>
            <ul className="space-y-2">
              {team.map(worker => (
                <li key={worker.id} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{worker.name}</p>
                    <p className="text-xs text-zinc-500">
                      {[worker.trade, worker.phone].filter(Boolean).join(' · ') || t.profile.noContact}
                    </p>
                  </div>
                  {!worker.active && (
                    <span className="shrink-0 rounded-full bg-zinc-500/10 px-2 py-0.5 text-[11px] text-zinc-500">
                      {t.profile.inactive}
                    </span>
                  )}
                </li>
              ))}
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

      {/* Plain form POST: sign-out works even before client JS hydrates. */}
      <form method="post" action="/auth/signout">
        <button
          type="submit"
          className="w-full rounded-xl border border-zinc-500/20 py-2.5 text-sm font-medium text-red-600 hover:bg-red-600/5"
        >
          {t.common.signOut}
        </button>
      </form>
    </ScreenShell>
  );
}
