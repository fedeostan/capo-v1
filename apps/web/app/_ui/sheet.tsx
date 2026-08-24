'use client';

// The bottom sheet. The four hand-rolled ones it replaces have, between them,
// none of the following — every one of which is reproducible today:
//
//   1. Escape does not close it.
//   2. Tab walks OUT of it into the page behind, where a screen-reader user is
//      then reading invisible buttons.
//   3. Focus never enters it, so opening it with a keyboard leaves you where
//      you were.
//   4. The page behind scrolls when you flick the sheet.
//   5. It teleports in, which is why it reads as a browser pop-up rather than
//      part of the app.
//
// All five are handled by useOverlay, which this shares with the profile
// drawer — see ./use-overlay for why that is shared rather than copied.
//
// It lives in apps/web rather than @capo/ui because it genuinely needs to
// react; @capo/ui is 'use client'-free by contract.
import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useOverlay } from './use-overlay';

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const { mounted, panel } = useOverlay({ open, onClose });

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-fg/40 backdrop-blur-sm motion-safe:animate-[fade-in_var(--duration-base)_ease-out]"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto overscroll-contain rounded-t-sheet bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-sheet outline-none motion-safe:animate-[slide-up_var(--duration-slow)_var(--ease-spring)]"
      >
        {/* The grab handle. Decorative — the sheet is not drag-dismissible —
            but it is the universal signal for "this came up from the bottom
            and goes back down", which is what makes it read as native. */}
        <span aria-hidden className="mx-auto mb-3 block h-1 w-10 rounded-full bg-hairline" />
        {children}
      </div>
    </div>,
    document.body,
  );
}
