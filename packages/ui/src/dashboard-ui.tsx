// Presentational components for the dashboard. No buttons, no forms, no
// mutations in this file — the few interactive controls the manager has
// (Concluir/Reabrir, Sair) are injected by apps/web through render props or
// live on their own page, so this package never imports a server action.
//
// Every exported component takes `locale` and resolves its own catalog. It does
// NOT take a catalog as a prop: the catalog holds interpolation FUNCTIONS
// (progress, overdueBy, …), and functions cannot be serialized across the RSC
// server→client boundary. Passing a plain string keeps one rule for both sides.
import type { Tables } from '@capo/db/types';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

// Row shape for the obras view — defined here (the shared UI package) so web
// and operator render from the same contract; data loaders import this type
// rather than redeclaring it.
export type DashboardObra = Tables<'dashboard_obras'>;

// The microcopy dial that used to live here (status labels, overdue phrasing,
// risk reasons) moved to @capo/i18n — one place, three languages, checked by tsc.

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-zinc-500/10 text-zinc-500',
  in_progress: 'bg-orange-600/10 text-orange-600',
  // Violet, deliberately not amber or red: a completion claim awaiting the
  // manager is a decision to make, not a problem to fix. blocked (red) and the
  // overdue reason line (also red) own "something is wrong".
  pending_review: 'bg-violet-600/10 text-violet-600',
  blocked: 'bg-red-600/10 text-red-600',
  done: 'bg-emerald-700/10 text-emerald-700',
  // zinc-500 rather than 400: 400 is 2.3:1 on white and this file now renders
  // on a light background by default in both apps.
  cancelled: 'bg-zinc-500/10 text-zinc-500 line-through',
};

