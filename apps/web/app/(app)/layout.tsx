import Link from 'next/link';
import BottomNav from '@/app/bottom-nav';
import LocaleCookieSync from '@/app/locale-cookie-sync';
import { getAuthState } from '@capo/db/session';
import { getCatalog, type Catalog } from '@capo/i18n/catalog';
import { DEFAULT_LOCALE, type Locale } from '@capo/i18n/locale';
import { getBillingState, type BillingState } from '@/lib/billing';

function BillingBanner({ billing, t }: { billing: BillingState; t: Catalog }) {
  if (!billing.enabled) return null;
  if (billing.blocked) {
    return (
      <Link href="/subscricao" className="block bg-red-600 px-4 py-1.5 text-center text-xs font-medium text-white">
        {t.billing.bannerBlocked}
      </Link>
    );
  }
  if (billing.status === 'trialing' && billing.daysLeft <= 7) {
    return (
      <Link href="/subscricao" className="block bg-amber-500 px-4 py-1.5 text-center text-xs font-medium text-white">
        {billing.daysLeft <= 0 ? t.billing.bannerTrialEnded : t.billing.bannerTrial(billing.daysLeft)}
      </Link>
    );
  }
  return null;
}

// The logged-in shell: everything in (app) sits above the tab bar. Auth is
// enforced per page/route via requireAuth()/getApiAuth() — a layout persists
// across client-side navigations, so it cannot be the gate. The billing
// banner below is opportunistic (getAuthState, never redirects): with no
// session yet, the page underneath will redirect via its own requireAuth().
export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const state = await getAuthState();
  const billing = state.status === 'ok' ? await getBillingState(state.ctx) : ({ enabled: false } as const);
  // No session yet means the page underneath is about to redirect; the default
  // locale is only ever used for that one throwaway frame.
  const locale: Locale = state.status === 'ok' ? state.ctx.locale : DEFAULT_LOCALE;
  const t = getCatalog(locale);

  return (
    <>
      <BillingBanner billing={billing} t={t} />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      <BottomNav locale={locale} />
      {state.status === 'ok' && <LocaleCookieSync locale={locale} />}
    </>
  );
}
