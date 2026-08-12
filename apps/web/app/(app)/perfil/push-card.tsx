'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { useDetectedPlatform } from '@/app/platform';

// The opt-in for lock-screen alerts.
//
// THE PERMISSION PROMPT IS ONE SHOT. If the manager answers "don't allow", the
// browser remembers forever and no code we write can ever ask again — they
// would have to dig through phone settings. That is the whole reason this
// lives behind a button they deliberately press and is never fired on load,
// and why the denied state below has explanatory copy and no button.

/** The VAPID public key arrives as standard base64url and the Push API wants
 *  raw bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalised);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

type State = 'loading' | 'unsupported' | 'ios-needs-install' | 'denied' | 'off' | 'on';

export default function PushCard({
  locale,
  vapidPublicKey,
}: {
  locale: Locale;
  vapidPublicKey: string;
}) {
  const t = getCatalog(locale);
  const platform = useDetectedPlatform();
  const [state, setState] = useState<State>('loading');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const register = useCallback(async (sub: PushSubscription) => {
    const res = await fetch('/api/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!res.ok) throw new Error('register failed');
  }, []);

  // Work out where we stand, and re-register whatever the browser currently
  // holds. Idempotent, and this is what actually covers an endpoint the phone
  // rotated on its own while nobody was logged in — the service worker's
  // pushsubscriptionchange handler cannot authenticate in that case.
  useEffect(() => {
    if (platform === 'detecting') return;
    let cancelled = false;

    (async () => {
      // Checked BEFORE the capability probe below, deliberately: WebKit gates
      // PushManager/Notification behind a home-screen install, so on an
      // iPhone in a plain Safari tab those APIs are likely just undefined —
      // the capability check below would catch that first and render
      // nothing, silently skipping the one state this screen has specifically
      // for that device. 'ios' already means NOT standalone (checked first in
      // detectPlatform()), so no other platform's behaviour changes by moving
      // this above the probe.
      if (platform === 'ios') {
        if (!cancelled) setState('ios-needs-install');
        return;
      }
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        if (!cancelled) setState('unsupported');
        return;
      }
      if (Notification.permission === 'denied') {
        if (!cancelled) setState('denied');
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (cancelled) return;
      if (existing && Notification.permission === 'granted') {
        try {
          await register(existing);
        } catch {
          // A failed re-sync is not worth an error message: the alert path
          // still works from whatever row the server already has.
        }
        if (!cancelled) setState('on');
        return;
      }
      if (!cancelled) setState('off');
    })();

    return () => {
      cancelled = true;
    };
  }, [platform, register]);

  async function enable() {
    setBusy(true);
    setFailed(false);
    try {
      // Must happen inside the click. A prompt raised outside a user gesture
      // is refused by Safari outright.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const sub =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        }));
      await register(sub);
      setState('on');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setFailed(false);
    try {
      const registration = await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.getSubscription();
      if (sub) {
        // Both halves, always. Cancelling only in the browser leaves a row we
        // would keep sending to; deleting only our row leaves a phone the push
        // service still considers subscribed. The server DELETE runs first and
        // is checked before touching the browser side: if it fails, we throw
        // here and never reach unsubscribe(), so the phone stays subscribed
        // and our row stays too — a consistent state the manager can press
        // "Desligar" again to retry, rather than a half-applied one where the
        // browser thinks it's off but the server still has the row (or the
        // reverse). Same shape as register()'s res.ok check in enable().
        const res = await fetch('/api/push', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        if (!res.ok) throw new Error('unregister failed');
        await sub.unsubscribe();
      }
      setState('off');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading' || state === 'unsupported') return null;

  return (
    <section className="space-y-3 rounded-xl border border-zinc-500/20 p-4">
      <h2 className="text-sm font-semibold">{t.push.title}</h2>

      {state === 'ios-needs-install' && (
        <div className="space-y-1">
          <p className="text-sm">{t.push.iosTitle}</p>
          <p className="text-xs text-zinc-500">{t.push.iosHelp}</p>
          <Link href="/instalar" className="inline-block text-xs text-orange-600 underline">
            {t.push.iosLink}
          </Link>
        </div>
      )}

      {state === 'denied' && (
        <div className="space-y-1">
          <p className="text-sm">{t.push.deniedTitle}</p>
          <p className="text-xs text-zinc-500">{t.push.deniedHelp}</p>
        </div>
      )}

      {state === 'off' && (
        <div className="space-y-2">
          <p className="text-xs text-zinc-500">{t.push.subtitle}</p>
          <button
            onClick={enable}
            disabled={busy}
            className="w-full rounded-lg bg-orange-600 py-2 text-sm font-semibold text-white active:bg-orange-700 disabled:opacity-60"
          >
            {busy ? t.push.working : t.push.enable}
          </button>
        </div>
      )}

      {state === 'on' && (
        <div className="space-y-2">
          <p className="text-sm text-emerald-700 dark:text-emerald-400">{t.push.enabled}</p>
          <button
            onClick={disable}
            disabled={busy}
            className="w-full rounded-lg border border-zinc-500/30 py-2 text-sm font-medium active:bg-zinc-500/10 disabled:opacity-60"
          >
            {busy ? t.push.working : t.push.disable}
          </button>
        </div>
      )}

      {failed && <p className="text-xs text-red-600">{t.push.failed}</p>}
    </section>
  );
}
