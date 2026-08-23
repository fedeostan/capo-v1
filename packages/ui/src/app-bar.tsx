// Sticky, translucent, blurred — so content is visibly passing underneath it,
// which is a status cue rather than decoration. Blur is permitted in exactly
// two places in this design: here and behind a sheet. Anywhere else it costs
// GPU and battery on a cheap Android phone for no information.
//
// No 'use client': position:sticky and backdrop-filter are pure CSS.
import type { ReactNode } from 'react';
import type { LinkComponent } from './link-as';

function BackChevron() {
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
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

type AppBarBase = {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  /** What to render the back link WITH — see link-as.ts. Defaults to a plain
   *  <a>, which is a full page load. apps/web passes next/link via
   *  _ui/nav.tsx, so Back does not rebuild the shell. */
  linkAs?: LinkComponent;
};

/** `backHref` is an explicit destination, never router.back(). Browser
 *  history can lead out of the app entirely; a declared destination cannot.
 *  It is also what keeps this component free of JavaScript.
 *
 *  `backHref` and `backLabel` travel together, enforced by the compiler. The
 *  label is spoken by a screen reader, and Capo speaks three languages — a
 *  hardcoded English default would announce "Back" on a Portuguese screen.
 *  Callers pass an already-translated string, so this package still needs no
 *  locale of its own. */
type AppBarProps = AppBarBase &
  ({ backHref: string; backLabel: string } | { backHref?: undefined; backLabel?: undefined });

export function AppBar({ title, subtitle, backHref, backLabel, action, linkAs: Link = 'a' }: AppBarProps) {
  return (
    <header className="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b border-hairline bg-surface/80 px-4 py-3 backdrop-blur-md">
      {backHref && (
        <Link
          href={backHref}
          aria-label={backLabel}
          className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-fg transition-colors ease-out hover:bg-surface-hover outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <BackChevron />
        </Link>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="truncate text-title font-semibold text-fg">{title}</h1>
        {subtitle && <p className="truncate text-caption text-fg-muted">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}
