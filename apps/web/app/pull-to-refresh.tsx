'use client';

// Pull-to-refresh for the app shell.
//
// This component IS the scroll container — it renders the <main> that each
// screen scrolls inside. That is the whole design: the pull translates the
// scroller and nothing else, so the header above it and the tab bar below it
// are structurally incapable of moving with the finger. A version that wrapped
// the screen, or that found the scroller from the layout with querySelector,
// would drag the chrome — which is the bug this exists to kill.
//
// A client component, so it takes `locale` (a plain string) and resolves the
// catalog itself, the same contract as _tasks/task-actions.tsx: the catalog
// holds interpolation functions, which cannot cross the RSC boundary.

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

/** Finger travel, after resistance, that arms the refresh. */
const THRESHOLD = 64;
/** Where the scroller parks while the refetch runs — the spinner band's height. */
const REST = 56;
/** Asymptote of the resistance curve: the pull can never exceed this. */
const MAX_PULL = 120;
/** A spinner that appears and vanishes in 90ms reads as a glitch, not a refresh. */
const MIN_SPINNER_MS = 550;
/** Hard stop, so a refetch that never settles cannot strand the spinner. */
const MAX_SPINNER_MS = 8000;
/** Ignore the first few px, so a tap is never read as a pull. */
const DEAD_ZONE = 6;
/** Vertical must beat horizontal by this much, or the gesture belongs to
    whatever is under the finger — the /tarefas filter chips are an
    overflow-x-auto row inside this very scroller. */
const AXIS_BIAS = 1.5;

/** The default <main> classes: what ScreenShell used to render itself.
 *
 *  `bg-bg`, not `bg-background`. --background aliases --surface (white), and
 *  this is the PAGE behind the cards, not a card — painting it white is what
 *  stops a card reading as an object. Gap is 6 (24px), the design's
 *  between-groups distance; `space-y-5` was off the scale entirely. */
const DEFAULT_SCROLLER =
  'flex-1 space-y-6 overflow-y-auto overscroll-contain bg-bg px-4 py-4';

/** Diminishing returns: 1:1 at the start, asymptotic to MAX_PULL. */
function resist(dy: number): number {
  return MAX_PULL * (1 - Math.exp(-dy / MAX_PULL));
}

