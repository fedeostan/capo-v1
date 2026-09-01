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
import { TASK_PHOTO_BUCKET } from '@capo/core/media/photos';
import { everyoneOnTask, readCollaborators, type Collaborator } from '@capo/core/capabilities/collaborators';
import { getCatalog } from '@capo/i18n/catalog';
import type { BoardGrouping, BoardTask, DashboardObra, MaterialsGroup, MaterialsTask } from '@capo/ui/dashboard-ui';
// Type-only: keeps the 'use client' markdown renderer inside task-detail.tsx
// out of this module's graph.
import type { TaskDetailJob, TaskDetailWorker } from '@capo/ui/task-detail';
import type { TarefasFilters } from '@/app/(app)/tarefas/filters';

export type { BoardGrouping, BoardTask, DashboardObra, MaterialsGroup, MaterialsTask, TaskDetailJob, TaskDetailWorker };

// Re-exported rather than redefined so the loader and the component can never
// drift apart on what groupings exist.
export type GroupBy = BoardGrouping;

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

  // Ordering of the ROWS is query-owned, and that is what decides the order
  // inside each section. (The agenda grouping additionally sorts its SECTIONS
  // in the component, because their keys are computed from a clock the query
  // does not have — see TaskBoardList.)
  const ordered =
    filters.quando.kind === 'keyword' && filters.quando.value === 'atrasadas'
      ? query.order('days_overdue', { ascending: false })
      : groupBy === 'obra'
        ? query.order('job_name', { ascending: true }).order('due_date', { ascending: true, nullsFirst: false })
        : query.order('due_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: true });

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
    active_today: row.active_today ?? false,
    active_tomorrow: row.active_tomorrow ?? false,
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
  /**
   * Everyone else on this task (issue #44) — the helpers, never the assignee.
   *
   * Read off the same `task_board` row as everything else on this screen, so
   * the detail page and the 07:00 briefing cannot disagree about who is on a
   * job. Empty on a deploy landing before 0035, which renders as "only the
   * assignee" — the truth at that moment.
   */
  collaborators: Collaborator[];
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

  return {
    task,
    job: jobRes?.data ?? null,
    worker: workerRes?.data ?? null,
    // No third query: the view already carries the ids and names, aggregated in
    // the same statement that produced this row.
    collaborators: readCollaborators(row),
  };
}

/** One active crew member as an assignment candidate, with how busy they are
 *  on this task's own day. See loadAssignableWorkers for what "busy" means. */
export interface AssignableWorker {
  id: string;
  name: string;
  trade: string | null;
  /**
   * How many OTHER open tasks this worker already has active on the target
   * date. 0 means free; a positive number means busy.
   *
   * `null` means UNKNOWN — the task carries no date at all, so nothing can be
   * said either way. Rendered without a badge, never as "free": an incorrect
   * "free" label is worse than no label, because the manager acts on it.
   */
  busyOn: number | null;
}

export interface AssignableWorkers {
  /** The day availability was computed for (ISO date), or null when unknown. */
  date: string | null;
  /** Free first, then by name. Never filtered — a manager must always be able
   *  to double-book if the job needs it; the list only ever LABELS. */
  workers: AssignableWorker[];
}

/**
 * The worker picker on /tarefas/[id]: the company's ACTIVE crew, each marked
 * free or busy on the day the task is scheduled for.
 *
 * ── WHAT "FREE" MEANS HERE, EXACTLY ────────────────────────────────────────
 * This schema has no availability, absence, holiday or shift model. There is
 * therefore no way to know whether someone is actually available. "Free" is
 * defined narrowly and conservatively as:
 *
 *   the worker has NO OTHER OPEN TASK whose active window covers the target
 *   date, on an obra that is itself active.
 *
 * The target date is the task's own `start_date`, falling back to `due_date`.
 *
 * The predicate is NOT re-derived in TypeScript. It is the exact filter the
 * Tarefas board already uses for a specific day (see loadBoardTasks above):
 * `is_open AND job_active AND window_start <= day <= window_end`, where all
 * four columns are computed inside the `task_board` view from lisbon_today()
 * and the task's own dates. That is the AGENTS.md invariant — one clock, one
 * definition of "what is on that day" — and it is why this reads the view
 * rather than `tasks`. `active_today`/`active_tomorrow` are deliberately NOT
 * used: they are pinned to lisbon_today() and cannot answer "next Tuesday",
 * which is precisely why the view exposes window_start/window_end.
 *
 * Two consequences worth naming rather than discovering later:
 *  - A task with NO start_date and NO due_date has no target date. Every
 *    worker then comes back with `busyOn: null` and the picker says outright
 *    that it cannot tell — it does not guess, and it does not say "free".
 *  - A worker holding an open-ended task (one with no due_date, so its window
 *    runs to 'infinity') counts as busy on every future day. That errs toward
 *    "busy", which is the safe direction: the cost of an unlabelled busy
 *    worker is a manager reading one extra line, the cost of a wrong "free"
 *    is a double-booked crew.
 */
