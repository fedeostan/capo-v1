'use client';

import { useEffect, useState } from 'react';
import { Button } from '@capo/ui/button';
import { getCatalog, type Catalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import Link from 'next/link';
import { ButtonLink } from '@/app/_ui/nav';
import { useDetectedPlatform } from '@/app/platform';

// Chrome/Edge fire beforeinstallprompt; capturing it lets us show a real
// install button. iOS Safari has NO programmatic install path — the manual
// Partilhar → Adicionar ao ecrã principal walkthrough IS the product there,
// and managers are mostly on iPhones, so it is the primary path, not the
// fallback.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// The steps are split into before/action/after fragments rather than one string
// because the emphasis and the Safari share icon sit INSIDE the sentence, and
// word order differs per language.
function IosSteps({ t }: { t: Catalog }) {
  return (
    <ol className="space-y-4">
      <Step n={1}>
        {t.install.iosStep1Before} <strong>{t.install.iosStep1Share}</strong>{' '}
        <svg viewBox="0 0 24 24" className="inline h-5 w-5 align-text-bottom" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
        </svg>{' '}
        {t.install.iosStep1After}
      </Step>
      <Step n={2}>
        {t.install.iosStep2Before} <strong>{t.install.iosStep2Action}</strong>.
      </Step>
      <Step n={3}>
        {t.install.iosStep3Before} <strong>{t.install.iosStep3Action}</strong>. {t.install.iosStep3After}
      </Step>
    </ol>
  );
}

function GenericSteps({ t }: { t: Catalog }) {
  return (
    <ol className="space-y-4">
      <Step n={1}>
        {t.install.genericStep1Before} (<strong>⋮</strong>).
      </Step>
      <Step n={2}>
        {t.install.genericStep2Before} <strong>{t.install.genericStep2Action}</strong>{' '}
        {t.install.genericStep2After}
      </Step>
    </ol>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-callout">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-caption font-bold text-on-brand">
        {n}
      </span>
      {/* leading-6 lines the first text line up with the 24px circle. */}
      <span className="leading-6">{children}</span>
    </li>
  );
}

export default function InstallGuide({ locale }: { locale: Locale }) {
  const t = getCatalog(locale);
  const platform = useDetectedPlatform();
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
        <p className="rounded-lg bg-success-quiet px-3 py-2 text-callout text-success">
          {t.install.alreadyInstalled}
        </p>
        <ButtonLink href="/" variant="primary" fullWidth>
          {t.install.open}
        </ButtonLink>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {deferredPrompt ? (
        <Button onClick={install} fullWidth>
          {t.install.installButton}
        </Button>
      ) : platform === 'ios' ? (
        <IosSteps t={t} />
      ) : platform === 'other' ? (
        <GenericSteps t={t} />
      ) : null}

      <Link href="/" className="block text-center text-callout text-fg-muted underline">
        {t.install.skip}
      </Link>
    </div>
  );
}
