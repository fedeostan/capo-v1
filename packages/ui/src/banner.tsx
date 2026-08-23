// The full-width shell strip. Two exist today (billing, notifications) and
// they were written separately.
//
// A caller must keep a Banner a SIBLING of the app's overflow-hidden content
// column, never a child of it — a child gets clipped. That constraint lives
// in apps/web/app/(app)/layout.tsx and is restated here because this is the
// component somebody will reach for when adding a third strip.
import type { ReactNode } from 'react';
import type { Tone } from './badge';

// The five status tones use the `-solid` tokens, not `--danger`/`--info`
// directly: those solid tokens are pinned to the same value in both themes
// (Task 2), because a danger banner is a fixed signal colour, not a themed
// surface — it stays red in light and dark alike, so its label must not flip
// to near-black and vanish. `--on-solid` is white in both themes for the
// same reason. `neutral` is the deliberate exception: it carries no signal
// colour, so it SHOULD follow the theme, and uses `bg-fg text-bg` instead.
const SOLID: Record<Tone, string> = {
  neutral: 'bg-fg text-bg',
  info: 'bg-info-solid text-on-solid',
  warn: 'bg-warn-solid text-on-solid',
  danger: 'bg-danger-solid text-on-solid',
  success: 'bg-success-solid text-on-solid',
  brand: 'bg-brand-solid text-on-solid',
  review: 'bg-review-solid text-on-solid',
};

export function Banner({
  tone = 'info',
  href,
  icon,
  children,
}: {
  tone?: Tone;
  href?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const classes = `flex shrink-0 items-center justify-center gap-2 px-4 py-2 text-center text-caption font-medium no-underline ${SOLID[tone]}`;
  if (href) {
    return (
      <a href={href} className={classes}>
        {icon}
        {children}
      </a>
    );
  }
  return <div className={classes}>{icon}{children}</div>;
}
