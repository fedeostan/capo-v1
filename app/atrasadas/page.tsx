import type { Metadata } from 'next';
import { loadTasks } from '../dashboard-data';
import { OverdueList, ScreenShell } from '../dashboard-ui';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Atrasadas — Capo' };

export default async function AtrasadasPage() {
  const tasks = await loadTasks('overdue');
  const subtitle =
    tasks.length > 0
      ? `${tasks.length} ${tasks.length === 1 ? 'tarefa' : 'tarefas'} com o prazo passado`
      : undefined;
  return (
    <ScreenShell title="Atrasadas" subtitle={subtitle}>
      <OverdueList tasks={tasks} empty="Sem tarefas atrasadas." />
    </ScreenShell>
  );
}
