'use client';

import { useState } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

// Sign-out has to take this device's push registration with it.
//
// Crews share handsets. Without this, a manager who signs out leaves a live
// registration behind, and the next person to sign in on that phone gets the
// first manager's alerts on their lock screen — alerts about work they may
// have no business seeing.
//
// It has to happen HERE and not in the route: the server never learns the
// endpoint, only the browser knows it.
export default function SignOutButton({ locale }: { locale: Locale }) {
  const t = getCatalog(locale);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    event.preventDefault();
    setBusy(true);
    try {
      if ('serviceWorker' in navigator && 'PushManager' in window) {
        const registration = await navigator.serviceWorker.ready;
        const sub = await registration.pushManager.getSubscription();
        if (sub) {
          await fetch('/api/push', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
          await sub.unsubscribe();
        }
      }
    } catch {
      // Never block sign-out on this. A stranded registration is a real but
      // smaller problem than a manager who cannot log out of a shared phone.
    } finally {
      form.submit();
    }
  }

  return (
    <form method="post" action="/auth/signout" onSubmit={submit}>
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-xl border border-zinc-500/20 py-2.5 text-sm font-medium text-red-600 hover:bg-red-600/5 disabled:opacity-60"
      >
        {t.common.signOut}
      </button>
    </form>
  );
}
