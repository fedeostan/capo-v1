// Read-only queries for the dashboard screens. The dashboard reads; the chat
// writes — nothing in this file may mutate. Date-bucket logic lives in SQL
// (dashboard_tasks view, driven by lisbon_today()) so the dashboard and the
// SMS dispatch can never disagree about what day it is.
//
// Every function takes the caller's AuthContext: queries run on the
// user-scoped client (RLS-enforced) and the explicit company_id filter is
// kept on top as belt-and-braces.
import type { AuthContext } from '@capo/db/session';
import type { Tables } from '@capo/db/types';
import type { DashboardObra, DashboardTask } from '@capo/ui/dashboard-ui';

export type { DashboardObra, DashboardTask };

type Bucket = 'active_today' | 'active_tomorrow' | 'overdue';

export async function loadTasks({ db, companyId }: AuthContext, bucket: Bucket): Promise<DashboardTask[]> {
  const query = db.from('dashboard_tasks').select('*').eq('company_id', companyId).eq(bucket, true);
  const { data } =
    bucket === 'overdue'
      ? await query.order('days_overdue', { ascending: false })
      : await query.order('job_name', { ascending: true });
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

// Overdue tallies per obra for the progress view. Reuses the dashboard_tasks
// bucket (same lisbon_today() clock as everything else) — no new SQL surface.
// Tasks without an obra land under the empty-string key.
export async function loadOverdueByObra(ctx: AuthContext): Promise<Record<string, number>> {
  const overdue = await loadTasks(ctx, 'overdue');
  const counts: Record<string, number> = {};
  for (const task of overdue) {
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
