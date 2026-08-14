'use client';

import { useSyncExternalStore } from 'react';

// One statement of the rules about Apple, shared by the install guide and the
// push opt-in card. Two copies would drift, and the copy that drifted would be
// the one deciding whether a manager is told "install Capo first" or shown a
// button that silently never works.

export type Platform = 'detecting' | 'standalone' | 'ios' | 'other';

/** Browser facts. 'detecting' on the server pass, the real value after
 *  hydration. Note 'ios' already means NOT standalone — standalone is checked
 *  first — so callers never need to test both. */
export function detectPlatform(): Platform {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true);
  if (standalone) return 'standalone';
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return 'ios';
  return 'other';
}

const subscribe = () => () => {};

/** None of this changes while the page is open, so the subscription is a
 *  no-op; useSyncExternalStore is here for the server/client split, not for
 *  updates. */
export function useDetectedPlatform(): Platform {
  return useSyncExternalStore(subscribe, detectPlatform, () => 'detecting' as Platform);
}

// ── form factor ─────────────────────────────────────────────────────────────
// A SECOND question, deliberately not folded into detectPlatform() above.
// That one answers "is this Apple, is this already installed" and is consumed
// by the install guide and the push card; this one answers "can this person
// scan a QR code with a different device, or are they holding the only screen
// they have". One function answering both would serve two callers with two
// unrelated needs, and the copy that drifted would be the one deciding whether
// a manager is shown a code they cannot possibly scan.

export type FormFactor = 'detecting' | 'mobile' | 'desktop';

/**
 * Coarse pointer AND real touch points — the pair, because either alone is
 * wrong somewhere: a touchscreen laptop reports touch points while being driven
 * by a mouse, and some desktop browsers report a coarse pointer under remote
 * display.
 *
 * This is a HEURISTIC and both misreadings degrade to something usable, which
 * is why the handshake screen shows a link on every device and adds the QR only
 * on desktop: a laptop misread as mobile still gets a working button (wa.me
 * opens WhatsApp Desktop or Web), and a tablet misread as desktop gets a code
 * it cannot scan PLUS the link underneath.
 */
export function detectFormFactor(): FormFactor {
  return window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0
    ? 'mobile'
    : 'desktop';
}

/** 'detecting' on the server pass, the real value after hydration. Same no-op
 *  subscription as useDetectedPlatform: none of this changes while the page is
 *  open. */
export function useFormFactor(): FormFactor {
  return useSyncExternalStore(subscribe, detectFormFactor, () => 'detecting' as FormFactor);
}
