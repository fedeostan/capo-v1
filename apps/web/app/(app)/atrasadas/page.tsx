import type { Metadata } from 'next';
import { requireAuth } from '@capo/db/session';
import { loadAgendaCounts, loadTasks } from '@/app/dashboard-data';
import { OverdueList, ScreenShell } from '@capo/ui/dashboard-ui';
import AgendaTabs from '../agenda-tabs';
import TaskToggle from '../task-toggle';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Atrasadas — Capo' };

export default async function AtrasadasPage() {
  const ctx = await requireAuth();
  const [tasks, counts] = await Promise.all([loadTasks(ctx, 'overdue'), loadAgendaCounts(ctx)]);
  const subtitle =
    tasks.length > 0
      ? `${tasks.length} ${tasks.length === 1 ? 'tarefa' : 'tarefas'} com o prazo passado`
      : undefined;
  return (
    <ScreenShell title="Atrasadas" subtitle={subtitle}>
      <AgendaTabs current="atrasadas" counts={counts} />
      <OverdueList
        tasks={tasks}
        empty="Sem tarefas atrasadas."
        renderExtra={task => <TaskToggle taskId={task.id} status={task.status} />}
      />
    </ScreenShell>
  );
}
