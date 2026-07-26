import type { Metadata } from 'next';
import Link from 'next/link';
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
        <h1 className="text-3xl font-bold sm:text-4xl">{t.landing.headline}</h1>
        <p className="mx-auto max-w-xl text-zinc-500">{t.landing.subhead}</p>
        <div className="flex flex-col items-center gap-3 pt-2 sm:flex-row sm:justify-center">
          <Link
            href="/registar"
            className="w-full rounded-lg bg-orange-600 px-6 py-3 text-center font-semibold text-white active:bg-orange-700 sm:w-auto"
          >
            {t.landing.ctaPrimary}
          </Link>
          <Link href="/login" className="text-sm text-zinc-500 underline">
            {t.landing.ctaSecondary}
          </Link>
        </div>
      </header>

      <section className="grid gap-6 sm:grid-cols-3">
        {t.landing.steps.map((step, i) => (
          <div key={step.title} className="rounded-xl border border-zinc-500/20 p-4">
            <p className="text-xs font-semibold text-orange-600">{t.landing.stepLabel(i + 1)}</p>
            <h2 className="mt-1 font-semibold">{step.title}</h2>
            <p className="mt-1 text-sm text-zinc-500">{step.text}</p>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-orange-600/30 bg-orange-600/5 p-6 text-center">
        <h2 className="font-semibold">{t.landing.materialsTitle}</h2>
        <p className="mt-1 text-sm text-zinc-500">{t.landing.materialsText}</p>
      </section>

      <section className="rounded-xl border border-zinc-500/20 p-6 text-center">
        <p className="text-3xl font-bold">
          €45<span className="text-base font-normal text-zinc-500">{t.landing.priceSuffix}</span>
        </p>
        <p className="mt-1 text-sm text-zinc-500">{t.landing.priceNote}</p>
        <Link
          href="/registar"
          className="mt-4 inline-block w-full rounded-lg bg-orange-600 px-6 py-3 font-semibold text-white active:bg-orange-700 sm:w-auto"
        >
          {t.landing.ctaFooter}
        </Link>
      </section>

      <footer className="text-center text-xs text-zinc-500">
        <Link href="/login" className="underline">
          {t.landing.signIn}
        </Link>
      </footer>
    </div>
  );
}
