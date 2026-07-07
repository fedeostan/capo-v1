import type { Metadata } from 'next';
import { requireAuth } from '@/src/auth/session';
import { loadTasks } from '@/app/dashboard-data';
import { OverdueList, ScreenShell } from '@/app/dashboard-ui';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Atrasadas — Capo' };

export default async function AtrasadasPage() {
  const ctx = await requireAuth();
  const tasks = await loadTasks(ctx, 'overdue');
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