export async function loadAssignableWorkers(
  { db, companyId }: AuthContext,
  task: { id: string; start_date: string | null; due_date: string | null },
): Promise<AssignableWorkers> {
  const date = task.start_date ?? task.due_date;

  const { data: crew, error } = await db
    .from('workers')
    .select('id, name, trade')
    .eq('company_id', companyId)
    .eq('active', true)
    .order('name', { ascending: true });
  if (error) throw new Error(`workers read failed: ${error.message}`);
  const roster = crew ?? [];

  if (!date || roster.length === 0) {
    return { date: null, workers: roster.map(w => ({ ...w, busyOn: null })) };
  }

  // Same shape as loadBoardTasks' specific-date branch, minus the obra filter
  // and minus this task itself — a task does not make its own assignee busy.
  //
  // `select('*')` since #44, not the one column it used to name. The count now
  // includes COLLABORATORS, whose two columns 0035 appends to the view — and an
  // explicit list naming them would 42703 on a deploy that lands before the
  // migration, which for this screen means the picker cannot open at all.
  // With select('*') the pre-migration read simply counts leads, exactly as it
  // does today.
  const { data: sameDay, error: boardError } = await db
    .from('task_board')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_open', true)
    .eq('job_active', true)
    .lte('window_start', date)
    .gte('window_end', date)
    .neq('id', task.id);
  if (boardError) throw new Error(`task_board read failed: ${boardError.message}`);

  // Everyone on the task, not just its lead. Somebody spending the day helping
  // on a wall is on that wall, and this picker's whole promise is that it never
  // labels such a person "free" — see AssignableWorker.busyOn.
  const busy = new Map<string, number>();
  for (const row of sameDay ?? []) {
    for (const workerId of everyoneOnTask(row)) {
      busy.set(workerId, (busy.get(workerId) ?? 0) + 1);
    }
  }

  const workers = roster
    .map(w => ({ ...w, busyOn: busy.get(w.id) ?? 0 }))
    .sort((a, b) => a.busyOn - b.busyOn || a.name.localeCompare(b.name));

  return { date, workers };
}

// Options for the obra filter. Reads `jobs`, NOT dashboard_obras. Since 0038
// that view carries active AND paused, so the paused case is covered there
// now — but it still excludes `done`, and the filter has to be able to select
// a finished obra. Reading the base table is what keeps every status
// selectable regardless of what the view decides to show.
export async function loadObraOptions({ db, companyId }: AuthContext): Promise<ObraOption[]> {
  const { data } = await db
    .from('jobs')
    .select('id, name, status')
    .eq('company_id', companyId)
    .order('name', { ascending: true });
  return data ?? [];
}

// The Equipa card on /perfil.
//
// select('*'), so `last_inbound_at` (0030) rides along without being named —
// the crew screen reads it to tell "receives the 07:00 WhatsApp" apart from
// "receives it but has never once written back" (issue #153). Naming the
// column would couple this read to that migration for no gain.
//
// The failure is LOGGED rather than swallowed silently, and that is the point
// of the line: every state on this card is derived from these rows, so a read
// that fails renders an EMPTY crew — and a read that half-fails would have the
// screen telling the manager "still nothing" about somebody who replied
// perfectly. Same posture as home-data.ts: swallowed, but greppable.
export async function loadTeam({ db, companyId }: AuthContext): Promise<Tables<'workers'>[]> {
  const { data, error } = await db
    .from('workers')
    .select('*')
    .eq('company_id', companyId)
    .order('active', { ascending: false })
    .order('name', { ascending: true });
  if (error) console.warn('profile.team_read_failed', error.message);
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
  // select('*') since #44, for the reason loadAssignableWorkers gives: the
  // tallies now count collaborators, whose columns 0035 appends to the view.
  const { data } = await db
    .from('task_board')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_open', true);
  const load: TeamLoad = {};
  for (const row of data ?? []) {
    // Lead AND helpers. A crew card that showed "0 tarefas hoje" next to
    // somebody who is spending the day on the Casa de Paco would be answering
    // "quem está livre?" with the wrong name.
    for (const workerId of everyoneOnTask(row)) {
      const entry = (load[workerId] ??= { today: 0, tomorrow: 0, open: 0, overdue: 0 });
      entry.open += 1;
      if (row.active_today) entry.today += 1;
      if (row.active_tomorrow) entry.tomorrow += 1;
      if (row.overdue) entry.overdue += 1;
    }
  }
  return load;
}

