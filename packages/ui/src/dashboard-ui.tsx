// Presentational components for the dashboard. No buttons, no forms, no
// mutations in this file — the few interactive controls the manager has
// (Concluir/Reabrir, Sair) are injected by apps/web through render props or
// live on their own page, so this package never imports a server action.
import type { Tables } from '@capo/db/types';

// Row shape for the obras view — defined here (the shared UI package) so web
// and operator render from the same contract; data loaders import this type
// rather than redeclaring it.
export type DashboardObra = Tables<'dashboard_obras'>;

// TODO(Federico): microcopy dial — this map is the manager-facing voice of the
// dashboard (same category as the SMS trim policy and card templates). Tune
// the status labels, the per-screen empty states passed from each page, and
// formatOverdue below ("há 3 dias" vs "3 dias de atraso") to taste.
const STATUS_LABELS: Record<string, string> = {
  pending: 'Pendente',
  in_progress: 'Em curso',
  blocked: 'Bloqueada',
  done: 'Concluída',
  cancelled: 'Cancelada',
};

// TODO(Federico): part of the microcopy dial above.
function formatOverdue(days: number): string {
  return days === 1 ? 'há 1 dia' : `há ${days} dias`;
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-zinc-500/10 text-zinc-500',
  in_progress: 'bg-orange-600/10 text-orange-600',
  blocked: 'bg-red-600/10 text-red-600',
  done: 'bg-emerald-700/10 text-emerald-700',
  cancelled: 'bg-zinc-500/10 text-zinc-400 line-through',
};

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[status] ?? STATUS_STYLES.pending}`}
    >
      {STATUS_LABELS[status] ?? status}
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
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col">
      {/* Sign-out used to live here, in a file whose own contract forbids
          forms. It now lives on /perfil, the tab that owns everything about
          the company and the account. */}
      <header className="border-b border-zinc-500/20 px-4 py-3">
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
      </header>
      <main className="flex-1 space-y-5 overflow-y-auto px-4 py-4">{children}</main>
    </div>
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
const TALK_TO_CAPO = { href: '/', label: 'Falar com o Capo' };

// The /tarefas board row. Explicit non-null shape rather than
// Tables<'task_board'>: Supabase types every view column as nullable, so
// task.id would be string|null and key={task.id} would not typecheck. The
// mapping to non-null happens once, in apps/web's dashboard-data.ts.
export interface BoardTask {
  id: string;
  title: string;
  status: string;
  job_id: string | null;
  job_name: string | null;
  worker_name: string | null;
  start_date: string | null;
  due_date: string | null;
  overdue: boolean;
  days_overdue: number;
  at_risk: boolean;
  risk_blocked: boolean;
  risk_late_start: boolean;
  risk_due_soon: boolean;
  risk_late_dependency: boolean;
  risk_paused_job: boolean;
  late_dependency_titles: string[];
}

// Why a task is flagged, in the manager's words. A risk badge with no reason
// is just a colour — the whole point of the "Em risco" filter is that it says
// what is about to go wrong.
// TODO(Federico): microcopy dial — same category as STATUS_LABELS above.
export function riskReasons(task: BoardTask): string[] {
  const reasons: string[] = [];
  if (task.overdue && task.days_overdue > 0) reasons.push(`Prazo passou ${formatOverdue(task.days_overdue)}`);
  if (task.risk_blocked) reasons.push('bloqueada');
  if (task.risk_late_start) reasons.push('já devia ter começado');
  if (task.risk_due_soon) reasons.push('prazo em 2 dias úteis');
  if (task.risk_late_dependency) reasons.push(`espera por: ${task.late_dependency_titles.join(', ')}`);
  if (task.risk_paused_job) reasons.push('obra pausada');
  return reasons;
}

function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat('pt-PT', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

// The filtered task list behind the Tarefas tab. Grouping is a prop rather
// than a separate component because the only difference between "todas as
// obras, por obra" and "uma obra, por data" is the heading key. Ordering is
// owned by the query, never re-sorted here.
export function TaskBoardList({
  tasks,
  empty,
  groupBy,
  renderExtra,
}: {
  tasks: BoardTask[];
  empty: string;
  groupBy: 'date' | 'obra';
  // Optional per-row slot (the Concluir/Reabrir buttons), kept as a plain
  // render prop so this package never has to import a mutation.
  renderExtra?: (task: BoardTask) => React.ReactNode;
}) {
  if (tasks.length === 0) return <EmptyState text={empty} cta={TALK_TO_CAPO} />;
  const groups = new Map<string, BoardTask[]>();
  for (const task of tasks) {
    const key =
      groupBy === 'obra' ? (task.job_name ?? 'Sem obra') : (task.due_date ?? task.start_date ?? 'sem-data');
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return (
    <>
      {[...groups.entries()].map(([key, groupTasks]) => (
        <section key={key} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            {groupBy === 'obra' ? key : key === 'sem-data' ? 'Sem data' : formatDayHeading(key)}
          </h2>
          {groupTasks.map(task => {
            const reasons = riskReasons(task);
            // The secondary line carries whatever the heading is NOT already
            // saying: the obra when grouped by date, the deadline otherwise.
            const context =
              groupBy === 'obra'
                ? task.due_date && `até ${formatShortDate(task.due_date)}`
                : (task.job_name ?? 'Sem obra');
            return (
              <div key={task.id} className="rounded-xl border border-zinc-500/20 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{task.title}</p>
                    <p className="text-xs text-zinc-500">
                      {task.worker_name ?? 'Sem responsável'}
                      {context ? ` · ${context}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={task.status} />
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
              </div>
            );
          })}
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
  overdueByObra,
}: {
  obras: DashboardObra[];
  empty: string;
  overdueByObra?: Record<string, number>;
}) {
  if (obras.length === 0) return <EmptyState text={empty} cta={TALK_TO_CAPO} />;
  const plural = (n: number | null, one: string, many: string) => `${n ?? 0} ${n === 1 ? one : many}`;
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
                <span className="shrink-0 text-xs font-medium text-red-600">
                  {plural(overdue, 'atrasada', 'atrasadas')}
                </span>
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
              {total > 0
                ? `${done} de ${total} concluídas (${pct}%)`
                : 'sem tarefas registadas'}
              {' · '}
              {plural(obra.pendentes, 'pendente', 'pendentes')}
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

function formatDayHeading(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return new Intl.DateTimeFormat('pt-PT', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(date);
}

export function TimelineList({
  tasks,
  empty,
  renderExtra,
}: {
  tasks: TimelineTask[];
  empty: string;
  // Optional per-row slot (e.g. Concluir/Reabrir buttons) — kept as a plain
  // render prop so this package never has to import a mutation/action.
  renderExtra?: (task: TimelineTask) => React.ReactNode;
}) {
  if (tasks.length === 0) return <EmptyState text={empty} cta={TALK_TO_CAPO} />;
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
            {key === 'sem-data' ? 'Sem data' : formatDayHeading(key)}
          </h2>
          {groupTasks.map(task => (
            <div key={task.id} className="rounded-xl border border-zinc-500/20 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{task.title}</p>
                  <p className="text-xs text-zinc-500">{task.assignee_name ?? 'Sem responsável'}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge status={task.status} />
                  {renderExtra?.(task)}
                </div>
              </div>
              {task.depends_on_titles.length > 0 && (
                <p className="mt-1 text-xs text-zinc-500">⤷ depois de: {task.depends_on_titles.join(', ')}</p>
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
