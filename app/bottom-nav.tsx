'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Chat', icon: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /> },
  {
    href: '/hoje',
    label: 'Hoje',
    icon: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </>
    ),
  },
  {
    href: '/amanha',
    label: 'Amanhã',
    icon: (
      <>
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </>
    ),
  },
  {
    href: '/atrasadas',
    label: 'Atrasadas',
    icon: (
      <>
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <path d="M12 9v4M12 17h.01" />
      </>
    ),
  },
  {
    href: '/obras',
    label: 'Obras',
    icon: <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4" />,
  },
];

export default function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="grid shrink-0 grid-cols-5 border-t border-zinc-500/20 bg-background pb-[env(safe-area-inset-bottom)]">
      {TABS.map(({ href, label, icon }) => {
        const active = pathname === href;
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
