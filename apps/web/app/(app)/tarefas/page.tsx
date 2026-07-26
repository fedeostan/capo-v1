import type { Metadata } from 'next';
import type { Catalog } from '@capo/i18n/catalog';
import { ScreenShell, TaskBoardList } from '@capo/ui/dashboard-ui';
import { loadBoardTasks, loadDayLabel, loadObraOptions, type GroupBy } from '@/app/dashboard-data';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import TaskActions from '@/app/(app)/_tasks/task-actions';
import FilterChips from './filter-chips';
import FilterControls from './filter-controls';
import { parseFilters, type RawSearchParams, type TarefasFilters } from './filters';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.screens.tasks.title) };
}

// The "nothing here" line depends on which filter is active — a generic empty
// state would leave the manager unsure whether the filter or the data is empty.
function emptyText(filters: TarefasFilters, t: Catalog): string {
  const tasks = t.screens.tasks;
  if (filters.quando.kind === 'date') return tasks.emptyForDate;
  const base = tasks.empty[filters.quando.value] ?? tasks.emptyFallback;
  return filters.obraId ? tasks.emptyInJob(base) : base;
}

export default async function TarefasPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const filters = parseFilters(await searchParams);
  const { ctx, locale, t } = await requireAuthT();

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
      ? new Intl.DateTimeFormat(t.meta.dateLocale, {
          timeZone: 'UTC',
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        }).format(new Date(`${filters.quando.iso}T00:00:00Z`))
      : t.screens.tasks.count(tasks.length));

  return (
    <ScreenShell title={t.screens.tasks.title} subtitle={subtitle}>
      <div className="space-y-2">
        <FilterChips filters={filters} locale={locale} />
        <FilterControls filters={filters} obras={obras} locale={locale} />
      </div>
      <TaskBoardList
        tasks={tasks}
        groupBy={groupBy}
        locale={locale}
        empty={emptyText(filters, t)}
        renderExtra={task => <TaskActions taskId={task.id} status={task.status} locale={locale} />}
      />
    </ScreenShell>
  );
}
