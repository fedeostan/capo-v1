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
// It lives in apps/web rather than @capo/ui because it genuinely needs to
// react; @capo/ui is 'use client'-free by contract.
import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Whether the component has committed on the client yet. Same
// server/client-split use of useSyncExternalStore as apps/web/app/platform.ts
// — nothing here ever changes, so the subscription is a no-op; the point is
// the getServerSnapshot/getClientSnapshot split, which lets React answer
// `false` for the server pass and the first client render (so hydration
// matches) and `true` once mounted, with no setState call for the React
// Compiler lint to reject (see the sibling reasoning in
// (app)/_tasks/completion-sheet.tsx).
const subscribe = () => () => {};

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

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
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  // createPortal reaches for document.body, and Next runs 'use client' render
  // functions on the SERVER to build the initial HTML — where there is no
  // document. Rendering nothing until after the first client commit is what
  // makes a sheet that is open on first paint (a URL param, server-seeded
  // state) safe rather than a ReferenceError.
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  const focusables = useCallback(
    () => Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    [],
  );

  // Remember who opened it, move focus in, and give it back on close. Without
  // the hand-back, closing a sheet drops focus onto <body> and the next Tab
  // starts from the top of the page.
  // `mounted` is in the deps deliberately. Without it, a sheet that is already
  // open on the first render (a URL param, server-seeded state) runs this
  // effect while the panel is still null — first?.focus() no-ops — and never
  // runs it again, because flipping `mounted` would not change the deps.
  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    const first = focusables()[0] ?? panel.current;
    first?.focus();
    return () => returnTo.current?.focus();
  }, [open, mounted, focusables]);

  // Escape closes, and Tab cycles inside. The trap is a wrap-around rather
  // than a barrier: at the last element Tab goes to the first, and
  // Shift+Tab at the first goes to the last.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      // Nothing focusable inside: keep Tab on the panel rather than letting the
      // browser walk into the page behind. tabIndex={-1} makes the panel
      // programmatically focusable but absent from the sequential tab order, so
      // without this the trap has a hole exactly when the sheet is emptiest.
      if (items.length === 0) {
        e.preventDefault();
        panel.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, focusables]);

  // Lock the page behind. The shell already sets overflow:hidden on body, so
  // the thing that actually moves is the inner scroller — but locking body as
  // well costs nothing and covers a route that added its own.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

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