// Exported so the task detail screen renders the same badge as the lists —
// two renderings of "what state is this task in" would eventually disagree.
export function StatusBadge({
  status,
  locale,
  showPending = false,
}: {
  status: string | null;
  locale: Locale;
  /** Opt back in to the 'pending' badge. See below for why it is off by default. */
  showPending?: boolean;
}) {
  if (!status) return null;
  // 'pending' is the status of almost every open task, so a badge saying it on
  // every row is noise occupying the one slot where real state belongs (which
  // is what the confirmation/proof signals will use). The detail screen opts
  // back in: there is room there, and the complete picture is the point.
  if (status === 'pending' && !showPending) return null;
  const labels = getCatalog(locale).dashboard.taskStatus;
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[status] ?? STATUS_STYLES.pending}`}
    >
      {labels[status as keyof typeof labels] ?? status}
    </span>
  );
}

export function ScreenShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    // No <main> here any more: the scroller moved to apps/web's PullToRefresh,
    // because scrolling became a BEHAVIOUR (non-passive touch listeners,
    // useTransition) and this package is presentational and 'use client'-free
    // by contract. Callers pass their content wrapped in it. One that forgets
    // still type-checks — overflow-hidden is what turns that mistake into
    // visibly clipped content rather than a tab bar sliding off screen.
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col overflow-hidden">
      {/* Sign-out used to live here, in a file whose own contract forbids
          forms. It now lives on /perfil, the tab that owns everything about
          the company and the account. */}
      <header className="shrink-0 border-b border-zinc-500/20 px-4 py-3">
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
      </header>
      {children}
    </div>
  );
}

/**
 * One task a material is attached to — or could be attached to.
 *
 * It carries the task's WHOLE current material list because `tasks.materials`
 * is a single `text[]` column: an editor can only write it by replacing it, so
 * it has to start from what is already there. Ids, not just titles: "add a
 * material here" has to resolve to a specific task row (issue #60).
 */
export interface MaterialsTask {
  id: string;
  title: string;
  materials: string[];
}

export interface MaterialsGroup {
  obraId: string | null;
  obraName: string;
  items: { material: string; forTasks: MaterialsTask[] }[];
  /** Every task of this obra inside the horizon, including the ones carrying
   *  no materials at all — those are exactly the tasks a manager wants to add
   *  a material TO, so they cannot be filtered out the way `items` is. */
  tasks: MaterialsTask[];
}

/**
 * Above this many obra groups the list opens collapsed.
 *
 * Federico's complaint verbatim: four materials on one site is fine, seven
 * sites means "you need to scroll like crazy". Three groups fit on a phone
 * screen and collapsing them would cost a tap for nothing; past three the
 * headers become the index of the page, which is the thing worth seeing first.
 */
const COLLAPSE_ABOVE = 3;

// Materiais — the anticipation screen. 00_VISION/02-solution-mvp.md calls this
// the killer feature: "check tomorrow's materials today" is what stops the
// manager being the one who drives to the supplier at 08:00. `tasks.materials`
// has existed since migration 0010 and nothing ever read it.
//
// Collapsing is native <details>/<summary>, not client state, for the same
// reason the /perfil advanced block is: it works before hydration, which on a
// cold PWA over a building-site connection is most of the time the manager
// actually spends looking at it. React only rewrites the `open` attribute when
// the computed value CHANGES, so a group the manager collapsed by hand stays
// collapsed across a server-action revalidation.
export function MaterialsList({
  groups,
  empty,
  noJobLabel,
  forLabel,
  countLabel,
  emptyGroupLabel,
  seeJobLabel,
  renderGroupAction,
  renderItem,
}: {
  groups: MaterialsGroup[];
  empty: string;
  noJobLabel: string;
  /** e.g. "for: Tiling, Grouting" — says WHY each item is on the list. */
  forLabel: (tasks: string[]) => string;
  /** e.g. "4 materiais" — what a collapsed group tells you without opening. */
  countLabel?: (n: number) => string;
  /** Shown inside a group whose obra has work but nothing recorded yet. */
  emptyGroupLabel?: string;
  seeJobLabel?: string;
  /** The "add material" control. Injected, never built here: this package is
   *  presentational by contract and owns no mutation (see the file header). */
  renderGroupAction?: (group: MaterialsGroup) => React.ReactNode;
  /** Replaces the plain material name with something tappable. */
  renderItem?: (item: MaterialsGroup['items'][number], group: MaterialsGroup) => React.ReactNode;
}) {
  if (groups.length === 0) return <EmptyState text={empty} />;
  const openByDefault = groups.length <= COLLAPSE_ABOVE;
  return (
    <>
      {groups.map(group => (
        <details
          key={group.obraName || noJobLabel}
          open={openByDefault}
          className="group rounded-xl border border-zinc-500/20"
        >
          {/* No link in the summary: an <a> inside it would both navigate and
              toggle on the same tap. "Ver obra" lives in the panel instead. */}
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-3 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {group.obraName || noJobLabel}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-[11px] text-zinc-500">
              {countLabel && <span>{countLabel(group.items.length)}</span>}
              <span aria-hidden className="transition-transform group-open:rotate-180">
                ▾
              </span>
            </span>
          </summary>
          <div className="border-t border-zinc-500/20">
            {group.items.length === 0 ? (
              emptyGroupLabel && <p className="p-3 text-sm text-zinc-500">{emptyGroupLabel}</p>
            ) : (
              <ul className="divide-y divide-zinc-500/15">
                {group.items.map(item => (
                  <li key={item.material} className="flex items-start gap-3 p-3">
                    <span aria-hidden className="mt-0.5 text-zinc-500">
                      ▢
                    </span>
                    <div className="min-w-0">
                      {renderItem ? (
                        renderItem(item, group)
                      ) : (
                        <p className="text-sm font-medium">{item.material}</p>
                      )}
                      <p className="text-xs text-zinc-500">{forLabel(item.forTasks.map(task => task.title))}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {(renderGroupAction || (group.obraId && seeJobLabel)) && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-500/15 p-3">
                {group.obraId && seeJobLabel ? (
                  <a href={`/obras/${group.obraId}`} className="text-xs text-zinc-500 underline">
                    {seeJobLabel}
                  </a>
                ) : (
                  <span />
                )}
                {renderGroupAction?.(group)}
              </div>
            )}
          </div>
        </details>
      ))}
    </>
  );
}

export function EmptyState({ text, cta }: { text: string; cta?: { href: string; label: string } }) {
  return (
    <div className="py-10 text-center text-sm text-zinc-500">
      <p>{text}</p>
      {cta && (
        <a href={cta.href} className="mt-2 inline-block text-emerald-600 underline dark:text-emerald-400">
          {cta.label}
        </a>
      )}
    </div>
  );
}

// Every dashboard empty state funnels back to the chat — the dashboard is
// read-mostly, so "nothing here yet" always means "go ask Capo".
function talkToCapo(locale: Locale) {
  return { href: '/', label: getCatalog(locale).dashboard.talkToCapo };
}

// The /tarefas board row. Explicit non-null shape rather than
// Tables<'task_board'>: Supabase types every view column as nullable, so
// task.id would be string|null and key={task.id} would not typecheck. The
// mapping to non-null happens once, in apps/web's dashboard-data.ts.
export interface BoardTask {
  id: string;
  title: string;
  status: string;
  description: string | null;
  duration_days: number | null;
  materials: string[] | null;
  job_id: string | null;
  job_name: string | null;
  job_status: string | null;
  worker_name: string | null;
  assignee_worker_id: string | null;
  start_date: string | null;
  due_date: string | null;
  // The board's OWN answer to "is this on today / tomorrow", straight off
  // task_board. Re-deriving it here from start_date/due_date would put a
  // second definition of "today" in TypeScript, which is the one thing
  // AGENTS.md forbids: the list and the Hoje chip would eventually disagree
  // and the manager would have no way to tell which was right.
  active_today: boolean;
  active_tomorrow: boolean;
  overdue: boolean;
  days_overdue: number;
  at_risk: boolean;
  risk_blocked: boolean;
  risk_late_start: boolean;
  risk_due_soon: boolean;
  risk_late_dependency: boolean;
  risk_paused_job: boolean;
  late_dependency_titles: string[];
  depends_on_titles: string[];
  // ── Slots for the worker-confirmation loop. Optional ON PURPOSE: the columns
  // arrive in a later migration, and a deploy landing before its migration must
  // degrade rather than error (the AGENTS.md view rule, applied one layer up at
  // the component boundary). Nothing renders them yet.
  confirmation_state?: string | null;
  confirmed_at?: string | null;
  last_reminder_at?: string | null;
  proof_count?: number | null;
}

// Why a task is flagged, in the manager's words. A risk badge with no reason
// is just a colour — the whole point of the "Em risco" filter is that it says
// what is about to go wrong.
export function riskReasons(task: BoardTask, locale: Locale): string[] {
  const t = getCatalog(locale).dashboard;
  const reasons: string[] = [];
  if (task.overdue && task.days_overdue > 0) reasons.push(t.overdueBy(task.days_overdue));
  if (task.risk_blocked) reasons.push(t.risk.blocked);
  if (task.risk_late_start) reasons.push(t.risk.lateStart);
  if (task.risk_due_soon) reasons.push(t.risk.dueSoon);
  if (task.risk_late_dependency) reasons.push(t.risk.lateDependency(task.late_dependency_titles));
  if (task.risk_paused_job) reasons.push(t.risk.pausedJob);
  return reasons;
}

// Exported for the task detail screen — dates on the detail must read exactly
// as they do on the row that led there.
export function formatShortDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(getCatalog(locale).meta.dateLocale, {
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
  }).format(new Date(`${iso}T00:00:00Z`));
}

// The filtered task list behind the Tarefas tab. Grouping is a prop rather
// than a separate component because the only difference between "todas as
// obras, por obra" and "uma obra, por data" is the heading key. Ordering is
// owned by the query, never re-sorted here.
/**
 * How the board splits itself into headed sections.
 *
 * - `obra`   — one section per job site.
 * - `date`   — one section per calendar day, taken off the task's own dates.
 * - `agenda` — one section per *when it lands on the manager*: Atrasadas
 *              first, then Hoje, Amanhã, each later day, and finally the
 *              tasks that carry no date at all. This is the grouping the wide
 *              "Todas" view uses (issue #96), and unlike `date` it needs to
 *              know what day it is — hence the `today` prop below.
 */
export type BoardGrouping = 'date' | 'obra' | 'agenda';

// Sentinel section keys for the agenda grouping. They are chosen so that a
// plain string sort puts the sections in reading order without a second
// ranking table to keep in step: U+0000 sorts before every digit an ISO date
// can start with, U+FFFF after every one of them. Neither can ever collide
// with a real YYYY-MM-DD.
const AGENDA_OVERDUE = '\u0000overdue';
const AGENDA_NO_DATE = '\uffffno-date';

/**
 * The section a task belongs to in the agenda grouping.
 *
 * Overdue wins over everything: a task whose deadline has passed is the
 * manager's problem now, whatever day it was booked for. After that the
 * board's OWN active_today / active_tomorrow flags decide, so the Hoje
 * section holds exactly the tasks the Hoje chip would show — two things
 * called "Hoje" showing different lists is the confusion this whole change
 * exists to end. Everything left over falls to the day it is meant to start,
 * then to its deadline, then to "no date".
 */
function agendaSection(task: BoardTask, today: string, tomorrow: string): string {
  if (task.overdue) return AGENDA_OVERDUE;
  if (task.active_today) return today;
  if (task.active_tomorrow) return tomorrow;
  return task.start_date ?? task.due_date ?? AGENDA_NO_DATE;
}

export function TaskBoardList({
  tasks,
  empty,
  groupBy,
  locale,
  today,
  renderExtra,
  renderBelow,
}: {
  tasks: BoardTask[];
  empty: string;
  groupBy: BoardGrouping;
  locale: Locale;
  /**
   * Today in Europe/Lisbon, from the SAME lisbon_today() clock the board's
   * buckets come from — never from the browser. Required in practice by the
   * `agenda` grouping and ignored by the other two; when it is missing the
   * agenda grouping degrades to plain per-day sections, which is wrong-looking
   * but never wrong.
   */
  today?: string | null;
  // Optional per-row slot (the Concluir/Reabrir buttons), kept as a plain
  // render prop so this package never has to import a mutation.
  renderExtra?: (task: BoardTask) => React.ReactNode;
  // A second slot, full width and below the risk reasons, for content that
  // cannot live in the narrow action column — today the pending-review quote
  // and its three buttons. Same render-prop posture as renderExtra: this
  // package still never imports a mutation.
  renderBelow?: (task: BoardTask) => React.ReactNode;
}) {
  if (tasks.length === 0) return <EmptyState text={empty} cta={talkToCapo(locale)} />;
  const t = getCatalog(locale).dashboard;
  // The agenda grouping cannot name a section "Hoje" without knowing what day
  // it is, and the only honest source for that is lisbon_today() upstream. If
  // the caller could not read it, fall back to plain per-day sections rather
  // than render a heading computed from nothing.
  const grouping: BoardGrouping = groupBy === 'agenda' && !today ? 'date' : groupBy;
  // Agenda sections are keyed on a day, so the component needs tomorrow too.
  // Adding one to an ISO calendar date is not a timezone question — the SQL
  // view does exactly the same thing with `d.today + 1`.
  const tomorrow = grouping === 'agenda' && today ? addOneDay(today) : '';
  const groups = new Map<string, BoardTask[]>();
  for (const task of tasks) {
    const key =
      grouping === 'obra'
        ? (task.job_name ?? t.noJob)
        : grouping === 'agenda'
          ? agendaSection(task, today ?? '', tomorrow)
          : (task.due_date ?? task.start_date ?? 'sem-data');
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }

  // Order WITHIN a section stays query-owned, as it always has. Only the
  // ORDER OF THE SECTIONS is decided here, and only for the agenda grouping,
  // because its keys are computed from a clock the query does not have. The
  // sentinels above make that a plain string sort.
  const sections = [...groups.entries()];
  if (grouping === 'agenda') sections.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  // An empty section is never built, so "no tasks tomorrow" is simply no
  // Amanhã heading — there is nothing to suppress.
  const heading = (key: string): string => {
    if (grouping === 'obra') return key;
    if (key === AGENDA_OVERDUE) return t.agendaOverdue;
    if (key === AGENDA_NO_DATE || key === 'sem-data') return t.noDate;
    if (grouping === 'agenda' && key === today) return t.agendaToday;
    if (grouping === 'agenda' && key === tomorrow) return t.agendaTomorrow;
    return formatDayHeading(key, locale);
  };

  return (
    <>
      {sections.map(([key, groupTasks]) => (
        <section key={key} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{heading(key)}</h2>
          {groupTasks.map(task => {
            const reasons = riskReasons(task, locale);
            // The secondary line carries whatever the heading is NOT already
            // saying: the obra when grouped by date, the deadline otherwise.
            const context =
              grouping === 'obra'
                ? task.due_date && t.dueBy(formatShortDate(task.due_date, locale))
                : (task.job_name ?? t.noJob);
            // Under Atrasadas and Sem data the heading says nothing about
            // WHEN, so the deadline joins the obra on the secondary line
            // rather than being readable only by opening the task.
            const extraContext =
              grouping === 'agenda' && (key === AGENDA_OVERDUE || key === AGENDA_NO_DATE) && task.due_date
                ? t.dueBy(formatShortDate(task.due_date, locale))
                : null;
            return (
              <div
                key={task.id}
                className="relative rounded-xl border border-zinc-500/20 p-3 focus-within:border-zinc-500/40 hover:border-zinc-500/40"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {/* Navigation, not mutation — the same posture as ObrasList.
                        `after:inset-0` stretches the hit target over the whole
                        card, so the row is tappable WITHOUT wrapping it in an
                        anchor: <a> around <button> is invalid HTML and mis-taps
                        on iOS. The action column below lifts itself back out
                        with z-10. */}
                    <a
                      href={`/tarefas/${task.id}`}
                      className="block truncate text-sm font-medium after:absolute after:inset-0"
                    >
                      {task.title}
                    </a>
                    <p className="text-xs text-zinc-500">
                      {task.worker_name ? t.assignedTo(task.worker_name) : t.noAssignee}
                      {context ? ` · ${context}` : ''}
                      {extraContext ? ` · ${extraContext}` : ''}
                    </p>
                  </div>
                  <div className="relative z-10 flex shrink-0 items-center gap-2">
                    <StatusBadge status={task.status} locale={locale} />
                    {renderExtra?.(task)}
                  </div>
                </div>
                {reasons.length > 0 && (
                  <p
                    className={`mt-1 text-xs ${task.overdue ? 'font-medium text-red-600' : 'text-amber-600'}`}
                  >
                    {reasons.join(' · ')}
                  </p>
                )}
                {renderBelow?.(task)}
              </div>
            );
          })}
        </section>
      ))}
    </>
  );
}

// Obras: the sites that still have work to book — ACTIVE and PAUSED — with
// their task tallies and completion progress.
//
// A paused site keeps its row, its tallies and its overdue count (issue #95).
// It is quieter, badged, and carries one line saying what pausing means, so
// "em pausa" can never be read as "something went wrong". Pausing is a normal
// thing a manager does; disappearing is not.
//
// overdueByObra (obra id → count) is optional so existing callers keep
// working; when present, obras with overdue tasks get a red badge.
export function ObrasList({
  obras,
  empty,
  locale,
  overdueByObra,
}: {
  obras: DashboardObra[];
  empty: string;
  locale: Locale;
  overdueByObra?: Record<string, number>;
}) {
  if (obras.length === 0) return <EmptyState text={empty} cta={talkToCapo(locale)} />;
  const t = getCatalog(locale).dashboard;
  return (
    <section className="space-y-2">
      {obras.map(obra => {
        const done = obra.concluidas ?? 0;
        const total = done + (obra.pendentes ?? 0);
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const overdue = obra.id ? (overdueByObra?.[obra.id] ?? 0) : 0;
        const paused = obra.status === 'paused';
        return (
          <a
            key={obra.id}
            href={obra.id ? `/obras/${obra.id}` : undefined}
            className={`block rounded-xl border p-3 hover:border-zinc-500/40 ${
              // Dashed, not greyed out: a dashed edge reads as "on hold", while
              // faded text reads as "disabled" — and the row is fully live.
              paused ? 'border-dashed border-zinc-500/40' : 'border-zinc-500/20'
            }`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium">{obra.name}</p>
              <span className="flex shrink-0 items-baseline gap-2">
                {paused && (
                  <span className="rounded-full border border-zinc-500/40 px-2 py-0.5 text-[11px] text-zinc-500">
                    {t.jobPaused}
                  </span>
                )}
                {/* Still shown on a paused site, on purpose: task_board.overdue
                    deliberately ignores whether the job is active (0013), so a
                    deadline that has already passed is still a deadline that
                    has already passed. */}
                {overdue > 0 && (
                  <span className="text-xs font-medium text-red-600">{t.overdueCount(overdue)}</span>
                )}
              </span>
            </div>
            {obra.address && <p className="text-xs text-zinc-500">{obra.address}</p>}
            {paused && <p className="mt-1 text-xs text-zinc-500">{t.jobPausedHint}</p>}
            {total > 0 && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-500/15">
                {/* TODO(Federico): microcopy/visual dial — bar color per taste. */}
                <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
              </div>
            )}
            <p className="mt-1 text-xs text-zinc-500">
              {total > 0 ? t.progress(done, total, pct) : t.noTasksRegistered}
              {' · '}
              {t.pendingCount(obra.pendentes ?? 0)}
            </p>
          </a>
        );
      })}
    </section>
  );
}

// Obra detail: the plan timeline. Row shape kept local to this component
// (rather than importing a capabilities type from @capo/core) so @capo/ui
// stays a pure presentation package with no core dependency.
export interface TimelineTask {
  id: string;
  title: string;
  status: string;
  start_date: string | null;
  due_date: string | null;
  duration_days: number | null;
  materials: string[] | null;
  assignee_name: string | null;
  depends_on_titles: string[];
}

/**
 * The calendar day after an ISO date. Pure string→string date arithmetic done
 * in UTC, so it never consults the browser's clock or zone: the input already
 * came from lisbon_today(), and "the day after 2026-08-19" has one answer.
 */
function addOneDay(iso: string): string {
  const day = new Date(`${iso}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

