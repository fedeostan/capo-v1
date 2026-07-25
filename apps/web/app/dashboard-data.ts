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
import type { AgendaCounts, DashboardObra, DashboardTask, MaterialsGroup, TeamMember } from '@capo/ui/dashboard-ui';

export type { AgendaCounts, DashboardObra, DashboardTask, MaterialsGroup, TeamMember };

type Bucket = 'active_today' | 'active_tomorrow' | 'overdue' | 'active_this_week';

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

// Counts for the Hoje/Amanhã/Atrasadas segmented header. One pass over the
// same view the lists themselves read, so a badge can never contradict the
// list it links to.
export async function loadAgendaCounts({ db, companyId }: AuthContext): Promise<AgendaCounts> {
  const { data } = await db
    .from('dashboard_tasks')
    .select('active_today, active_tomorrow, overdue')
    .eq('company_id', companyId);
  const counts: AgendaCounts = { hoje: 0, amanha: 0, atrasadas: 0 };
  for (const row of data ?? []) {
    if (row.active_today) counts.hoje += 1;
    if (row.active_tomorrow) counts.amanha += 1;
    if (row.overdue) counts.atrasadas += 1;
  }
  return counts;
}

// "Tonight's actions" (03_PRODUCT/02-flows.md §Flow 3): everything the manager
// has to buy or arrange before the crew arrives. Grouped by obra because that
// is how a builder shops — one trip per site — and each material carries the
// tasks that need it so the list stays challengeable rather than magic.
export async function loadMaterials(ctx: AuthContext, bucket: Bucket): Promise<MaterialsGroup[]> {
  const tasks = await loadTasks(ctx, bucket);
  const byObra = new Map<string, { obraId: string | null; items: Map<string, Set<string>> }>();

  for (const task of tasks) {
    // `?? []` and not `!` on purpose: if 0013 has not been applied yet the
    // column is simply absent, and the screen shows "nothing to buy" instead
    // of throwing.
    const materials = task.materials ?? [];
    if (materials.length === 0) continue;
    const key = task.job_name ?? 'Sem obra';
    const group = byObra.get(key) ?? { obraId: task.job_id, items: new Map<string, Set<string>>() };
    for (const material of materials) {
      const forTasks = group.items.get(material) ?? new Set<string>();
      if (task.title) forTasks.add(task.title);
      group.items.set(material, forTasks);
    }
    byObra.set(key, group);
  }

  return [...byObra.entries()].map(([obraName, { obraId, items }]) => ({
    obraId,
    obraName,
    items: [...items.entries()]
      .map(([material, forTasks]) => ({ material, forTasks: [...forTasks] }))
      .sort((a, b) => a.material.localeCompare(b.material, 'pt')),
  }));
}

// The team screen: who is on the crew, whether the 07:00 SMS can actually
// reach them, and what each of them is carrying. `recebeSms` mirrors the
// dispatch_tasks_today predicate (active worker with a phone) — a worker
// without a number silently gets nothing, which is worth showing loudly.
export async function loadTeam(ctx: AuthContext): Promise<TeamMember[]> {
  const { db, companyId } = ctx;
  const [{ data: workers }, { data: tasks }] = await Promise.all([
    db.from('workers').select('id, name, trade, phone').eq('company_id', companyId).eq('active', true).order('name'),
    db.from('dashboard_tasks').select('*').eq('company_id', companyId),
  ]);

  return (workers ?? []).map(worker => {
    const mine = (tasks ?? []).filter(t => t.assignee_worker_id === worker.id);
    return {
      id: worker.id,
      name: worker.name,
      trade: worker.trade,
      phone: worker.phone,
      recebeSms: Boolean(worker.phone),
      today: mine.filter(t => t.active_today).length,
      tomorrow: mine.filter(t => t.active_tomorrow).length,
      overdue: mine.filter(t => t.overdue).length,
      open: mine.length,
      todayTitles: mine.filter(t => t.active_today).map(t => t.title ?? '').filter(Boolean),
    };
  });
}

// Tasks with nobody assigned are invisible to the SMS dispatch entirely — they
// will never reach a worker. Surfaced on the team screen so the gap is
// impossible to miss.
//
// `assignee_worker_id` arrives with migration 0013. Before it lands the column
// is absent from every row, which would make EVERY task look unassigned and
// raise a false alarm — so the check is "the column exists and is empty",
// not "the field is falsy".
export async function loadUnassignedToday(ctx: AuthContext): Promise<DashboardTask[]> {
  const tasks = await loadTasks(ctx, 'active_today');
  return tasks.filter(t => 'assignee_worker_id' in t && !t.assignee_worker_id);
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
