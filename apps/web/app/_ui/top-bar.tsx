'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { ProfileDrawer } from './profile-drawer';

// Which routes get the persistent bar.
//
// SELF-HIDING RATHER THAN OPTED OUT PER SCREEN. A drill-down (/tarefas/[id],
// /obras/[id], /perfil/*) carries its own AppBar, because that bar holds Back
// and Back outranks the avatar there. Making each of those screens declare
// "no top bar" would be a rule somebody eventually forgets, and the symptom is
// two stacked bars on one screen — which looks like a rendering bug rather
// than a missed convention.
//
// Exact match, never a prefix: startsWith('/obras') would also claim
// /obras/[id], where the back link matters more than the avatar.
const TAB_ROOTS = ['/', '/tarefas', '/chat', '/obras', '/atividade'];

// First letter of the first two words. Not a slice of the whole string: "Miguel
// Ferreira" must read MF, and a manager with one name gets one letter rather
// than a padded pair.
function initialsOf(name: string | null): string {
  if (!name) return '·';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  return parts
    .slice(0, 2)
    .map(p => p[0]!.toUpperCase())
    .join('');
}

function IconFrame({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function TopBar({
  locale,
  name,
  company,
}: {
  locale: Locale;
  name: string | null;
  company: string | null;
}) {
  const t = getCatalog(locale).shell;
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  if (!TAB_ROOTS.includes(pathname)) return null;

  const initials = initialsOf(name);
  const iconButton =
    'grid min-h-11 min-w-11 shrink-0 place-items-center rounded-control text-fg-muted outline-none transition-colors ease-out hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline bg-surface px-2 py-1 pt-[max(0.25rem,env(safe-area-inset-top))]">
        <div className="flex min-w-0 items-center">
          {/* The burger exists purely for affordance: in testing the avatar
              alone did not read as "menu". Both it and the block beside it open
              the same drawer. */}
          <button type="button" onClick={() => setOpen(true)} aria-label={t.openMenu} className={iconButton}>
            <IconFrame>
              <path d="M4 7h16M4 12h16M4 17h16" />
            </IconFrame>
          </button>

          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={t.profile}
            className="flex min-h-11 min-w-0 items-center gap-2 rounded-control px-1 outline-none transition-colors ease-out hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
          >
            <span
              aria-hidden
              className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-quiet text-caption font-semibold text-brand"
            >
              {initials}
              {/* Presence dot. Decorative — it says "signed in", which the
                  presence of the whole bar already says — so it is aria-hidden
                  rather than given a label nobody needs read aloud. */}
              <span className="absolute -right-px -bottom-px h-2 w-2 rounded-full border-2 border-surface bg-success-solid" />
            </span>
            {/* Hidden below 360px rather than truncated to nothing: two
                ellipses where a name should be is worse than an avatar alone,
                and the right-hand group must keep its 44px targets. */}
            <span className="hidden min-w-0 flex-col items-start leading-tight min-[360px]:flex">
              {name && <span className="truncate text-caption font-semibold text-fg">{name}</span>}
              {company && <span className="truncate text-micro text-fg-faint">{company}</span>}
            </span>
          </button>
        </div>

        <div className="flex shrink-0 items-center">
          {/* DISABLED, not a no-op handler. Capo has no search of any kind, and
              a button that reports itself to a screen reader as working while
              doing nothing is the one version of "the icon is just there" that
              cannot ship. `title` carries the reason on hover and long-press. */}
          <button type="button" disabled aria-label={t.search} title={t.searchUnavailable} className={`${iconButton} disabled:pointer-events-none disabled:opacity-40`}>
            <IconFrame>
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.6-3.6" />
            </IconFrame>
          </button>

          <Link href="/chat?voice=1" aria-label={t.voiceNote} className={`${iconButton} no-underline`}>
            <IconFrame>
              <rect x="9" y="2" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
            </IconFrame>
          </Link>

          {/* The only solid brand fill in the bar. Do not add a second — one
              primary per screen is a design-system rule, and this is the bar
              that appears on every screen. */}
          <Link
            href="/chat?compose=1"
            aria-label={t.newTask}
            className="ml-1 grid min-h-11 min-w-11 shrink-0 place-items-center rounded-control bg-brand text-on-brand no-underline outline-none transition-colors ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <IconFrame>
              <path d="M12 5v14M5 12h14" />
            </IconFrame>
          </Link>
        </div>
      </header>

      <ProfileDrawer
        open={open}
        onClose={() => setOpen(false)}
        locale={locale}
        name={name}
        company={company}
        initials={initials}
      />
    </>
  );
}
