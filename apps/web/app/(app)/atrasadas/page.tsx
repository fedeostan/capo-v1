import type { Metadata } from 'next';
import { loadTasks } from '@/app/dashboard-data';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { OverdueList, ScreenShell } from '@capo/ui/dashboard-ui';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.screens.overdue.title) };
}

export default async function AtrasadasPage() {
  const { ctx, locale, t } = await requireAuthT();
  const tasks = await loadTasks(ctx, 'overdue');
  const subtitle = tasks.length > 0 ? t.screens.overdue.subtitle(tasks.length) : undefined;
  return (
    <ScreenShell title={t.screens.overdue.title} subtitle={subtitle} locale={locale} settingsHref="/definicoes">
      <OverdueList tasks={tasks} empty={t.screens.overdue.empty} locale={locale} />
    </ScreenShell>
  );
}
