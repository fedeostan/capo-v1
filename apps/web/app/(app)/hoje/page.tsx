import type { Metadata } from 'next';
import { loadDayLabel, loadTasks } from '@/app/dashboard-data';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { ScreenShell, TasksByObra } from '@capo/ui/dashboard-ui';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.screens.today.title) };
}

export default async function HojePage() {
  const { ctx, locale, t } = await requireAuthT();
  const [tasks, label] = await Promise.all([loadTasks(ctx, 'active_today'), loadDayLabel(ctx, 0)]);
  return (
    <ScreenShell title={t.screens.today.title} subtitle={label ?? undefined} locale={locale} settingsHref="/definicoes">
      <TasksByObra tasks={tasks} empty={t.screens.today.empty} locale={locale} />
    </ScreenShell>
  );
}
