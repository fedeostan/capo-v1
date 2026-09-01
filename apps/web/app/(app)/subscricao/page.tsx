import type { Metadata } from 'next';
import { Button } from '@capo/ui/button';
import { Card } from '@capo/ui/card';
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
          <h1 className="text-title font-semibold">{t.billing.title}</h1>
        </div>

        {sucesso && (
          <p className="rounded-lg bg-success-quiet px-3 py-2 text-center text-callout text-success">
            {t.billing.activated}
          </p>
        )}

        {!state.enabled ? (
          <p className="rounded-lg bg-surface-sunken px-3 py-2 text-center text-callout text-fg-muted">
            {t.billing.unavailable}
          </p>
        ) : (
          <>
            <Card>
              <p className="text-center text-callout font-medium">
                {state.status === 'trialing'
                  ? state.daysLeft >= 0
                    ? t.billing.trialDaysLeft(state.daysLeft)
                    : t.billing.trialEnded
                  : (t.billing.statusLabel[state.status as keyof typeof t.billing.statusLabel] ?? state.status)}
              </p>
              <p className="mt-1 text-center text-caption text-fg-muted">{t.billing.price}</p>
            </Card>

            {state.status === 'active' ? (
              <form action={openPortal}>
                <Button type="submit" variant="secondary" fullWidth>
                  {t.billing.manage}
                </Button>
              </form>
            ) : (
              <form action={startCheckout}>
                <Button type="submit" fullWidth>
                  {t.billing.subscribe}
                </Button>
              </form>
            )}
          </>
        )}
      </div>
    </PullToRefresh>
  );
}
