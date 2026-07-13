import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireAuth } from '@capo/db/session';
import { loadObraDetail } from '@/app/dashboard-data';
import { ScreenShell, TimelineList } from '@capo/ui/dashboard-ui';
import TaskActions from './task-actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const ctx = await requireAuth();
  const detail = await loadObraDetail(ctx, id);
  return { title: detail ? `${detail.job.name} — Capo` : 'Obra — Capo' };
}

export default async function ObraDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth();
  const detail = await loadObraDetail(ctx, id);
  if (!detail) notFound();

  const done = detail.tasks.filter(t => t.status === 'done').length;
  const total = detail.tasks.length;

  return (
    <ScreenShell
      title={detail.job.name}
      subtitle={[detail.job.address, detail.job.client_name].filter(Boolean).join(' · ') || undefined}
    >
      <p className="text-xs text-zinc-500">
        {total > 0 ? `${done} de ${total} tarefas concluídas` : 'Sem tarefas registadas'}
      </p>
      <TimelineList
        tasks={detail.tasks}
        empty="Sem tarefas nesta obra ainda — pede ao Capo para criar o plano."
        renderExtra={task => <TaskActions taskId={task.id} status={task.status} />}
      />
    </ScreenShell>
  );
}
