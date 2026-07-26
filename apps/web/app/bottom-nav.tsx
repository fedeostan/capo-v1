'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Four destinations, not five. Hoje/Amanhã/Atrasadas were never separate
// places — they were one list with a different date filter, so they live
// behind the chips on /tarefas now.
const TABS = [
  { href: '/', label: 'Chat', icon: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /> },
  {
    href: '/tarefas',
    label: 'Tarefas',
    icon: (
      <>
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </>
    ),
  },
  {
    href: '/obras',
    label: 'Obras',
    icon: <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4" />,
  },
  {
    href: '/perfil',
    label: 'Perfil',
    icon: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
      </>
    ),
  },
];

export default function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="grid shrink-0 grid-cols-4 border-t border-zinc-500/20 bg-background pb-[env(safe-area-inset-bottom)]">
      {TABS.map(({ href, label, icon }) => {
        // Prefix match so /obras/[id] keeps its tab lit. '/' has to stay an
        // exact match or it would claim every route.
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
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
