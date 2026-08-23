'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

// Hoje/Amanhã/Atrasadas were never separate places — they were one list with a
// different date filter, so they live behind the chips on /tarefas now. That
// freed the slots for the surfaces that were actually missing: Perfil, and
// Materiais, which is the anticipation list 00_VISION calls the killer feature
// and which nothing in the product surfaced until now. Materiais sits before
// Perfil because it is a daily-use screen and Perfil is a settings screen.
//
// EVERY TAB CARRIES TWO ICONS, and that is an accessibility requirement rather
// than a flourish. The bar it replaces signalled the active tab by COLOUR
// ALONE (orange versus grey). Roughly 1 in 12 men has a colour-vision
// deficiency and construction is a heavily male trade, so that is a real share
// of the actual users — and orange-versus-grey is a hard pair for the common
// type. Colour plus a filled shape works with no colour perception at all.
const TABS = [
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
    href: '/materiais',
    key: 'materials',
    outline: (
      <>
        <path d="M21 8v13H3V8" />
        <rect x="1" y="3" width="22" height="5" rx="1" />
        <path d="M10 12h4" />
      </>
    ),
    filled: (
      <>
        <path d="M21 8v13H3V8" fill="currentColor" />
        <rect x="1" y="3" width="22" height="5" rx="1" fill="currentColor" />
        <path d="M10 12h4" className="stroke-surface" />
      </>
    ),
  },
  {
    href: '/perfil',
    key: 'profile',
    outline: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
      </>
    ),
    filled: (
      <>
        <circle cx="12" cy="8" r="4" fill="currentColor" />
        <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" fill="currentColor" />
      </>
    ),
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
    <nav className="grid shrink-0 grid-cols-5 border-t border-hairline bg-surface/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-md">
      {TABS.map(({ href, key, outline, filled }) => {
        const label = nav[key as keyof typeof nav];
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
