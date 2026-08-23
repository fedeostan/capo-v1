// The row that every list screen currently builds by hand. 56px minimum, and
// the WHOLE row is the target — not the title inside it, which is how a row
// ends up needing three attempts to hit on a moving van.
import type { ReactNode } from 'react';

function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-4 w-4 shrink-0 text-fg-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

export function ListRow({
  leading,
  title,
  meta,
  trailing,
  href,
  danger = false,
}: {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  /** When present the row renders as a link and gains a chevron. */
  href?: string;
  danger?: boolean;
}) {
  const inner = (
    <>
      {leading && <span className="shrink-0">{leading}</span>}
      {/* min-w-0 is what lets a long task title truncate instead of forcing
          the row wider than the screen — a flex child defaults to min-width
          auto, which refuses to shrink below its content. */}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={`truncate text-body font-medium ${danger ? 'text-danger' : 'text-fg'}`}>
          {title}
        </span>
        {meta && <span className="truncate text-caption text-fg-muted">{meta}</span>}
      </span>
      {trailing}
      {href && <Chevron />}
    </>
  );

  const classes = [
    'flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left no-underline',
    'transition-colors ease-out hover:bg-surface-hover',
    'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
  ].join(' ');

  if (href) {
    return (
      <a href={href} className={classes}>
        {inner}
      </a>
    );
  }
  return <div className={classes}>{inner}</div>;
}
