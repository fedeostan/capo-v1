'use client';

import Link from 'next/link';
import { useEffect, useState, useSyncExternalStore } from 'react';

// Chrome/Edge fire beforeinstallprompt; capturing it lets us show a real
// install button. iOS Safari has NO programmatic install path — the manual
// Partilhar → Adicionar ao ecrã principal walkthrough IS the product there,
// and managers are mostly on iPhones, so it is the primary path, not the
// fallback.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type Platform = 'detecting' | 'standalone' | 'ios' | 'other';

// Browser facts, read via useSyncExternalStore: 'detecting' on the server
// pass, the real platform after hydration. None of this changes while the
// page is open, so the subscription is a no-op.
function detectPlatform(): Platform {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true);
  if (standalone) return 'standalone';
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return 'ios';
  return 'other';
}

// TODO(Federico): EU-PT microcopy dial — the install steps wording.
function IosSteps() {
  return (
    <ol className="space-y-4">
      <Step n={1}>
        Toca em <strong>Partilhar</strong>{' '}
        <svg viewBox="0 0 24 24" className="inline h-5 w-5 align-text-bottom" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
        </svg>{' '}
        na barra do Safari.
      </Step>
      <Step n={2}>
        Escolhe <strong>Adicionar ao ecrã principal</strong>.
      </Step>
      <Step n={3}>
        Toca em <strong>Adicionar</strong>. O Capo fica no teu ecrã como uma app.
      </Step>
    </ol>
  );
}

function GenericSteps() {
  return (
    <ol className="space-y-4">
      <Step n={1}>
        Abre o menu do navegador (<strong>⋮</strong>).
      </Step>
      <Step n={2}>
        Escolhe <strong>Instalar aplicação</strong> (ou “Adicionar ao ecrã principal”).
      </Step>
    </ol>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-sm">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-orange-600 text-xs font-bold text-white">
        {n}
      </span>
      <span className="pt-0.5">{children}</span>
    </li>
  );
}

export default function InstallGuide() {
  const platform = useSyncExternalStore(
    () => () => {},
    detectPlatform,
    () => 'detecting' as Platform,
  );
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') setInstalled(true);
    setDeferredPrompt(null);
  };

  if (platform === 'standalone' || installed) {
    return (
      <div className="space-y-4 text-center">
        <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          O Capo já está instalado neste aparelho. 💪
        </p>
        <Link
          href="/"
          className="block w-full rounded-lg bg-orange-600 py-2.5 text-center font-semibold text-white active:bg-orange-700"
        >
          Abrir o Capo
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {deferredPrompt ? (
        <button
          onClick={install}
          className="w-full rounded-lg bg-orange-600 py-2.5 font-semibold text-white active:bg-orange-700"
        >
          Instalar aplicação
        </button>
      ) : platform === 'ios' ? (
        <IosSteps />
      ) : platform === 'other' ? (
        <GenericSteps />
      ) : null}

      <Link href="/" className="block text-center text-sm text-zinc-500 underline">
        Continuar sem instalar
      </Link>
    </div>
  );
}
