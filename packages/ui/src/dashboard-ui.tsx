// Presentational components for the read-only dashboard. No buttons, no
// forms, no mutations — every change to a task goes through the chat.
//
// Every exported component takes `locale` and resolves its own catalog. It does
// NOT take a catalog as a prop: the catalog holds interpolation FUNCTIONS
// (progress, overdueBy, …), and functions cannot be serialized across the RSC
// server→client boundary. Passing a plain string keeps one rule for server and
// client components alike.
import type { Tables } from '@capo/db/types';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

// Row shapes for the dashboard views — defined here (the shared UI package)
// so web and operator render from the same contract; data loaders import
// these types rather than redeclaring them.
export type DashboardTask = Tables<'dashboard_tasks'>;
export type DashboardObra = Tables<'dashboard_obras'>;

// The microcopy dial that used to live here (status labels, overdue phrasing)
// moved to @capo/i18n — one place, three languages, enforced by tsc.

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-zinc-500/10 text-zinc-500',
  in_progress: 'bg-orange-600/10 text-orange-600',
  blocked: 'bg-red-600/10 text-red-600',
  done: 'bg-emerald-700/10 text-emerald-700',
  cancelled: 'bg-zinc-500/10 text-zinc-400 line-through',
};

function StatusBadge({ status, locale }: { status: string | null; locale: Locale }) {
  if (!status) return null;
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
  locale,
  settingsHref,
  children,
}: {
  title: string;
  subtitle?: string;
  locale: Locale;
  /** When set, renders a gear link next to sign-out. */
  settingsHref?: string;
  children: React.ReactNode;
}) {
  const t = getCatalog(locale);
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col">
      <header className="flex items-start justify-between gap-3 border-b border-zinc-500/20 px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-1">
          {settingsHref && (
            <a href={settingsHref} aria-label={t.common.settings} className="text-zinc-500">
              <GearIcon />
            </a>
          )}
          {/* plain form POST: sign-out works even before client JS hydrates */}
          <form method="post" action="/auth/signout">
            <button type="submit" className="text-xs text-zinc-500 underline">
              {t.common.signOut}
            </button>
          </form>
        </div>
      </header>
      <main className="flex-1 space-y-5 overflow-y-auto px-4 py-4">{children}</main>
    </div>
  );
}

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
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

function TaskCard({
  task,
  locale,
  showOverdue,
}: {
  task: DashboardTask;
  locale: Locale;
  showOverdue?: boolean;
}) {
  const t = getCatalog(locale).dashboard;
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-zinc-500/20 p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{task.title}</p>
        <p className="text-xs text-zinc-500">{task.worker_name ?? t.noAssignee}</p>
        {showOverdue && (
          <p className="mt-1 flex flex-wrap gap-2 text-xs">
            {task.days_overdue != null && task.days_overdue > 0 && (
              <span className="font-medium text-red-600">{t.overdueBy(task.days_overdue)}</span>
            )}
            {task.job_status === 'paused' && (
              <span className="rounded-full bg-zinc-500/10 px-2 py-0.5 text-zinc-500">{t.jobPaused}</span>
            )}
          </p>
        )}
      </div>
      <StatusBadge status={task.status} locale={locale} />
    </div>
  );
}

// Hoje/Amanhã: tasks grouped under their obra.
export function TasksByObra({
  tasks,
  empty,
  locale,
}: {
  tasks: DashboardTask[];
  empty: string;
  locale: Locale;
}) {
  if (tasks.length === 0) return <EmptyState text={empty} cta={talkToCapo(locale)} />;
  const noJob = getCatalog(locale).dashboard.noJob;
  const groups = new Map<string, DashboardTask[]>();
  for (const task of tasks) {
    const key = task.job_name ?? noJob;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return (
    <>
      {[...groups.entries()].map(([obra, obraTasks]) => (
        <section key={obra} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{obra}</h2>
          {obraTasks.map(task => (
            <TaskCard key={task.id} task={task} locale={locale} />
          ))}
        </section>
      ))}
    </>
  );
}

// Obras: active jobs with their task tallies and completion progress.
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
        return (
          <a
            key={obra.id}
            href={obra.id ? `/obras/${obra.id}` : undefined}
            className="block rounded-xl border border-zinc-500/20 p-3 hover:border-zinc-500/40"
          >
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium">{obra.name}</p>
              {overdue > 0 && (
                <span className="shrink-0 text-xs font-medium text-red-600">{t.overdueCount(overdue)}</span>
              )}
            </div>
            {obra.address && <p className="text-xs text-zinc-500">{obra.address}</p>}
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
    // Sentinel key, never displayed — the visible label comes from the catalog
    // below, so it can't collide with a real (localized) date heading.
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
            <div key={task.id} className="rounded-xl border border-zinc-500/20 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{task.title}</p>
                  <p className="text-xs text-zinc-500">{task.assignee_name ?? t.noAssignee}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
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

// Atrasadas: flat list, most overdue first (ordering comes from the query).
export function OverdueList({
  tasks,
  empty,
  locale,
}: {
  tasks: DashboardTask[];
  empty: string;
  locale: Locale;
}) {
  if (tasks.length === 0) return <EmptyState text={empty} />;
  return (
    <section className="space-y-2">
      {tasks.map(task => (
        <div key={task.id}>
          {task.job_name && (
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{task.job_name}</p>
          )}
          <TaskCard task={task} locale={locale} showOverdue />
        </div>
      ))}
    </section>
  );
}
