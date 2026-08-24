'use client';

// The left drawer: who you are, the five rooms, install, sign out.
//
// It shares useOverlay with Sheet, so it gets the focus trap, escape-to-close,
// scroll lock and client-mount gate rather than a second copy of them — see
// ./use-overlay for why that is not negotiable.
//
// Everything it links to is a REAL ROUTE, not a client-rendered panel. The
// handoff drew the five sections as panels sliding over the drawer; they are
// pages here because the settings forms behind them must keep saving with no
// JavaScript, and because a refresh inside a panel would throw the manager
// back to wherever the drawer was opened from.
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { Card } from '@capo/ui/card';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { ListRow } from '@/app/_ui/nav';
import SignOutButton from '@/app/(app)/perfil/sign-out-button';
import { useOverlay } from './use-overlay';

// Hand-maintained: nothing in this build exposes a version string to the
// client, and wiring a build-time inject for one footer line is not worth it.
// Bump it when you would have told a manager "update the app".
const APP_VERSION = '2.4.1';

export function ProfileDrawer({
  open,
  onClose,
  locale,
  name,
  company,
  initials,
}: {
  open: boolean;
  onClose: () => void;
  locale: Locale;
  name: string | null;
  company: string | null;
  initials: string;
}) {
  const t = getCatalog(locale);
  const { mounted, panel } = useOverlay({ open, onClose });

  if (!mounted) return null;

  const rooms = [
    { href: '/perfil/pessoal', ...t.shell.rooms.personal },
    { href: '/perfil/equipa', ...t.shell.rooms.team },
    { href: '/subscricao', ...t.shell.rooms.billing },
    { href: '/perfil/privacidade', ...t.shell.rooms.privacy },
    { href: '/perfil/definicoes', ...t.shell.rooms.settings },
  ];

  return createPortal(
    <>
      {/* pointer-events-none while closed is load-bearing: a full-screen scrim
          left interactive would swallow every tap on the page behind it, and
          the failure is both total and invisible. */}
      <div
        onClick={onClose}
        role="presentation"
        className={`fixed inset-0 z-40 bg-fg/40 transition-opacity ease-out ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      {/* Stays MOUNTED and translated off-screen rather than unmounting, which
          is what lets it animate out as well as in. Sheet returns null when
          closed and animates only on entry; do not "fix" one to match the
          other. inert while closed keeps the off-screen rooms out of the tab
          order and away from a screen reader. */}
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={t.shell.profile}
        aria-hidden={!open}
        inert={!open}
        tabIndex={-1}
        className={`fixed inset-y-0 left-0 z-50 flex w-80 max-w-[85vw] flex-col border-r border-hairline bg-surface shadow-sheet outline-none motion-safe:transition-transform motion-safe:duration-(--duration-slow) motion-safe:ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-hairline p-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <span
            aria-hidden
            className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand-quiet text-heading font-semibold text-brand"
          >
            {initials}
          </span>
          <span className="flex min-w-0 flex-col">
            {name && <span className="truncate text-heading font-semibold text-fg">{name}</span>}
            {company && (
              <span className="truncate text-caption text-fg-muted">
                {t.shell.role} · {company}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.shell.close}
            className="ml-auto grid min-h-11 min-w-11 shrink-0 place-items-center rounded-control text-fg-muted outline-none transition-colors ease-out hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">
          <Card padding="none">
            {rooms.map(room => (
              <ListRow key={room.href} href={room.href} title={room.title} meta={room.sub} />
            ))}
          </Card>

          {/* Deliberately minimal — label only. The full explanation lives on
              /instalar; a marketing block inside a settings drawer is something
              a manager scrolls past every single time. */}
          <Link
            href="/instalar"
            className="flex min-h-12 shrink-0 items-center justify-center rounded-card bg-brand-quiet px-4 text-body font-semibold text-brand no-underline outline-none transition-colors ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {t.profile.install}
          </Link>

          <div className="mt-auto flex flex-col items-center gap-2 pt-4">
            <SignOutButton locale={locale} />
            <span className="text-caption text-fg-faint">{t.shell.version(APP_VERSION)}</span>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
