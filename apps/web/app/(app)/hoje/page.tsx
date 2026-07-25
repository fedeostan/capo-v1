import type { Metadata } from 'next';
import { requireAuth } from '@capo/db/session';
import { loadAgendaCounts, loadDayLabel, loadTasks } from '@/app/dashboard-data';
import { ScreenShell, TasksByObra } from '@capo/ui/dashboard-ui';
import AgendaTabs from '../agenda-tabs';
import TaskToggle from '../task-toggle';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Hoje — Capo' };

export default async function HojePage() {
  const ctx = await requireAuth();
  const [tasks, label, counts] = await Promise.all([
    loadTasks(ctx, 'active_today'),
    loadDayLabel(ctx, 0),
    loadAgendaCounts(ctx),
  ]);
  return (
    <ScreenShell title="Hoje" subtitle={label ?? undefined}>
      <AgendaTabs current="hoje" counts={counts} />
      <TasksByObra
        tasks={tasks}
        empty="Nada agendado para hoje."
        renderExtra={task => <TaskToggle taskId={task.id} status={task.status} />}
      />
    </ScreenShell>
  );
}