export default function PullToRefresh({
  locale,
  className = DEFAULT_SCROLLER,
  disabled = false,
  children,
}: {
  locale: Locale;
  /** Classes for the <main>. Must keep overflow-y-auto — this is the scroller. */
  className?: string;
  /** Suppresses the gesture entirely (chat passes `busy` while streaming). */
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const t = getCatalog(locale).pullToRefresh;
  const router = useRouter();

  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Gesture bookkeeping lives in refs, not state: it changes on every touchmove
  // and must not re-render, and the listeners below are attached once, so their
  // closures must never read a stale value.
  const active = useRef(false);
  const owned = useRef(false); // we have preventDefault()ed; the gesture is ours
  const startY = useRef(0);
  const startX = useRef(0);
  const pull = useRef(0);
  const refreshingRef = useRef(false);
  const disabledRef = useRef(disabled);
  const startedAt = useRef(0);
  const reduced = useRef(false);

  useEffect(() => {
    refreshingRef.current = refreshing;
  }, [refreshing]);
  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  // Read in an effect, never during render: matchMedia does not exist on the
  // server, and reading it in render would be a hydration mismatch.
  useEffect(() => {
    reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // Written imperatively rather than through state: this runs once per frame
  // during a drag, and a re-render per frame would drop the animation. React
  // never fights us for these — we pass no `style` prop to <main>, and React
  // does not manage custom properties.
  const paint = useCallback((px: number, animate: boolean) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.style.transition =
      animate && !reduced.current ? 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
    el.style.transform = `translate3d(0, ${px}px, 0)`;
    // On the host, not the scroller: the spinner is the scroller's SIBLING, and
    // custom properties only inherit downwards.
    hostRef.current?.style.setProperty('--ptr-progress', String(Math.min(px / THRESHOLD, 1)));
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    // Park the scroller in the transformed state from the very first frame.
    // A transformed element paints in the positioned-descendants layer, so
    // this is also what keeps <main> above the spinner sitting behind it.
    paint(0, false);

    function release() {
      active.current = false;
      owned.current = false;
      pull.current = 0;
    }

    function onStart(e: TouchEvent) {
      if (disabledRef.current || refreshingRef.current) return;
      if (e.touches.length !== 1) return; // a pinch is not ours
      if (!el || el.scrollTop > 0) return; // only arm at the very top
      active.current = true;
      owned.current = false;
      pull.current = 0;
      startY.current = e.touches[0].clientY;
      startX.current = e.touches[0].clientX;
    }

    function onMove(e: TouchEvent) {
      if (!active.current) return;
      if (e.touches.length !== 1) {
        release();
        paint(0, true);
        return;
      }

      const dy = e.touches[0].clientY - startY.current;
      const dx = e.touches[0].clientX - startX.current;

      if (!owned.current) {
        if (Math.abs(dy) < DEAD_ZONE && Math.abs(dx) < DEAD_ZONE) return;
        // Dominant-axis check: a mostly-horizontal drag, or any upward one,
        // belongs to the scroller (or to a nested horizontal row). Claiming it
        // would make the /tarefas filter chips unpannable.
        if (dy <= 0 || Math.abs(dy) <= Math.abs(dx) * AXIS_BIAS) {
          release();
          return;
        }
        owned.current = true;
      }

      // preventDefault() only works because this listener is registered
      // natively with { passive: false } — React 19 attaches its synthetic
      // touch listeners passively at the root, where this would be a no-op.
      // Once iOS has seen it, native scrolling is cancelled for the rest of
      // the gesture, so we keep ownership until touchend even if the finger
      // travels back above the origin.
      e.preventDefault();
      pull.current = resist(Math.max(dy, 0));
      paint(pull.current, false);
    }

    function onEnd() {
      if (!active.current) return;
      const px = pull.current;
      const wasOwned = owned.current;
      release();
      if (!wasOwned) return;
      if (px >= THRESHOLD) {
        startedAt.current = Date.now();
        setRefreshing(true);
        paint(REST, true);
        // router.refresh() returns void and cannot be awaited. Wrapping it in a
        // transition is the supported way to observe it: React keeps isPending
        // true until the new RSC payload commits, so the spinner means "fresh
        // data is on its way", not merely "a request was fired". Every (app)
        // page is force-dynamic, so this is always a real server round trip.
        startTransition(() => {
          router.refresh();
        });
      } else {
        paint(0, true);
      }
    }

    function onCancel() {
      if (!active.current) return;
      release();
      paint(0, true);
    }

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onCancel);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
    };
  }, [paint, router]);

  // Retract once the refetch has landed AND the spinner has been visible long
  // enough to read as an action. If isPending never goes true — a future Next
  // that stops covering refresh() with the caller's transition, or a payload
  // that commits before this effect runs — the floor below still gives the
  // gesture a legible duration, so it degrades rather than breaking.
  useEffect(() => {
    if (!refreshing || isPending) return;
    const wait = Math.max(MIN_SPINNER_MS - (Date.now() - startedAt.current), 0);
    const id = setTimeout(() => {
      setRefreshing(false);
      paint(0, true);
    }, wait);
    return () => clearTimeout(id);
  }, [refreshing, isPending, paint]);

  // Belt and braces: offline, or a cold serverless start that never settles,
  // must not strand the spinner on screen forever.
  useEffect(() => {
    if (!refreshing) return;
    const id = setTimeout(() => {
      setRefreshing(false);
      paint(0, true);
    }, MAX_SPINNER_MS);
    return () => clearTimeout(id);
  }, [refreshing, paint]);

  return (
    // overflow-hidden is load-bearing: <main> is transformed, so it paints
    // above its non-positioned siblings — without clipping here, a pull would
    // draw the content straight over the tab bar.
    <div ref={hostRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center"
        style={{ height: `${REST}px` }}
      >
        <span
          className={`block h-5 w-5 rounded-full border-2 border-control border-t-transparent ${
            refreshing ? 'motion-safe:animate-spin' : ''
          }`}
          // While pulling, the spinner fades in and winds up with the finger:
          // direct manipulation, so it stays even under prefers-reduced-motion
          // (which is about motion the user did not cause). The free spin while
          // refreshing is the part that gets suppressed, via motion-safe:.
          style={
            refreshing
              ? undefined
              : {
                  opacity: 'var(--ptr-progress, 0)',
                  transform: 'rotate(calc(var(--ptr-progress, 0) * 360deg))',
                }
          }
        />
      </div>

      <main ref={scrollerRef} className={className}>
        {children}
      </main>

      <span role="status" aria-live="polite" className="sr-only">
        {refreshing ? t.refreshing : ''}
      </span>
    </div>
  );
}
