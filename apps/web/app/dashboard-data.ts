// Read-only queries for the dashboard screens. Nothing in this file may
// mutate. Date-bucket and schedule-risk logic lives in SQL (the task_board
// view, driven by lisbon_today()) so the dashboard and the SMS dispatch can
// never disagree about what day it is.
//
// Every function takes the caller's AuthContext: queries run on the
// user-scoped client (RLS-enforced) and the explicit company_id filter is
// kept on top as belt-and-braces.
import type { AuthContext } from '@capo/db/session';
import type { Tables } from '@capo/db/types';
import type { BoardTask, DashboardObra } from '@capo/ui/dashboard-ui';
import type { TarefasFilters } from '@/app/(app)/tarefas/filters';

export type { BoardTask, DashboardObra };

export type GroupBy = 'date' | 'obra';

export interface ObraOption {
  id: string;
  name: string;
  status: string;
}

// The Tarefas board. Every filter is a single boolean column on task_board
// except the specific-date case, which uses the window_start/window_end pair
// the view exposes for exactly this reason — `active_today`/`active_tomorrow`
// are pinned to lisbon_today() and cannot answer "next Tuesday".
export async function loadBoardTasks(
  { db, companyId }: AuthContext,
  filters: TarefasFilters,
  groupBy: GroupBy,
): Promise<BoardTask[]> {
  let query = db.from('task_board').select('*').eq('company_id', companyId);

  if (filters.quando.kind === 'date') {
    const day = filters.quando.iso;
    query = query
      .eq('is_open', true)
      .eq('job_active', true)
      .lte('window_start', day)
      .gte('window_end', day);
  } else {
    switch (filters.quando.value) {
      case 'hoje':
        query = query.eq('active_today', true);
        break;
      case 'amanha':
        query = query.eq('active_tomorrow', true);
        break;
      case 'atrasadas':
        query = query.eq('overdue', true);
        break;
      case 'risco':
        query = query.eq('at_risk', true);
        break;
      case 'todas':
        query = query.eq('is_open', true);
        break;
    }
  }

  if (filters.obraId) query = query.eq('job_id', filters.obraId);

  // Ordering is query-owned; TaskBoardList only groups, never re-sorts.
  const ordered =
    filters.quando.kind === 'keyword' && filters.quando.value === 'atrasadas'
      ? query.order('days_overdue', { ascending: false })
      : groupBy === 'date'
        ? query.order('due_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: true })
        : query.order('job_name', { ascending: true }).order('due_date', { ascending: true, nullsFirst: false });

  const { data } = await ordered;
  return (data ?? []).map(toBoardTask);
}

// Supabase types every view column as nullable. Collapse that once, here, so
// the presentational layer gets a shape it can key and branch on.
function toBoardTask(row: Tables<'task_board'>): BoardTask {
  return {
    id: row.id ?? '',
    title: row.title ?? '',
    status: row.status ?? 'pending',
    job_id: row.job_id,
    job_name: row.job_name,
    worker_name: row.worker_name,
    start_date: row.start_date,
    due_date: row.due_date,
    overdue: row.overdue ?? false,
    days_overdue: row.days_overdue ?? 0,
    at_risk: row.at_risk ?? false,
    risk_blocked: row.risk_blocked ?? false,
    risk_late_start: row.risk_late_start ?? false,
    risk_due_soon: row.risk_due_soon ?? false,
    risk_late_dependency: row.risk_late_dependency ?? false,
    risk_paused_job: row.risk_paused_job ?? false,
    late_dependency_titles: row.late_dependency_titles ?? [],
  };
}

// Options for the obra filter. Reads `jobs`, NOT dashboard_obras: that view is
// `where status = 'active'`, so a paused obra — precisely the one whose tasks
// show up under "Em risco" via risk_paused_job — could never be selected.
export async function loadObraOptions({ db, companyId }: AuthContext): Promise<ObraOption[]> {
  const { data } = await db
    .from('jobs')
    .select('id, name, status')
    .eq('company_id', companyId)
    .order('name', { ascending: true });
  return data ?? [];
}

// The Equipa card on /perfil.
export async function loadTeam({ db, companyId }: AuthContext): Promise<Tables<'workers'>[]> {
  const { data } = await db
    .from('workers')
    .select('*')
    .eq('company_id', companyId)
    .order('active', { ascending: false })
    .order('name', { ascending: true });
  return data ?? [];
}

// Display label for the Hoje/Amanhã headers. The date comes from the same
// lisbon_today() SQL function that drives the buckets — never from local time —
// so the header can't contradict the list under it. Read-only RPC.
export async function loadDayLabel({ db }: AuthContext, offsetDays: 0 | 1): Promise<string | null> {
  const { data } = await db.rpc('lisbon_today');
  if (!data) return null;
  const day = new Date(`${data}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offsetDays);
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(day);
}

export async function loadObras({ db, companyId }: AuthContext): Promise<DashboardObra[]> {
  const { data } = await db
    .from('dashboard_obras')
    .select('*')
    .eq('company_id', companyId)
    .order('name', { ascending: true });
  return data ?? [];
}

// Overdue tallies per obra for the progress view. Reuses the task_board
// overdue flag (same lisbon_today() clock as everything else) — no new SQL
// surface. Tasks without an obra land under the empty-string key.
export async function loadOverdueByObra({ db, companyId }: AuthContext): Promise<Record<string, number>> {
  const { data } = await db.from('task_board').select('job_id').eq('company_id', companyId).eq('overdue', true);
  const counts: Record<string, number> = {};
  for (const task of data ?? []) {
    const key = task.job_id ?? '';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export interface ObraDetailTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  start_date: string | null;
  due_date: string | null;
  duration_days: number | null;
  materials: string[] | null;
  assignee_name: string | null;
  depends_on_titles: string[];
}

export interface ObraDetail {
  job: Tables<'jobs'>;
  tasks: ObraDetailTask[];
}

// The obra detail/timeline screen — ALL tasks (including done), grouped and
// ordered by the caller. RLS-scoped client; job + tasks fetch in parallel,
// dependency titles resolved in a follow-up pass (task_dependencies has two
// self-referencing FKs into tasks, so a plain query beats an embed hint).
export async function loadObraDetail(ctx: AuthContext, jobId: string): Promise<ObraDetail | null> {
  const { db, companyId } = ctx;
  const [{ data: job }, { data: tasks }] = await Promise.all([
    db.from('jobs').select('*').eq('id', jobId).eq('company_id', companyId).maybeSingle(),
    db
      .from('tasks')
      .select('id, title, description, status, start_date, due_date, duration_days, materials, assignee:workers(name)')
      .eq('company_id', companyId)
      .eq('job_id', jobId)
      .order('start_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true }),
  ]);
  if (!job) return null;

  const taskIds = (tasks ?? []).map(t => t.id);
  const depsByTask: Record<string, string[]> = {};
  if (taskIds.length > 0) {
    const { data: deps } = await db.from('task_dependencies').select('task_id, depends_on_task_id').in('task_id', taskIds);
    const depIds = [...new Set((deps ?? []).map(d => d.depends_on_task_id))];
    const { data: depTasks } =
      depIds.length > 0
        ? await db.from('tasks').select('id, title').in('id', depIds)
        : { data: [] as { id: string; title: string }[] };
    const idToTitle = new Map((depTasks ?? []).map(t => [t.id, t.title]));
    for (const d of deps ?? []) {
      const title = idToTitle.get(d.depends_on_task_id);
      if (title) (depsByTask[d.task_id] ??= []).push(title);
    }
  }

  const detailTasks: ObraDetailTask[] = (tasks ?? []).map(t => ({
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    start_date: t.start_date,
    due_date: t.due_date,
    duration_days: t.duration_days,
    materials: t.materials,
    assignee_name: t.assignee?.name ?? null,
    depends_on_titles: depsByTask[t.id] ?? [],
  }));

  return { job, tasks: detailTasks };
}
