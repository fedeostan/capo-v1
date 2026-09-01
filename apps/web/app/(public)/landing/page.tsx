import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@capo/ui/card';
import { ButtonLink } from '@/app/_ui/nav';
import { publicCatalog } from '@/lib/i18n';

// Anti-app positioning: an assistant that runs the manager's WhatsApp and
// automates the paperwork — never "construction management software". Server
// component only, no client JS, no animation libraries — one tasteful page.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await publicCatalog();
  return {
    title: t.landing.metaTitle,
    description: t.landing.metaDescription,
    openGraph: {
      title: t.landing.metaTitle,
      description: t.landing.ogDescription,
      type: 'website',
    },
  };
}

export default async function LandingPage() {
  const { t } = await publicCatalog();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-16 px-6 py-16">
      <header className="space-y-4 text-center">
        <p className="text-5xl">👷</p>
        <h1 className="text-display font-bold">{t.landing.headline}</h1>
        <p className="mx-auto max-w-xl text-fg-muted">{t.landing.subhead}</p>
        <div className="flex flex-col items-center gap-3 pt-2 sm:flex-row sm:justify-center">
          {/* The wrapper carries the responsive width — ButtonLink takes no
              className, so full-on-mobile / shrink-on-desktop lives here. */}
          <div className="w-full sm:w-auto">
            <ButtonLink href="/registar" variant="primary" fullWidth>
              {t.landing.ctaPrimary}
            </ButtonLink>
          </div>
          <Link href="/login" className="text-callout text-fg-muted underline">
            {t.landing.ctaSecondary}
          </Link>
        </div>
      </header>

      <section className="grid gap-6 sm:grid-cols-3">
        {t.landing.steps.map((step, i) => (
          <Card key={step.title}>
            <p className="text-caption font-semibold text-brand">{t.landing.stepLabel(i + 1)}</p>
            <h2 className="mt-1 font-semibold">{step.title}</h2>
            <p className="mt-1 text-callout text-fg-muted">{step.text}</p>
          </Card>
        ))}
      </section>

      <section className="rounded-card border border-hairline bg-brand-quiet p-6 text-center">
        <h2 className="font-semibold">{t.landing.materialsTitle}</h2>
        <p className="mt-1 text-callout text-fg-muted">{t.landing.materialsText}</p>
      </section>

      <section className="rounded-card border border-hairline bg-surface p-6 text-center">
        <p className="text-display font-bold">
          €45<span className="text-body font-normal text-fg-muted">{t.landing.priceSuffix}</span>
        </p>
        <p className="mt-1 text-callout text-fg-muted">{t.landing.priceNote}</p>
        {/* inline-block + w-full/sm:w-auto so the second CTA is full-width on a
            phone and shrinks to its label on desktop, like the first. Two
            primaries on one page is deliberate here: same action, repeated at
            the end of the pitch — not two competing actions. */}
        <div className="mt-4 inline-block w-full sm:w-auto">
          <ButtonLink href="/registar" variant="primary" fullWidth>
            {t.landing.ctaFooter}
          </ButtonLink>
        </div>
      </section>

      <footer className="text-center text-caption text-fg-muted">
        <Link href="/login" className="underline">
          {t.landing.signIn}
        </Link>
      </footer>
    </div>
  );
}
