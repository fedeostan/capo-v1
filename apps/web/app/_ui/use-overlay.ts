'use client';

// The behaviours every overlay in this app must have, in one place. Lifted out
// of sheet.tsx unchanged — see that file's banner for the five failures each of
// these prevents, every one of which was reproducible in the hand-rolled sheets
// it replaced.
//
// EXTRACTED RATHER THAN COPIED, and that is the whole point. The profile drawer
// needs the identical four behaviours, and two copies of a focus trap is how
// one of them silently stops working: nothing in this repo's gate — tsc, lint,
// design-check, next build — can see a trap that has developed a hole. One
// implementation means one thing to get right and one thing to check.
//
// It lives in apps/web rather than @capo/ui because it is entirely browser
// behaviour, and that package is 'use client'-free by contract.
import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';

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

export function useOverlay({ open, onClose }: { open: boolean; onClose: () => void }): {
  mounted: boolean;
  panel: RefObject<HTMLDivElement | null>;
} {
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  // createPortal reaches for document.body, and Next runs 'use client' render
  // functions on the SERVER to build the initial HTML — where there is no
  // document. Rendering nothing until after the first client commit is what
  // makes an overlay that is open on first paint (a URL param, server-seeded
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
  // the hand-back, closing an overlay drops focus onto <body> and the next Tab
  // starts from the top of the page.
  // `mounted` is in the deps deliberately. Without it, an overlay that is
  // already open on the first render (a URL param, server-seeded state) runs
  // this effect while the panel is still null — first?.focus() no-ops — and
  // never runs it again, because flipping `mounted` would not change the deps.
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
      // without this the trap has a hole exactly when the overlay is emptiest.
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

  return { mounted, panel };
}
