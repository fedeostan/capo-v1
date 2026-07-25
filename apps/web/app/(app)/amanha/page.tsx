import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAuth } from '@capo/db/session';
import { loadAgendaCounts, loadDayLabel, loadMaterials, loadTasks } from '@/app/dashboard-data';
import { ScreenShell, TasksByObra } from '@capo/ui/dashboard-ui';
import AgendaTabs from '../agenda-tabs';
import TaskToggle from '../task-toggle';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Amanhã — Capo' };

export default async function AmanhaPage() {
  const ctx = await requireAuth();
  const [tasks, label, counts, materials] = await Promise.all([
    loadTasks(ctx, 'active_tomorrow'),
    loadDayLabel(ctx, 1),
    loadAgendaCounts(ctx),
    loadMaterials(ctx, 'active_tomorrow'),
  ]);
  const itemCount = materials.reduce((n, group) => n + group.items.length, 0);

  return (
    <ScreenShell title="Amanhã" subtitle={label ?? undefined}>
      <AgendaTabs current="amanha" counts={counts} />
      {/* Looking at tomorrow is exactly the moment to notice what has to be
          bought tonight, so the anticipation list is one tap away from here
          rather than only living behind its own tab. */}
      {itemCount > 0 && (
        <Link
          href="/materiais"
          className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/50 bg-amber-500/10 p-3"
        >
          <span className="text-sm">
            <span className="font-medium">
              {itemCount} {itemCount === 1 ? 'material' : 'materiais'} para amanhã
            </span>
            <span className="block text-xs text-zinc-500">Confirma que está em obra antes de fechares o dia.</span>
          </span>
          <span aria-hidden className="shrink-0 text-zinc-500">
            →
          </span>
        </Link>
      )}
      <TasksByObra
        tasks={tasks}
        empty="Nada agendado para amanhã."
        renderExtra={task => <TaskToggle taskId={task.id} status={task.status} />}
      />
    </ScreenShell>
  );
}
