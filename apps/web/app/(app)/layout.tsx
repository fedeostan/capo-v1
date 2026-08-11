import Link from 'next/link';
import BottomNav from '@/app/bottom-nav';
import LocaleCookieSync from '@/app/locale-cookie-sync';
import { getAuthState } from '@capo/db/session';
import { getCatalog, type Catalog } from '@capo/i18n/catalog';
import { DEFAULT_LOCALE, type Locale } from '@capo/i18n/locale';
import { getBillingState, type BillingState } from '@/lib/billing';
import { countUnread } from '@/app/notifications/inbox';

function BillingBanner({ billing, t }: { billing: BillingState; t: Catalog }) {
  if (!billing.enabled) return null;
  if (billing.blocked) {
    return (
      <Link href="/subscricao" className="block shrink-0 bg-red-600 px-4 py-1.5 text-center text-xs font-medium text-white">
        {t.billing.bannerBlocked}
      </Link>
    );
  }
  if (billing.status === 'trialing' && billing.daysLeft <= 7) {
    return (
      <Link href="/subscricao" className="block shrink-0 bg-amber-500 px-4 py-1.5 text-center text-xs font-medium text-white">
        {billing.daysLeft <= 0 ? t.billing.bannerTrialEnded : t.billing.bannerTrial(billing.daysLeft)}
      </Link>
    );
  }
  return null;
}

// The unread badge, and the only always-visible way into the inbox.
//
// WHERE THIS LIVES, decided explicitly rather than by default:
//
// The tab bar was the obvious home and is the wrong one. All five slots are
// taken (bottom-nav.tsx), and the two candidate moves are both worse than
// this: a sixth tab drops every label to ~53px on a 320px phone, where
// "Materiais" no longer fits, and displacing an existing tab would demote a
// daily-use screen for a surface the manager visits only when something
// happened. A dot hung off an existing tab has the opposite problem — it
// would have to belong to a tab that does not own notifications.
//
// So: a full-width strip, matching BillingBanner directly above it. That is
// already this codebase's one pattern for "the shell needs to tell you
// something", it costs no tab-bar surgery, and it is unmissable in a way a
// 8px dot on a phone in a builder's pocket is not. When nothing is unread it
// renders nothing at all and the inbox is reached from /perfil.
//
// It also sidesteps the clipping trap: both strips are SIBLINGS of the
// overflow-hidden content column below, never children of it, so nothing here
// can be clipped by it. Anything absolutely positioned inside that column
// would be.
function NotificationsStrip({ unread, t }: { unread: number; t: Catalog }) {
  if (unread === 0) return null;
  return (
    <Link
      href="/notificacoes"
      className="flex shrink-0 items-center justify-center gap-1.5 bg-blue-600 px-4 py-1.5 text-center text-xs font-medium text-white"
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-white" />
      {t.notifications.banner(unread)}
    </Link>
  );
}

// The logged-in shell: everything in (app) sits above the tab bar. Auth is
// enforced per page/route via requireAuth()/getApiAuth() — a layout persists
// across client-side navigations, so it cannot be the gate. The billing
// banner below is opportunistic (getAuthState, never redirects): with no
// session yet, the page underneath will redirect via its own requireAuth().
export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const state = await getAuthState();
  // Both are opportunistic in the same way: no session yet means the page
  // underneath is about to redirect, so neither is worth a query. countUnread
  // swallows its own errors and answers 0 — the shell renders on top of every
  // route and must never be the reason a screen fails.
  const [billing, unread] =
    state.status === 'ok'
      ? await Promise.all([getBillingState(state.ctx), countUnread(state.ctx)])
      : [{ enabled: false } as const, 0];
  // No session yet means the page underneath is about to redirect; the default
  // locale is only ever used for that one throwaway frame.
  const locale: Locale = state.status === 'ok' ? state.ctx.locale : DEFAULT_LOCALE;
  const t = getCatalog(locale);

  return (
    <>
      <BillingBanner billing={billing} t={t} />
      <NotificationsStrip unread={unread} t={t} />
      {/* overflow-hidden is the shell's backstop: a route that forgets its own
          scroller gets clipped content (a loud bug) instead of pushing the tab
          bar off screen (a silent one). It also clips anything absolutely
          positioned that tries to escape the content column — nothing does
          today, but a future custom dropdown would need to live elsewhere. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      <BottomNav locale={locale} />
      {state.status === 'ok' && <LocaleCookieSync locale={locale} />}
    </>
  );
}
