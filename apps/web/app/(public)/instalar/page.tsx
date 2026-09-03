import type { Metadata } from 'next';
import { metadataTitle, publicCatalog } from '@/lib/i18n';
import InstallGuide from './install-guide';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.install.title) };
}

// Final onboarding step: get Capo onto the home screen. Session-gated by the
// proxy; the guide adapts per platform client-side.
export default async function InstalarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, t } = await publicCatalog();
  // Straight off signup (`?novo=1`) the manager still has an empty company, so
  // "open Capo" means the conversation that sets it up. Reached from Profile
  // instead, it means Home, which is what it has always meant.
  const openHref = (await searchParams).novo !== undefined ? '/chat?compose=1' : '/';
  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">📲</p>
        <h1 className="text-title font-semibold">{t.install.title}</h1>
        <p className="text-callout text-fg-muted">{t.install.subtitle}</p>
      </div>
      <InstallGuide locale={locale} openHref={openHref} />
    </div>
  );
}
