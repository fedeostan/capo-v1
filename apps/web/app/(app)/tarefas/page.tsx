import type { Metadata } from 'next';
import { requireAuth } from '@capo/db/session';
import { ScreenShell, TaskBoardList } from '@capo/ui/dashboard-ui';
import { loadBoardTasks, loadDayLabel, loadObraOptions, type GroupBy } from '@/app/dashboard-data';
import TaskActions from '@/app/(app)/_tasks/task-actions';
import FilterChips from './filter-chips';
import FilterControls from './filter-controls';
import { parseFilters, type RawSearchParams, type TarefasFilters } from './filters';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Tarefas — Capo' };

// TODO(Federico): microcopy dial — the "nothing here" line per filter.
const EMPTY: Record<string, string> = {
  hoje: 'Nada agendado para hoje.',
  amanha: 'Nada agendado para amanhã.',
  atrasadas: 'Nenhuma tarefa fora do prazo. Bom sinal.',
  risco: 'Nada em risco de momento.',
  todas: 'Sem tarefas abertas.',
};

function emptyText(filters: TarefasFilters): string {
  if (filters.quando.kind === 'date') return 'Nada agendado para esse dia.';
  const base = EMPTY[filters.quando.value] ?? 'Sem tarefas.';
  return filters.obraId ? `${base.replace(/\.$/, '')} nesta obra.` : base;
}

export default async function TarefasPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const filters = parseFilters(await searchParams);
  const ctx = await requireAuth();

  // Grouping by obra inside a single obra would be one meaningless heading,
  // so a selected obra switches the list to day headings instead.
  const groupBy: GroupBy = filters.obraId ? 'date' : 'obra';

  // Hoje/Amanhã take their header date from the same lisbon_today() RPC that
  // drives the buckets, so the header can never contradict the list under it.
  const dayOffset: 0 | 1 | null =
    filters.quando.kind !== 'keyword' ? null : filters.quando.value === 'hoje' ? 0 : filters.quando.value === 'amanha' ? 1 : null;

  const [tasks, obras, dayLabel] = await Promise.all([
    loadBoardTasks(ctx, filters, groupBy),
    loadObraOptions(ctx),
    dayOffset === null ? Promise.resolve(null) : loadDayLabel(ctx, dayOffset),
  ]);

  const subtitle =
    dayLabel ??
    (filters.quando.kind === 'date'
      ? new Intl.DateTimeFormat('pt-PT', {
          timeZone: 'UTC',
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        }).format(new Date(`${filters.quando.iso}T00:00:00Z`))
      : `${tasks.length} ${tasks.length === 1 ? 'tarefa' : 'tarefas'}`);

  return (
    <ScreenShell title="Tarefas" subtitle={subtitle}>
      <div className="space-y-2">
        <FilterChips filters={filters} />
        <FilterControls filters={filters} obras={obras} />
      </div>
      <TaskBoardList
        tasks={tasks}
        groupBy={groupBy}
        empty={emptyText(filters)}
        renderExtra={task => <TaskActions taskId={task.id} status={task.status} />}
      />
    </ScreenShell>
  );
}
