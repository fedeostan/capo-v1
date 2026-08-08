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
import { getCatalog } from '@capo/i18n/catalog';
import type { BoardTask, DashboardObra, MaterialsGroup } from '@capo/ui/dashboard-ui';
// Type-only: keeps the 'use client' markdown renderer inside task-detail.tsx
// out of this module's graph.
import type { TaskDetailJob, TaskDetailWorker } from '@capo/ui/task-detail';
import type { TarefasFilters } from '@/app/(app)/tarefas/filters';

export type { BoardTask, DashboardObra, MaterialsGroup, TaskDetailJob, TaskDetailWorker };

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
    // Already on the wire — loadBoardTasks selects '*' and this mapper simply
    // used to drop these. Carrying them costs nothing and is what lets the
    // detail screen render from the same single query.
    description: row.description,
    duration_days: row.duration_days,
    materials: row.materials,
    job_id: row.job_id,
    job_name: row.job_name,
    job_status: row.job_status,
    worker_name: row.worker_name,
    assignee_worker_id: row.assignee_worker_id,
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
    depends_on_titles: row.depends_on_titles ?? [],
  };
}

export interface TaskDetailData {
  task: BoardTask;
  job: TaskDetailJob | null;
  worker: TaskDetailWorker | null;
}

// One task, read from task_board like every other screen — the detail must
// never re-derive overdue/at-risk in TypeScript, or it would be able to
// contradict the board row the manager just tapped.
//
// null means "no such task for this tenant". RLS on the security_invoker view
// makes a foreign uuid indistinguishable from a missing one, which is the
// behaviour we want: the page 404s either way and leaks nothing.
export async function loadTaskDetail(
  { db, companyId }: AuthContext,
  taskId: string,
): Promise<TaskDetailData | null> {
  const { data: row } = await db
    .from('task_board')
    .select('*')
    .eq('id', taskId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (!row) return null;
  const task = toBoardTask(row);

  // The view already denormalises job_name and worker_name. This second pass
  // exists only for what it does NOT carry: the obra's address/client, and the
  // worker's trade/phone/active. The phone matters most — it is why the screen
  // can say a worker is unreachable instead of silently sending nothing.
  const [jobRes, workerRes] = await Promise.all([
    task.job_id
      ? db
          .from('jobs')
          .select('id, name, address, client_name, status')
          .eq('id', task.job_id)
          .eq('company_id', companyId)
          .maybeSingle()
      : null,
    task.assignee_worker_id
      ? db
          .from('workers')
          .select('id, name, trade, phone, active')
          .eq('id', task.assignee_worker_id)
          .eq('company_id', companyId)
          .maybeSingle()
      : null,
  ]);

  return { task, job: jobRes?.data ?? null, worker: workerRes?.data ?? null };
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

/** Per-worker open-task tallies, keyed by worker id. */
export type TeamLoad = Record<string, { today: number; tomorrow: number; open: number; overdue: number }>;

// How loaded each worker is, read from task_board so "today"/"tomorrow" mean
// exactly what they mean on the Tarefas board. Turns the crew list from a
// phone book into something that answers "who is free?" — and, with
// `recebeSms` on the card, exposes the silent failure where an active worker
// has no number and therefore receives nothing from the 07:00 dispatch.
export async function loadTeamLoad({ db, companyId }: AuthContext): Promise<TeamLoad> {
  const { data } = await db
    .from('task_board')
    .select('assignee_worker_id, active_today, active_tomorrow, overdue, is_open')
    .eq('company_id', companyId)
    .eq('is_open', true);
  const load: TeamLoad = {};
  for (const row of data ?? []) {
    if (!row.assignee_worker_id) continue;
    const entry = (load[row.assignee_worker_id] ??= { today: 0, tomorrow: 0, open: 0, overdue: 0 });
    entry.open += 1;
    if (row.active_today) entry.today += 1;
    if (row.active_tomorrow) entry.tomorrow += 1;
    if (row.overdue) entry.overdue += 1;
  }
  return load;
}

// "Tonight's actions" (03_PRODUCT/02-flows.md §Flow 3): everything the manager
// has to buy or arrange before the crew arrives. Grouped by obra because that
// is how a builder shops — one trip per site — and each material carries the
// tasks that need it so the list stays challengeable rather than magic.
//
// Two horizons: `amanha` is what you buy tonight; `semana` is what you ORDER
// tonight, because anything with a lead time is already late by the time it
// shows up on the tomorrow list.
export async function loadMaterials(
  { db, companyId }: AuthContext,
  horizon: 'amanha' | 'semana',
  today: string | null,
): Promise<MaterialsGroup[]> {
  let query = db.from('task_board').select('job_id, job_name, title, materials').eq('company_id', companyId);

  if (horizon === 'amanha') {
    query = query.eq('active_tomorrow', true);
  } else {
    // Window intersection with [today, today+6], the same shape the board's
    // specific-day filter uses. lisbon_today() stays the only clock.
    if (!today) return [];
    const end = new Date(`${today}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 6);
    query = query
      .eq('is_open', true)
      .eq('job_active', true)
      .lte('window_start', end.toISOString().slice(0, 10))
      .gte('window_end', today);
  }

  const { data } = await query.order('job_name', { ascending: true });

  const byJob = new Map<string, { obraId: string | null; items: Map<string, Set<string>> }>();
  for (const task of data ?? []) {
    if (!task.materials?.length) continue;
    const key = task.job_name ?? '';
    const group = byJob.get(key) ?? { obraId: task.job_id, items: new Map<string, Set<string>>() };
    for (const material of task.materials) {
      const forTasks = group.items.get(material) ?? new Set<string>();
      if (task.title) forTasks.add(task.title);
      group.items.set(material, forTasks);
    }
    byJob.set(key, group);
  }

  return [...byJob.entries()].map(([obraName, { obraId, items }]) => ({
    obraId,
    obraName,
    items: [...items.entries()]
      .map(([material, forTasks]) => ({ material, forTasks: [...forTasks] }))
      .sort((a, b) => a.material.localeCompare(b.material)),
  }));
}

/** Today in Europe/Lisbon, straight from the SQL clock. */
export async function loadToday({ db }: AuthContext): Promise<string | null> {
  const { data } = await db.rpc('lisbon_today');
  return data ?? null;
}

// Display label for the Hoje/Amanhã headers. The date comes from the same
// lisbon_today() SQL function that drives the buckets — never from local time —
// so the header can't contradict the list under it. Read-only RPC.
export async function loadDayLabel(ctx: AuthContext, offsetDays: 0 | 1): Promise<string | null> {
  const { data } = await ctx.db.rpc('lisbon_today');
  if (!data) return null;
  const day = new Date(`${data}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offsetDays);
  // The DATE still comes from lisbon_today() — only its FORMATTING follows the
  // reader's locale. An English-speaking manager on a Portuguese company sees
  // the same day, spelled his way.
  return new Intl.DateTimeFormat(getCatalog(ctx.locale).meta.dateLocale, {
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

/** A live completion claim, attached to the board row of the task it is about. */
export interface PendingReview {
  id: string;
  taskId: string;
  note: string | null;
  declaredAt: string;
  /** null = the manager opened this check themselves. */
  declaredByName: string | null;
}

/**
 * Pending reviews for a set of board rows, keyed by task id.
 *
 * Two reads rather than one PostgREST embed: the worker name comes through a
 * nullable FK whose embed alias depends on the constraint's generated name,
 * and a rename would break it silently at runtime. Two explicit queries cannot
 * drift that way, and the second is skipped entirely when no review names a
 * worker (the manager-initiated case).
 *
 * Empty input short-circuits — `.in('task_id', [])` is a valid but pointless
 * round trip on a board with no open tasks.
 */
export async function loadPendingReviews(
  { db, companyId }: AuthContext,
  taskIds: string[],
): Promise<Map<string, PendingReview>> {
  if (taskIds.length === 0) return new Map();

  const { data: reviews, error } = await db
    .from('task_reviews')
    .select('id, task_id, note, declared_at, declared_by_worker_id')
    .eq('company_id', companyId)
    .eq('status', 'pending')
    .in('task_id', taskIds);
  if (error) throw new Error(`task_reviews read failed: ${error.message}`);

  const rows = reviews ?? [];
  const workerIds = [...new Set(rows.map(r => r.declared_by_worker_id).filter((id): id is string => Boolean(id)))];

  const names = new Map<string, string>();
  if (workerIds.length > 0) {
    const { data: crew, error: crewError } = await db
      .from('workers')
      .select('id, name')
      .eq('company_id', companyId)
      .in('id', workerIds);
    if (crewError) throw new Error(`workers read failed: ${crewError.message}`);
    for (const w of crew ?? []) names.set(w.id, w.name);
  }

  // task_reviews_one_pending_idx guarantees at most one pending row per task,
  // so a plain Map keyed by task id cannot lose anything.
  return new Map(
    rows.map(r => [
      r.task_id,
      {
        id: r.id,
        taskId: r.task_id,
        note: r.note,
        declaredAt: r.declared_at,
        declaredByName: r.declared_by_worker_id ? (names.get(r.declared_by_worker_id) ?? null) : null,
      },
    ]),
  );
}
