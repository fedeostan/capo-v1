// Presentational components for the read-only dashboard. No buttons, no
// forms, no mutations — every change to a task goes through the chat.
import type { Tables } from '@capo/db/types';

// Row shapes for the dashboard views — defined here (the shared UI package)
// so web and operator render from the same contract; data loaders import
// these types rather than redeclaring them.
export type DashboardTask = Tables<'dashboard_tasks'>;
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
      <header className="flex items-start justify-between gap-3 border-b border-zinc-500/20 px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
        </div>
        {/* plain form POST: sign-out works even before client JS hydrates */}
        <form method="post" action="/auth/signout">
          <button type="submit" className="pt-1 text-xs text-zinc-500 underline">
            Sair
          </button>
        </form>
      </header>
      <main className="flex-1 space-y-5 overflow-y-auto px-4 py-4">{children}</main>
    </div>
  );
}

export function EmptyState({ text }: { text: string }) {
  return <p className="py-10 text-center text-sm text-zinc-500">{text}</p>;
}

function TaskCard({ task, showOverdue }: { task: DashboardTask; showOverdue?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-zinc-500/20 p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{task.title}</p>
        <p className="text-xs text-zinc-500">{task.worker_name ?? 'Sem responsável'}</p>
        {showOverdue && (
          <p className="mt-1 flex flex-wrap gap-2 text-xs">
            {task.days_overdue != null && task.days_overdue > 0 && (
              <span className="font-medium text-red-600">
                Prazo passou {formatOverdue(task.days_overdue)}
              </span>
            )}
            {task.job_status === 'paused' && (
              <span className="rounded-full bg-zinc-500/10 px-2 py-0.5 text-zinc-500">
                obra pausada
              </span>
            )}
          </p>
        )}
      </div>
      <StatusBadge status={task.status} />
    </div>
  );
}

// Hoje/Amanhã: tasks grouped under their obra.
export function TasksByObra({ tasks, empty }: { tasks: DashboardTask[]; empty: string }) {
  if (tasks.length === 0) return <EmptyState text={empty} />;
  const groups = new Map<string, DashboardTask[]>();
  for (const task of tasks) {
    const key = task.job_name ?? 'Sem obra';
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return (
    <>
      {[...groups.entries()].map(([obra, obraTasks]) => (
        <section key={obra} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{obra}</h2>
          {obraTasks.map(task => (
            <TaskCard key={task.id} task={task} />
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
  overdueByObra,
}: {
  obras: DashboardObra[];
  empty: string;
  overdueByObra?: Record<string, number>;
}) {
  if (obras.length === 0) return <EmptyState text={empty} />;
  const plural = (n: number | null, one: string, many: string) => `${n ?? 0} ${n === 1 ? one : many}`;
  return (
    <section className="space-y-2">
      {obras.map(obra => {
        const done = obra.concluidas ?? 0;
        const total = done + (obra.pendentes ?? 0);
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const overdue = obra.id ? (overdueByObra?.[obra.id] ?? 0) : 0;
        return (
          <div key={obra.id} className="rounded-xl border border-zinc-500/20 p-3">
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
          </div>
        );
      })}
    </section>
  );
}

// Atrasadas: flat list, most overdue first (ordering comes from the query).
export function OverdueList({ tasks, empty }: { tasks: DashboardTask[]; empty: string }) {
  if (tasks.length === 0) return <EmptyState text={empty} />;
  return (
    <section className="space-y-2">
      {tasks.map(task => (
        <div key={task.id}>
          {task.job_name && (
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {task.job_name}
            </p>
          )}
          <TaskCard task={task} showOverdue />
        </div>
      ))}
    </section>
  );
}
