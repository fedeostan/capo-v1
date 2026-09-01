'use client';

import { useState } from 'react';
import { Button } from '@capo/ui/button';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

// Sign-out has to take this device's push registration with it — but it must
// never be the reason sign-out fails or hangs. Every failure mode below (a
// service worker that never reaches "active", an offline device, a slow
// network) resolves in favour of letting the manager leave. A stranded push
// registration on a shared phone is a real problem, but it is strictly
// smaller than a manager who cannot sign out of a shared phone at all.
//
// Crews share handsets. Without this cleanup, a manager who signs out leaves
// a live registration behind, and the next person to sign in on that phone
// gets the first manager's alerts on their lock screen — alerts about work
// they may have no business seeing.
//
// It has to happen HERE and not in the route: the server never learns the
// endpoint, only the browser knows it.

// navigator.serviceWorker.ready only resolves once a worker for THIS page has
// reached the active state — it does not resolve merely because the API
// exists. If registration in sw-register.tsx never completed (a dropped
// sw.js fetch on bad site signal, private browsing blocking service-worker
// storage, a locked-down Android ROM), `ready` never settles and anything
// awaiting it hangs forever. A hard ceiling on the WHOLE cleanup — not just
// this one call — is what keeps any future addition to this block from
// being able to strand sign-out the same way.
const CLEANUP_TIMEOUT_MS = 1500;

function timeout(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Best-effort: tell the server to forget this device's registration.
async function deleteServerSide(endpoint: string): Promise<void> {
  await fetch('/api/push', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
}

// Unlike push-card.tsx's disable(), this gets no retry: sign-out is the last
// chance to unsubscribe before the session ends. Running the two halves
// independently (Promise.allSettled, not a sequential await) means an
// offline device — where fetch REJECTS outright rather than just returning a
// non-2xx — still unsubscribes locally instead of the exception skipping it.
// Gating unsubscribe() on a successful DELETE, the way push-card.tsx can
// afford to because it can simply ask the manager to try again, would be
// strictly worse here: it would trade a certain local cleanup for a rare
// server-side one.
async function cleanupThisDevice(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const registration = await navigator.serviceWorker.ready;
  const sub = await registration.pushManager.getSubscription();
  if (!sub) return;
  await Promise.allSettled([deleteServerSide(sub.endpoint), sub.unsubscribe()]);
}

export default function SignOutButton({ locale }: { locale: Locale }) {
  const t = getCatalog(locale);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    event.preventDefault();
    setBusy(true);

    // The race is the guarantee, not a comment promising one: whichever side
    // settles first, this always resolves within CLEANUP_TIMEOUT_MS, so the
    // POST below is reachable on every path — including a service worker
    // that never becomes ready. The cleanup's own errors are swallowed here
    // (not just "never block sign-out" but "can never even surface"), and if
    // the timeout wins, cleanup keeps running in the background where its
    // outcome no longer matters to this form.
    await Promise.race([cleanupThisDevice().catch(() => {}), timeout(CLEANUP_TIMEOUT_MS)]);

    form.submit();
  }

  return (
    <form method="post" action="/auth/signout" onSubmit={submit}>
      <Button type="submit" variant="destructive" fullWidth disabled={busy}>
        {t.common.signOut}
      </Button>
    </form>
  );
}
