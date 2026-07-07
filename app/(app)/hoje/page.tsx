import type { Metadata } from 'next';
import { requireAuth } from '@/src/auth/session';
import { loadDayLabel, loadTasks } from '@/app/dashboard-data';
import { ScreenShell, TasksByObra } from '@/app/dashboard-ui';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Hoje — Capo' };

export default async function HojePage() {
  const ctx = await requireAuth();
  const [tasks, label] = await Promise.all([loadTasks(ctx, 'active_today'), loadDayLabel(ctx, 0)]);
  return (
    <ScreenShell title="Hoje" subtitle={label ?? undefined}>
      <TasksByObra tasks={tasks} empty="Nada agendado para hoje." />
    </ScreenShell>
  );
}
