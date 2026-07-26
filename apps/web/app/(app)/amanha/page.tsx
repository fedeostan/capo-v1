import type { Metadata } from 'next';
import { loadDayLabel, loadTasks } from '@/app/dashboard-data';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { ScreenShell, TasksByObra } from '@capo/ui/dashboard-ui';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.screens.tomorrow.title) };
}

export default async function AmanhaPage() {
  const { ctx, locale, t } = await requireAuthT();
  const [tasks, label] = await Promise.all([loadTasks(ctx, 'active_tomorrow'), loadDayLabel(ctx, 1)]);
  return (
    <ScreenShell
      title={t.screens.tomorrow.title}
      subtitle={label ?? undefined}
      locale={locale}
      settingsHref="/definicoes"
    >
      <TasksByObra tasks={tasks} empty={t.screens.tomorrow.empty} locale={locale} />
    </ScreenShell>
  );
}
