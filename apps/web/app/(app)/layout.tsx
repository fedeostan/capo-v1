import { Banner } from '@/app/_ui/nav';
import { TabBar } from '@/app/_ui/tab-bar';
import { TopBar } from '@/app/_ui/top-bar';
import LocaleCookieSync from '@/app/locale-cookie-sync';
import { getAuthState } from '@capo/db/session';
import { getCatalog, type Catalog } from '@capo/i18n/catalog';
import { DEFAULT_LOCALE, type Locale } from '@capo/i18n/locale';
import { getBillingState, type BillingState } from '@/lib/billing';
import { countUnread } from '@/app/notifications/inbox';

// Both strips are Banner now. The tones carry the meaning that the old
// hand-picked fills only implied: `danger` for locked out, `warn` for a trial
// running down. Those solid tokens are pinned to the same value in BOTH themes
// on purpose — a billing warning is a fixed signal colour, not a themed
// surface — so the label cannot flip to near-black and vanish in dark mode,
// which is what bg-amber-500 + text-white did.
function BillingBanner({ billing, t }: { billing: BillingState; t: Catalog }) {
  if (!billing.enabled) return null;
  if (billing.blocked) {
    return (
      <Banner tone="danger" href="/subscricao">
        {t.billing.bannerBlocked}
      </Banner>
    );
  }
  if (billing.status === 'trialing' && billing.daysLeft <= 7) {
    return (
      <Banner tone="warn" href="/subscricao">
        {billing.daysLeft <= 0 ? t.billing.bannerTrialEnded : t.billing.bannerTrial(billing.daysLeft)}
      </Banner>
    );
  }
  return null;
}

// The unread badge, and the only always-visible way into the inbox.
//
// WHERE THIS LIVES, decided explicitly rather than by default:
//
// The tab bar was the obvious home and is the wrong one. All five slots are
// taken (_ui/tab-bar.tsx), and the two candidate moves are both worse than
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
    <Banner
      tone="info"
      href="/notificacoes"
      icon={<span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-on-solid" />}
    >
      {t.notifications.banner(unread)}
    </Banner>
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
      {/* A SIBLING of the strips and of the content column, never a child of
          it. That column is overflow-hidden — it clips anything absolutely
          positioned that tries to escape — and the drawer this bar owns is
          exactly that. The bar decides for itself which routes it appears on;
          see _ui/top-bar.tsx. */}
      {state.status === 'ok' && (
        <TopBar locale={locale} name={state.ctx.fullName} company={state.ctx.companyName} />
      )}
      <BillingBanner billing={billing} t={t} />
      <NotificationsStrip unread={unread} t={t} />
      {/* overflow-hidden is the shell's backstop: a route that forgets its own
          scroller gets clipped content (a loud bug) instead of pushing the tab
          bar off screen (a silent one). It also clips anything absolutely
          positioned that tries to escape the content column — nothing does
          today, but a future custom dropdown would need to live elsewhere. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      <TabBar locale={locale} />
      {state.status === 'ok' && <LocaleCookieSync locale={locale} />}
    </>
  );
}