function formatDayHeading(iso: string, locale: Locale): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return new Intl.DateTimeFormat(getCatalog(locale).meta.dateLocale, {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date);
}

export function TimelineList({
  tasks,
  empty,
  locale,
  renderExtra,
}: {
  tasks: TimelineTask[];
  empty: string;
  locale: Locale;
  // Optional per-row slot (e.g. Concluir/Reabrir buttons) — kept as a plain
  // render prop so this package never has to import a mutation/action.
  renderExtra?: (task: TimelineTask) => React.ReactNode;
}) {
  if (tasks.length === 0) return <EmptyState text={empty} cta={talkToCapo(locale)} />;
  const t = getCatalog(locale).dashboard;
  const groups = new Map<string, TimelineTask[]>();
  for (const task of tasks) {
    const key = task.start_date ?? 'sem-data';
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return (
    <>
      {[...groups.entries()].map(([key, groupTasks]) => (
        <section key={key} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            {key === 'sem-data' ? t.noDate : formatDayHeading(key, locale)}
          </h2>
          {groupTasks.map(task => (
            <div
              key={task.id}
              className="relative rounded-xl border border-zinc-500/20 p-3 focus-within:border-zinc-500/40 hover:border-zinc-500/40"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {/* Stretched link — see the note in TaskBoardList. */}
                  <a
                    href={`/tarefas/${task.id}`}
                    className="block truncate text-sm font-medium after:absolute after:inset-0"
                  >
                    {task.title}
                  </a>
                  <p className="text-xs text-zinc-500">
                    {task.assignee_name ? t.assignedTo(task.assignee_name) : t.noAssignee}
                  </p>
                </div>
                <div className="relative z-10 flex shrink-0 items-center gap-2">
                  <StatusBadge status={task.status} locale={locale} />
                  {renderExtra?.(task)}
                </div>
              </div>
              {task.depends_on_titles.length > 0 && (
                <p className="mt-1 text-xs text-zinc-500">{t.dependsOn(task.depends_on_titles)}</p>
              )}
              {task.materials && task.materials.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {task.materials.map(m => (
                    <span key={m} className="rounded-full bg-zinc-500/10 px-2 py-0.5 text-[11px] text-zinc-500">
                      {m}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
    </>
  );
}
