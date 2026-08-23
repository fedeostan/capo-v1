// A badge is read as a SHAPE, not a sentence — which is the one place 11px
// type is legitimate, and why --text-micro exists and is uppercase and
// tracked. Everything a human actually reads is 13px or larger.
import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'info' | 'warn' | 'danger' | 'success' | 'brand' | 'review';

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-fg-muted',
  info: 'text-info',
  warn: 'text-warn',
  danger: 'text-danger',
  success: 'text-success',
  brand: 'text-brand',
  // Violet deliberately, not amber or red: a completion claim awaiting the
  // manager is a decision to make, not a problem to fix. danger owns "wrong".
  review: 'text-review',
};

export const TONE_QUIET: Record<Tone, string> = {
  neutral: 'bg-surface-hover',
  info: 'bg-info-quiet',
  warn: 'bg-warn-quiet',
  danger: 'bg-danger-quiet',
  success: 'bg-success-quiet',
  brand: 'bg-brand-quiet',
  review: 'bg-review-quiet',
};

/** Two readings, and the difference is 11px versus 13px.
 *
 *  The default, `shape`, is the design's --text-micro: 11px, uppercase,
 *  letter-spaced. That is the ONE place the product goes below its 13px floor,
 *  and it is allowed there precisely because a short badge is recognised as a
 *  SHAPE rather than read as a sentence — NOVO, INFO, 3.
 *
 *  `sentence` is for a badge whose content is words. Capo's task statuses are
 *  the case that forced this: "A aguardar controlo" is nineteen characters and
 *  nobody recognises it as a shape — it gets read, so it obeys the 13px floor
 *  and drops the uppercasing and the tracking, both of which exist to make
 *  short shapes scannable and only make a phrase wider.
 *
 *  Width is the reason this is a variant rather than a preference. On a 375px
 *  phone the board gives the badge as much room as it asks for and truncates
 *  the TASK TITLE with what is left, so an uppercase phrase costs the one line
 *  the manager actually reads.
 *
 *  MEASURED in the gallery, on "A aguardar controlo": 155px as a shape, 140px
 *  as a sentence. Stated honestly, that recovers most but not all of the width
 *  — the pre-design-system badge was 11px sentence case at roughly 121px, and
 *  nothing here gets back to that, because the 13px floor is the whole point
 *  of the type scale and this label is text a manager reads. The trade is
 *  deliberate: 15px of title back, and a status that is legible outdoors. */
const READING = {
  shape: 'text-micro uppercase tracking-wide',
  sentence: 'text-caption',
} as const;

export function Badge({
  tone = 'neutral',
  strikethrough = false,
  reading = 'shape',
  children,
}: {
  tone?: Tone;
  strikethrough?: boolean;
  reading?: keyof typeof READING;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-1 font-semibold ${READING[reading]} ${TONE_TEXT[tone]} ${TONE_QUIET[tone]} ${strikethrough ? 'line-through' : ''}`}
    >
      {children}
    </span>
  );
}