// "Tonight's actions" (03_PRODUCT/02-flows.md §Flow 3): everything the manager
// has to buy or arrange before the crew arrives. Grouped by obra because that
// is how a builder shops — one trip per site — and each material carries the
// tasks that need it so the list stays challengeable rather than magic.
//
// Three horizons, and the third asks a DIFFERENT question (issue #154).
// `amanha` is what you buy tonight; `semana` is what you ORDER tonight,
// because anything with a lead time is already late by the time it shows up on
// the tomorrow list. Both are anticipation. `hoje` is not: at 06:40 the
// manager is not asking what to buy, they are asking whether it is there.
//
// `hoje` reads `active_today` exactly as `amanha` reads `active_tomorrow` —
// the view and lisbon_today() decide what today means, never this file.
export async function loadMaterials(
  { db, companyId }: AuthContext,
  horizon: 'hoje' | 'amanha' | 'semana',
  today: string | null,
): Promise<MaterialsGroup[]> {
  // `id` joined the select for issue #60: a material can now be edited from
  // this screen, and every write has to name the task row it belongs to.
  let query = db.from('task_board').select('id, job_id, job_name, title, materials').eq('company_id', companyId);

  if (horizon === 'hoje') {
    query = query.eq('active_today', true);
  } else if (horizon === 'amanha') {
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

  // Two collections per obra, and the difference matters (issue #60):
  //   * `items` is still built only from tasks that ALREADY carry materials —
  //     the buy-tonight list is unchanged, and the amber banner on /tarefas
  //     counts these, so its number cannot drift.
  //   * `tasks` holds every task of the obra in this horizon, materials or
  //     not, because a task with an empty list is exactly the one a manager
  //     wants to add to. Filtering it out would make the obra unaddable.
  // The consequence to know about: an obra with work tomorrow and nothing
  // recorded now appears as an empty group rather than not at all. That is
  // deliberate — otherwise "add a material" is only reachable for obras that
  // already have one.
  const byJob = new Map<
    string,
    { obraId: string | null; items: Map<string, Map<string, MaterialsTask>>; tasks: Map<string, MaterialsTask> }
  >();
  for (const row of data ?? []) {
    // The view types every column nullable. A row with no id could not be
    // written to anyway, and a row with no title has nothing to show.
    if (!row.id || !row.title) continue;
    const key = row.job_name ?? '';
    const group = byJob.get(key) ?? { obraId: row.job_id, items: new Map(), tasks: new Map() };
    const task: MaterialsTask = { id: row.id, title: row.title, materials: row.materials ?? [] };
    group.tasks.set(task.id, task);
    for (const material of row.materials ?? []) {
      const forTasks = group.items.get(material) ?? new Map<string, MaterialsTask>();
      forTasks.set(task.id, task);
      group.items.set(material, forTasks);
    }
    byJob.set(key, group);
  }

  return [...byJob.entries()].map(([obraName, { obraId, items, tasks }]) => ({
    obraId,
    obraName,
    items: [...items.entries()]
      .map(([material, forTasks]) => ({ material, forTasks: [...forTasks.values()] }))
      .sort((a, b) => a.material.localeCompare(b.material)),
    tasks: [...tasks.values()].sort((a, b) => a.title.localeCompare(b.title)),
  }));
}

/** What a manager answered about one material today: it is on site, or it is
 *  missing. Absent from the map = not answered yet, which is also what an
 *  explicitly withdrawn answer ('unknown' in the table) reads as. */
export type MaterialCheckState = 'on_site' | 'missing';

/** Today's ticks, keyed by {@link materialCheckKey}. */
export type MaterialChecks = Record<string, MaterialCheckState>;

/**
 * The one key both the reader and the screen use.
 *
 * Obra + the material string VERBATIM, which is exactly how the materials list
 * groups and de-duplicates rows — so a tick can never be rendered against a
 * row it does not belong to. A null obra is the "Sem obra" group and is a real
 * case: `tasks.job_id` is nullable, and migration 0044's unique index is
 * `nulls not distinct` for that reason.
 */
export function materialCheckKey(obraId: string | null, material: string): string {
  return `${obraId ?? ''} ${material}`;
}

/**
 * Today's walk-around answers (issue #154, migration 0044).
 *
 * `today` comes from lisbon_today() — the same clock task_board reads — and is
 * part of the key in the table, which is what makes the tick reset overnight
 * BY CONSTRUCTION: yesterday's rows simply are not today's. Nothing sweeps.
 *
 * Degrades to "nothing ticked" on any failure, including the 42P01 a deploy
 * landing before its migration answers. That is byte-identical to the product
 * before this feature, which is the right cost for a read; the WRITE path
 * deliberately does not swallow, because a tick that silently did not land is
 * the one thing a check list must never produce.
 */
export async function loadMaterialChecks(
  { db, companyId }: AuthContext,
  today: string | null,
): Promise<MaterialChecks> {
  if (!today) return {};
  const { data, error } = await db
    .from('material_checks')
    .select('job_id, material, status')
    .eq('company_id', companyId)
    .eq('check_date', today);
  if (error) {
    // Swallowed but greppable, the same posture as loadCompanySnapshot. Grep
    // this before concluding that a screen with no ticks means nobody ticks.
    console.warn('materials.checks_read_failed', error.message);
    return {};
  }
  const checks: MaterialChecks = {};
  for (const row of data ?? []) {
    if (row.status !== 'on_site' && row.status !== 'missing') continue;
    checks[materialCheckKey(row.job_id, row.material)] = row.status;
  }
  return checks;
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

/**
 * The Obras screen. Since 0038 this view carries PAUSED sites as well as
 * active ones (issue #95) — a paused obra is a site where no work should be
 * booked right now, not a site that has gone away.
 *
 * The paused rows are sorted to the BOTTOM here rather than in SQL. The two
 * status values happen to sort the right way alphabetically ('active' before
 * 'paused'), and leaning on that would be an invariant nobody could see: it
 * breaks silently the day a fourth status is added. A named comparator says
 * what is meant. Name order inside each block still comes from the query.
 */
export async function loadObras({ db, companyId }: AuthContext): Promise<DashboardObra[]> {
  const { data } = await db
    .from('dashboard_obras')
    .select('*')
    .eq('company_id', companyId)
    .order('name', { ascending: true });
  const rank = (obra: DashboardObra): number => (obra.status === 'paused' ? 1 : 0);
  return [...(data ?? [])].sort((a, b) => rank(a) - rank(b));
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
  /** true when a worker filed this claim, even if their name did not resolve
   *  (e.g. their crew row is gone or invisible while the review is still
   *  pending). Carried separately from `declaredByName` so the UI can still
   *  attribute the note to a worker rather than silently reading as the
   *  manager's own check — see declaredByName below. */
  declaredByWorker: boolean;
  /** null when either the manager opened this check themselves, OR a worker
   *  did but their name did not resolve. Branch on `declaredByWorker`, not on
   *  this, to tell those two apart. */
  declaredByName: string | null;
  /**
   * How many photos are attached to the task this claim is about (issue #52).
   *
   * ── WHY IT IS COUNTED HERE AND NOT STORED ON THE REVIEW ──────────────────
   * A photo can arrive MINUTES AFTER the claim: the check-in tap files the
   * claim, Capo then asks for a photo, and the worker sends it whenever they
   * get to it. Anything denormalised onto `task_reviews` at insert time would
   * say "no photo" forever, be wrong three minutes later, and be wrong
   * invisibly. Counted at read time it is true whenever the screen is looked
   * at, which is the only moment it is read.
   *
   * EVERY photo on the task, with no time filter and no source filter, and
   * both of those are deliberate. A time filter would break the agent path,
   * where photos are written BEFORE the review by design (proof with no claim
   * is untidy; a claim with no proof is the state the requirement exists to
   * prevent) and therefore carry an earlier `created_at` than the review they
   * belong to. A source filter would hide the manager's own photos, which are
   * evidence about the same work. The copy is correspondingly literal — "3
   * photos attached", a statement about the task — rather than a claim about
   * who took them or when.
   */
  photoCount: number;
}

/**
 * Pending reviews for a set of board rows, keyed by task id.
 *
 * Three reads rather than one PostgREST embed: the worker name comes through a
 * nullable FK whose embed alias depends on the constraint's generated name,
 * and a rename would break it silently at runtime. Explicit queries cannot
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

  const photos = await countTaskPhotos(
    { db, companyId },
    rows.map(r => r.task_id),
  );

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
        declaredByWorker: Boolean(r.declared_by_worker_id),
        declaredByName: r.declared_by_worker_id ? (names.get(r.declared_by_worker_id) ?? null) : null,
        photoCount: photos.get(r.task_id) ?? 0,
      },
    ]),
  );
}

/**
 * How many photos each of these tasks has, keyed by task id. Tasks with none
 * are simply absent from the map.
 *
 * Ids only — no urls, no bytes, no signed anything. This answers "is there
 * proof", which is a count; showing the photos themselves is
 * `loadTaskPhotos()`'s job and lives behind a dynamic segment because a signed
 * URL is a bearer token (see the note there).
 *
 * Shared by the board (loadPendingReviews) and the in-app inbox, so the two
 * cannot disagree about the same claim — the same reason push and inbox share
 * one headline catalog entry.
 */
export async function countTaskPhotos(
  { db, companyId }: Pick<AuthContext, 'db' | 'companyId'>,
  taskIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return counts;

  const { data, error } = await db
    .from('task_photos')
    .select('task_id')
    .eq('company_id', companyId)
    .in('task_id', ids);
  // Soft failure, unlike the reads above: "how much proof is attached" is a
  // detail ON a review, and losing it must never take down the board the review
  // is rendered on. An empty map reads as "no photos", which under-reports
  // rather than inventing evidence — the safe direction to be wrong in.
  if (error) return counts;

  for (const row of data ?? []) {
    counts.set(row.task_id, (counts.get(row.task_id) ?? 0) + 1);
  }
  return counts;
}

/** One photo attached to a task, with a URL that works for the next few minutes. */
export interface TaskPhoto {
  id: string;
  /** A freshly minted signed URL. Never store or cache this — see below. */
  url: string;
  /** 'worker' (PRD 4, via WhatsApp) or 'manager' (the completion sheet). The
   *  detail screen says which, because "the crew sent this" and "I took this"
   *  are different claims. */
  source: string;
  createdAt: string;
}

/**
 * The photos on one task, newest first, each with a signed URL.
 *
 * SIGNED URLS ARE MINTED PER REQUEST AND MUST STAY THAT WAY. A signed URL is a
 * bearer token in a query string: anyone holding it can read the object for as
 * long as it lasts, with no session. Baked into a statically rendered page it
 * would be served to whoever asked, and it would expire long before the page
 * did — leaking briefly and then rendering broken frames forever. The only
 * caller, /tarefas/[id], is `export const dynamic = 'force-dynamic'`; keep it
 * that way, and do not add a cached wrapper around this function.
 *
 * The expiry is minutes, not seconds: the manager scrolls, and an image that
 * 403s while they are still looking at the page is a bug they cannot explain.
 *
 * createSignedUrls runs on the RLS-scoped client, so the storage.objects
 * SELECT policy (0023) is what decides whether a URL can be minted at all — a
 * session from another company gets an error, not a working link. That is the
 * boundary; the company_id filter below is belt-and-braces on top of it.
 */
const SIGNED_URL_TTL_SECONDS = 300;

export async function loadTaskPhotos(
  { db, companyId }: AuthContext,
  taskId: string,
): Promise<TaskPhoto[]> {
  const { data: rows, error } = await db
    .from('task_photos')
    .select('id, storage_path, source, created_at')
    .eq('company_id', companyId)
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`task_photos read failed: ${error.message}`);
  if (!rows || rows.length === 0) return [];

  const { data: signed, error: signError } = await db.storage
    .from(TASK_PHOTO_BUCKET)
    .createSignedUrls(
      rows.map(r => r.storage_path),
      SIGNED_URL_TTL_SECONDS,
    );
  if (signError) throw new Error(`task_photos signing failed: ${signError.message}`);

  // Match on path, never by position: createSignedUrls reports per-object
  // failures inline (an `error` field and a null url) rather than throwing, so
  // one unsignable object would shift every later row onto the wrong image if
  // the two lists were zipped. Same rule the translation applier follows for
  // exactly the same reason (AGENTS.md).
  const urls = new Map((signed ?? []).map(s => [s.path, s.signedUrl]));

  return rows.flatMap(r => {
    const url = urls.get(r.storage_path);
    // A row whose object cannot be signed is dropped rather than rendered as a
    // broken frame the manager can neither open nor clear.
    if (!url) return [];
    return [{ id: r.id, url, source: r.source, createdAt: r.created_at }];
  });
}
