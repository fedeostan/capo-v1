import type { Db } from '@capo/db/client';
import type { DependencyEdge, ExistingTask, ExistingTaskStatus } from './reschedule';

// The DB half of the cascade, kept out of reschedule.ts so the pure core stays
// runnable by scripts/scheduler-check.mts with no credentials and no network.
//
// Taking a `Db` rather than a ToolContext means one loader serves both callers:
// the RLS-scoped user client behind a web server action, and the service client
// on the worker/WhatsApp path.

const STATUSES: readonly ExistingTaskStatus[] = [
  'pending',
  'in_progress',
  'blocked',
  'pending_review',
  'done',
  'cancelled',
];

// A status the DB carries but this build has never heard of must not be
// silently treated as open work — 'blocked' is the conservative reading: it
// constrains successors like an unfinished task and is never itself moved,
// because the caller only ever marks known-open statuses movable.
function coerceStatus(raw: string): ExistingTaskStatus {
  return (STATUSES as readonly string[]).includes(raw) ? (raw as ExistingTaskStatus) : 'blocked';
}

const TASK_COLUMNS = 'id, status, start_date, due_date, duration_days';

// A job with more tasks than this is not a job, it is a data problem — and an
// unbounded select on the request path is how one tenant's bad data becomes
// everybody's timeout.
const MAX_JOB_TASKS = 500;

export interface JobSchedule {
  /** From lisbon_today() — one clock, the same one task_board reads. */
  today: string;
  /**
   * Every task in the job, PLUS one hop of predecessors that live outside it.
   * Those outsiders carry `depends_on_task_ids: []`: their own edges were not
   * loaded and are not needed, because a task outside the job is never movable
   * and therefore contributes its stored due date as a fixed constraint.
   */
  tasks: ExistingTask[];
  /** Edges whose dependent is in this job. Used for the dependents closure. */
  edges: DependencyEdge[];
  /**
   * The subset of `tasks` that actually belongs to this job — the only ids a
   * cascade may ever write. Carried here rather than re-derived by the caller,
   * because "which of these are outsiders" is knowledge only the loader has.
   */
  jobTaskIds: Set<string>;
}

/**
 * Load everything needed to recompute one job's schedule.
 *
 * Reads the BASE tables, not `task_board`. AGENTS.md binds the view to "what
 * is on today / tomorrow / overdue / at risk"; raw dates and statuses for a
 * graph recompute are a different question, and the view's lisbon_today()
 * window would silently drop exactly the future rows a cascade exists to move.
 * The translation collector sets the same precedent. `today` still comes from
 * lisbon_today(), because there is only ever one clock.
 */
export async function loadJobSchedule(db: Db, companyId: string, jobId: string): Promise<JobSchedule> {
  const { data: today, error: todayError } = await db.rpc('lisbon_today');
  if (todayError || !today) {
    throw new Error(`loadJobSchedule: lisbon_today failed: ${todayError?.message ?? 'no value'}`);
  }

  const { data: jobRows, error: jobError } = await db
    .from('tasks')
    .select(TASK_COLUMNS)
    .eq('company_id', companyId)
    .eq('job_id', jobId)
    .limit(MAX_JOB_TASKS);
  if (jobError) throw new Error(`loadJobSchedule: tasks failed: ${jobError.message}`);

  const jobIds = (jobRows ?? []).map(row => row.id);
  if (jobIds.length === 0) return { today, tasks: [], edges: [], jobTaskIds: new Set() };

  // task_dependencies has two FKs into tasks, which makes PostgREST embedding
  // ambiguous — same plain follow-up query as list_tasks (tasks.ts:150-160).
  const { data: edgeRows, error: edgeError } = await db
    .from('task_dependencies')
    .select('task_id, depends_on_task_id')
    .in('task_id', jobIds);
  if (edgeError) throw new Error(`loadJobSchedule: task_dependencies failed: ${edgeError.message}`);
  const edges: DependencyEdge[] = edgeRows ?? [];

  // task_dependencies only requires both ends be same-COMPANY (0007:127-140),
  // never same-job. A cross-job predecessor left unloaded would silently become
  // a MISSING constraint — the cascade would happily pull work in front of
  // something it is actually waiting for. One hop is enough: an outside
  // predecessor is immovable, so its own predecessors cannot change its dates.
  const known = new Set(jobIds);
  const outsideIds = [...new Set(edges.map(e => e.depends_on_task_id).filter(id => !known.has(id)))];
  let outsideRows: typeof jobRows = [];
  if (outsideIds.length > 0) {
    const { data, error } = await db
      .from('tasks')
      .select(TASK_COLUMNS)
      .eq('company_id', companyId)
      .in('id', outsideIds);
    if (error) throw new Error(`loadJobSchedule: cross-job predecessors failed: ${error.message}`);
    outsideRows = data ?? [];
  }

  const dependsOn = new Map<string, string[]>();
  for (const edge of edges) {
    const list = dependsOn.get(edge.task_id);
    if (list) list.push(edge.depends_on_task_id);
    else dependsOn.set(edge.task_id, [edge.depends_on_task_id]);
  }

  const toTask = (row: { id: string; status: string; start_date: string | null; due_date: string | null; duration_days: number | null }): ExistingTask => ({
    id: row.id,
    status: coerceStatus(row.status),
    start_date: row.start_date,
    due_date: row.due_date,
    duration_days: row.duration_days,
    depends_on_task_ids: dependsOn.get(row.id) ?? [],
  });

  return {
    today,
    tasks: [...(jobRows ?? []).map(toTask), ...outsideRows.map(toTask)],
    edges,
    jobTaskIds: known,
  };
}
