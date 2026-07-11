import type { Metadata } from 'next';
import { requireAuth } from '@capo/db/session';
import { loadDayLabel, loadTasks } from '@/app/dashboard-data';
import { ScreenShell, TasksByObra } from '@capo/ui/dashboard-ui';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Amanhã — Capo' };

export default async function AmanhaPage() {
  const ctx = await requireAuth();
  const [tasks, label] = await Promise.all([loadTasks(ctx, 'active_tomorrow'), loadDayLabel(ctx, 1)]);
  return (
    <ScreenShell title="Amanhã" subtitle={label ?? undefined}>
      <TasksByObra tasks={tasks} empty="Nada agendado para amanhã." />
    </ScreenShell>
  );
}
