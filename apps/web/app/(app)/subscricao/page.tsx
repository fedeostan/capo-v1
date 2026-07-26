import type { Metadata } from 'next';
import { getBillingState } from '@/lib/billing';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import PullToRefresh from '@/app/pull-to-refresh';
import { startCheckout, openPortal } from './actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.billing.title) };
}

export default async function SubscricaoPage({
  searchParams,
}: {
  searchParams: Promise<{ sucesso?: string }>;
}) {
  const { ctx, locale, t } = await requireAuthT();
  const state = await getBillingState(ctx);
  const { sucesso } = await searchParams;

  return (
    // Pull-to-refresh earns its place here more than anywhere: coming back from
    // Stripe's hosted Checkout, the webhook may land a beat after the redirect,
    // and this is the screen where the manager is waiting to see it.
    <PullToRefresh locale={locale} className="flex-1 overflow-y-auto overscroll-contain bg-background">
      {/* min-h-full, not flex-1: a justify-center column taller than its scroll
          port would push its own top edge out of reach. */}
      <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-6 px-6 pb-16">
        <div className="space-y-2 text-center">
          <p className="text-4xl">💳</p>
          <h1 className="text-2xl font-semibold">{t.billing.title}</h1>
        </div>

        {sucesso && (
          <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-center text-sm text-emerald-700 dark:text-emerald-400">
            {t.billing.activated}
          </p>
        )}

        {!state.enabled ? (
          <p className="rounded-lg bg-zinc-500/10 px-3 py-2 text-center text-sm text-zinc-500">
            {t.billing.unavailable}
          </p>
        ) : (
          <>
            <div className="rounded-xl border border-zinc-500/20 p-4 text-center">
              <p className="text-sm font-medium">
                {state.status === 'trialing'
                  ? state.daysLeft >= 0
                    ? t.billing.trialDaysLeft(state.daysLeft)
                    : t.billing.trialEnded
                  : (t.billing.statusLabel[state.status as keyof typeof t.billing.statusLabel] ?? state.status)}
              </p>
              <p className="mt-1 text-xs text-zinc-500">{t.billing.price}</p>
            </div>

            {state.status === 'active' ? (
              <form action={openPortal}>
                <button
                  type="submit"
                  className="w-full rounded-lg border border-zinc-500/30 py-2.5 text-sm font-semibold hover:bg-zinc-500/10"
                >
                  {t.billing.manage}
                </button>
              </form>
            ) : (
              <form action={startCheckout}>
                <button
                  type="submit"
                  className="w-full rounded-lg bg-orange-600 py-2.5 font-semibold text-white active:bg-orange-700"
                >
                  {t.billing.subscribe}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </PullToRefresh>
  );
}
