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
