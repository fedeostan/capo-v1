'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { useFormFactor } from '@/app/platform';
import type { QrGeometry } from '@/lib/qr';
import { checkWhatsAppArrival, reportHandshakeStalled } from './actions';

const POLL_MS = 3_000;
/** Generous against a healthy path that completes in ~2s. Past this the screen
 *  asks a QUESTION about the phone number — it never declares an error, because
 *  the threshold itself can be wrong. */
const GIVE_UP_MS = 90_000;
/** Long enough for the confirmation to be read, short enough not to stall. */
const CONFIRM_BEAT_MS = 1_500;

type Status = 'waiting' | 'arrived' | 'stalled';

export default function Handshake({
  locale,
  link,
  qr,
  phone,
}: {
  locale: Locale;
  link: string;
  qr: QrGeometry;
  phone: string;
}) {
  const t = getCatalog(locale).whatsappHandshake;
  const router = useRouter();
  const formFactor = useFormFactor();
  const [optIn, setOptIn] = useState(true);
  const [status, setStatus] = useState<Status>('waiting');

  // The poll reads the tick-box, but must not RESTART when it changes: a
  // restarted interval would reset the 90-second clock every time the manager
  // toggled the box. A ref keeps the value current without being a dependency.
  const optInRef = useRef(optIn);
  useEffect(() => {
    optInRef.current = optIn;
  }, [optIn]);

  useEffect(() => {
    if (status !== 'waiting') return;
    let cancelled = false;
    const startedAt = Date.now();
    const id = setInterval(async () => {
      if (Date.now() - startedAt >= GIVE_UP_MS) {
        if (!cancelled) setStatus('stalled');
        return;
      }
      try {
        const { arrived } = await checkWhatsAppArrival(optInRef.current);
        if (arrived && !cancelled) setStatus('arrived');
      } catch {
        // A transient failure must not end the wait. The next tick retries; the
        // 90-second ceiling is what bounds this, not an error count.
      }
    }, POLL_MS);
    // Stops on arrival, on give-up, and on unmount — a screen left open in a
    // background tab must not poll forever.
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [status]);

  useEffect(() => {
    if (status !== 'arrived') return;
    // replace, not push: the back button must not return them to a screen whose
    // job is done and which would start polling again.
    const id = setTimeout(() => router.replace('/instalar'), CONFIRM_BEAT_MS);
    return () => clearTimeout(id);
  }, [status, router]);

  useEffect(() => {
    if (status !== 'stalled') return;
    // Fire-and-forget: this is telemetry, not a step the manager is waiting
    // on, so it must never be able to break or delay the stalled screen.
    // Everything else on this page logs server-side; without this, the
    // 90-second give-up — the one outcome this feature most needs visibility
    // into — left no trace at all.
    reportHandshakeStalled().catch(() => {});
  }, [status]);

  // 'detecting' — the server pass and the moment before hydration — renders the
  // LINK alone. The link works on every device; the QR only works when there is
  // a second screen to scan it with. So the not-yet-known state is the safe one,
  // and a QR never flashes onto a phone that has no use for it.
  const desktop = formFactor === 'desktop';

  return (
    <div className="space-y-6">
      <label className="flex items-start gap-3 rounded-lg border border-zinc-500/30 px-3 py-2.5">
        <input
          type="checkbox"
          checked={optIn}
          onChange={e => setOptIn(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 accent-orange-600"
        />
        <span className="text-sm">
          {t.consentLabel}
          <span className="mt-0.5 block text-xs text-zinc-500">{t.consentHint}</span>
        </span>
      </label>

      {desktop && (
        <div className="space-y-2">
          {/* White card and black modules in BOTH themes, deliberately. An
              inverted QR is legal but many scanners will not lock onto one, and
              a code that fails to scan looks identical to a code that works. */}
          <div className="mx-auto w-48 rounded-lg bg-white p-3">
            <svg viewBox={qr.viewBox} className="block h-full w-full" role="img" aria-label={t.qrHint}>
              <path d={qr.path} fill="#000000" />
            </svg>
          </div>
          <p className="text-center text-xs text-zinc-500">{t.qrHint}</p>
        </div>
      )}

      {/* Desktop: a secondary link beside the QR the manager is meant to keep
          looking at, so a new tab is correct — they stay on this screen.
          Mobile: navigating in the SAME tab is deliberate. A new tab puts the
          wa.me interstitial and WhatsApp hand-off in front, and this tab
          behind it — so when the manager returns to the browser, the front
          tab is wa.me, not /whatsapp, and iOS suspends timers in a
          backgrounded tab, so the poll may never even run. Same-tab means
          Back returns here, which remounts and re-confirms immediately
          because arrival is sticky by design (see actions.ts). */}
      <a
        href={link}
        {...(desktop ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        className={
          desktop
            ? 'block text-center text-sm text-zinc-500 underline'
            : 'block w-full rounded-lg bg-emerald-600 py-2.5 text-center font-semibold text-white active:bg-emerald-700'
        }
      >
        {desktop ? t.webLink : t.openButton}
      </a>

      {status === 'arrived' ? (
        <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-center text-sm text-emerald-700 dark:text-emerald-400">
          {t.arrived}
        </p>
      ) : status === 'stalled' ? (
        <div className="space-y-2">
          <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-center text-sm text-amber-700 dark:text-amber-400">
            {t.stalled(phone)}
          </p>
          <Link href="/perfil" className="block text-center text-sm underline">
            {t.fixNumber}
          </Link>
        </div>
      ) : (
        <p className="text-center text-sm text-zinc-500">{t.waiting}</p>
      )}

      <Link href="/instalar" className="block text-center text-sm text-zinc-500 underline">
        {t.skip}
      </Link>
    </div>
  );
}
