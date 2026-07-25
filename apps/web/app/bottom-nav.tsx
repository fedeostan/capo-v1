'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Five tabs, chosen to match how a manager actually moves through the day:
// talk to Capo → see the day → check the sites → check the crew → check what
// has to be bought.
//
// Hoje/Amanhã/Atrasadas used to be three separate tabs. They are one tab now
// with an in-screen switcher (AgendaTabs), which both freed the two slots the
// Equipa and Materiais screens needed AND puts the overdue count on screen
// permanently instead of behind a tab the manager has to think to open.
// `match` keeps the Hoje tab lit while the manager is on Amanhã/Atrasadas.
const TABS = [
  {
    href: '/',
    label: 'Chat',
    match: ['/'],
    icon: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  },
  {
    href: '/hoje',
    label: 'Hoje',
    match: ['/hoje', '/amanha', '/atrasadas'],
    icon: (
      <>
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </>
    ),
  },
  {
    href: '/obras',
    label: 'Obras',
    match: ['/obras'],
    icon: <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4" />,
  },
  {
    href: '/equipa',
    label: 'Equipa',
    match: ['/equipa'],
    icon: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      </>
    ),
  },
  {
    href: '/materiais',
    label: 'Materiais',
    match: ['/materiais'],
    icon: (
      <>
        <path d="M21 8v13H3V8" />
        <rect x="1" y="3" width="22" height="5" rx="1" />
        <path d="M10 12h4" />
      </>
    ),
  },
];

export default function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="grid shrink-0 grid-cols-5 border-t border-zinc-500/20 bg-background pb-[env(safe-area-inset-bottom)]">
      {TABS.map(({ href, label, match, icon }) => {
        // Sub-routes count as the section (e.g. /obras/<id> keeps Obras lit).
        const active = match.some(base => (base === '/' ? pathname === '/' : pathname.startsWith(base)));
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`flex flex-col items-center gap-0.5 py-2 text-[11px] ${
              active ? 'font-semibold text-orange-600' : 'text-zinc-500'
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {icon}
            </svg>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
