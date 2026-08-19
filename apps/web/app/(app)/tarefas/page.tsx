import type { Metadata } from 'next';
import Link from 'next/link';
import type { Catalog } from '@capo/i18n/catalog';
import { ScreenShell, TaskBoardList } from '@capo/ui/dashboard-ui';
import {
  loadBoardTasks,
  loadDayLabel,
  loadMaterials,
  loadObraOptions,
  loadPendingReviews,
  loadToday,
  type GroupBy,
} from '@/app/dashboard-data';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import TaskActions from '@/app/(app)/_tasks/task-actions';
import ReviewActions from '@/app/(app)/_tasks/review-actions';
import PullToRefresh from '@/app/pull-to-refresh';
import { LanguageDriftStrip } from '@/app/(app)/language-drift';
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

  // Three groupings, and which one applies is decided here rather than in the
  // component so the page can load exactly what that grouping needs.
  //
  // - Todas is the whole open board and the default view (issue #96), so it
  //   groups as an AGENDA: Atrasadas, Hoje, Amanhã, each later day, no date.
  //   A flat list of everything grouped by obra was the "confusing" part —
  //   the manager could not see what was actually on today.
  // - Grouping by obra inside a single obra would be one meaningless heading,
  //   so a selected obra switches the list to day headings instead.
  // - Every other chip is already narrowed to a moment, so obra headings are
  //   the useful split there.
  const isTodas = filters.quando.kind === 'keyword' && filters.quando.value === 'todas';
  const groupBy: GroupBy = isTodas && !filters.obraId ? 'agenda' : filters.obraId ? 'date' : 'obra';

  // Hoje/Amanhã take their header date from the same lisbon_today() RPC that
  // drives the buckets, so the header can never contradict the list under it.
  const dayOffset: 0 | 1 | null =
    filters.quando.kind !== 'keyword' ? null : filters.quando.value === 'hoje' ? 0 : filters.quando.value === 'amanha' ? 1 : null;

  const [tasks, obras, dayLabel, tomorrowMaterials, today] = await Promise.all([
    loadBoardTasks(ctx, filters, groupBy),
    loadObraOptions(ctx),
    dayOffset === null ? Promise.resolve(null) : loadDayLabel(ctx, dayOffset),
    // Only on the Amanhã chip: looking at tomorrow is exactly the moment the
    // manager can still act on what has to be bought tonight. Anywhere else it
    // would be a nag.
    dayOffset === 1 ? loadMaterials(ctx, 'amanha', null) : Promise.resolve([]),
    // The agenda headings say "Hoje" and "Amanhã", so they need the same
    // Europe/Lisbon date the board's own buckets are computed from. Only the
    // agenda grouping asks for it; every other view skips the round trip.
    groupBy === 'agenda' ? loadToday(ctx) : Promise.resolve(null),
  ]);
  const materialCount = tomorrowMaterials.reduce((n, group) => n + group.items.length, 0);

  // Sequential on purpose: this is keyed by the ids the board actually
  // returned, so it cannot be hoisted into the Promise.all above. One extra
  // round trip, scoped to the visible page, and it short-circuits to an empty
  // Map when the board is empty.
  const reviews = await loadPendingReviews(ctx, tasks.map(task => task.id));

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
      <PullToRefresh locale={locale}>
        <div className="space-y-2">
          <FilterChips filters={filters} locale={locale} />
          <FilterControls filters={filters} obras={obras} locale={locale} />
        </div>
        {/* The board is where a task title is READ, so it is where a title in
            a language the manager does not read is noticed — and, before this,
            where he had no way to find out why. Renders nothing when the two
            dials agree, which is every tenant that never split them. */}
        <LanguageDriftStrip locale={ctx.locale} companyLocale={ctx.companyLocale} />
        {materialCount > 0 && (
          <Link
            href="/materiais"
            className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/50 bg-amber-500/10 p-3"
          >
            <span className="text-sm">
              <span className="font-medium">{t.screens.materials.pending(materialCount)}</span>
              <span className="block text-xs text-zinc-500">{t.screens.materials.pendingHint}</span>
            </span>
            <span aria-hidden className="shrink-0 text-zinc-500">
              →
            </span>
          </Link>
        )}
        <TaskBoardList
          tasks={tasks}
          groupBy={groupBy}
          locale={locale}
          today={today}
          empty={emptyText(filters, t)}
          renderExtra={task => <TaskActions taskId={task.id} status={task.status} locale={locale} />}
          renderBelow={task => {
            const review = reviews.get(task.id);
            return review ? (
              <ReviewActions
                reviewId={review.id}
                note={review.note}
                declaredByWorker={review.declaredByWorker}
                declaredByName={review.declaredByName}
                photoCount={review.photoCount}
                locale={locale}
              />
            ) : null;
          }}
        />
      </PullToRefresh>
    </ScreenShell>
  );
}
