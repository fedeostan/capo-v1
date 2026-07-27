import type { Metadata } from 'next';
import { loadObras, loadOverdueByObra } from '@/app/dashboard-data';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { ObrasList, ScreenShell } from '@capo/ui/dashboard-ui';
import PullToRefresh from '@/app/pull-to-refresh';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.screens.jobs.title) };
}

export default async function ObrasPage() {
  const { ctx, locale, t } = await requireAuthT();
  const [obras, overdueByObra] = await Promise.all([loadObras(ctx), loadOverdueByObra(ctx)]);
  return (
    <ScreenShell
      title={t.screens.jobs.title}
      subtitle={t.screens.jobs.subtitle}
    >
      <PullToRefresh locale={locale}>
        <ObrasList obras={obras} empty={t.screens.jobs.empty} locale={locale} overdueByObra={overdueByObra} />
      </PullToRefresh>
    </ScreenShell>
  );
}
