'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getCatalog, type Catalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

// FOUR tabs, not five, and not the design's Home · Tasks · Chat · Obras ·
// Activity either. Two deliberate departures from the handoff:
//
//   Materiais and Perfil left the bar, but neither was DROPPED. Materiais is a
//   switch on /obras (a daily-use screen deserves one tap, not a hunt) and
//   Perfil is the drawer behind the persistent top bar. The handoff replaced
//   Materiais with an Activity tab outright; Federico's call (2026-08-24) was
//   to relocate both instead, which is why the count came out at four.
//
//   There is no Home tab YET. Home does not exist until Round 2, and a Home
//   tab pointing at / beside a Chat tab pointing at / would light BOTH under
//   the exact-match rule below. It becomes five when the launchpad ships.
//
// Atividade points at /notificacoes for now — not a placeholder, but the
// closest real surface: it already carries the unread count. Round 3 widens
// that screen into the full site feed rather than replacing it.
//
// EVERY TAB CARRIES TWO ICONS, and that is an accessibility requirement rather
// than a flourish. The bar this replaced signalled the active tab by COLOUR
// ALONE (orange versus grey). Roughly 1 in 12 men has a colour-vision
// deficiency and construction is a heavily male trade, so that is a real share
// of the actual users — and orange-versus-grey is a hard pair for the common
// type. Colour plus a filled shape works with no colour perception at all.
// `key` is typed against the nav catalog itself — `keyof Catalog['nav']` —
// rather than left to inference, so a typo'd key (or a `nav` catalog entry
// renamed without this list following) is a `tsc --noEmit` error at THIS
// array instead of an empty label discovered by looking at a phone.
type Tab = { href: string; key: keyof Catalog['nav']; outline: ReactNode; filled: ReactNode };

const TABS: Tab[] = [
  {
    href: '/',
    key: 'chat',
    outline: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
    filled: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="currentColor" />,
  },
  {
    href: '/tarefas',
    key: 'tasks',
    outline: (
      <>
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </>
    ),
    filled: (
      <>
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" fill="currentColor" />
        <path d="M9 11l3 3L22 4" className="stroke-surface" />
      </>
    ),
  },
  {
    href: '/obras',
    key: 'jobs',
    outline: <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4" />,
    filled: <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4" fill="currentColor" />,
  },
  {
    href: '/notificacoes',
    key: 'activity',
    outline: <path d="M3 12h4l3-8 4 16 3-8h4" />,
    // A pulse line has no interior to fill, so the "filled" twin is a HEAVIER
    // stroke instead. The rule the two icons exist for is that active must
    // differ in SHAPE as well as colour — weight satisfies it; duplicating the
    // outline would not.
    filled: <path d="M3 12h4l3-8 4 16 3-8h4" strokeWidth="3" />,
  },
];

// Icons are static; the words are not, so labels resolve per render from
// `locale` rather than being baked into TABS.
export function TabBar({ locale }: { locale: Locale }) {
  const pathname = usePathname();
  const nav = getCatalog(locale).nav;
  return (
    // Translucent + blurred so content is visibly passing underneath, which is
    // a status cue. pb-[env(safe-area-inset-bottom)] is load-bearing: without
    // it the tabs sit under the iPhone home indicator.
    <nav className="grid shrink-0 grid-cols-4 border-t border-hairline bg-surface/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-md">
      {TABS.map(({ href, key, outline, filled }) => {
        const label = nav[key];
        // Prefix match so /obras/[id] keeps its tab lit. '/' has to stay an
        // exact match or it would claim every route.
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-14 flex-col items-center justify-center gap-1 text-caption no-underline transition-colors ease-out outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
              active ? 'font-semibold text-brand' : 'text-fg-muted'
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              className={`h-6 w-6 transition-transform duration-(--duration-fast) ease-out ${
                active ? 'scale-110' : 'scale-100'
              }`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {active ? filled : outline}
            </svg>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
