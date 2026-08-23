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

export function Badge({
  tone = 'neutral',
  strikethrough = false,
  children,
}: {
  tone?: Tone;
  strikethrough?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-1 text-micro font-semibold uppercase tracking-wide ${TONE_TEXT[tone]} ${TONE_QUIET[tone]} ${strikethrough ? 'line-through' : ''}`}
    >
      {children}
    </span>
  );
}
