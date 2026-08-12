import { z } from 'zod';
import type { Db } from '@capo/db/client';
import type { WorkerTool } from './types';

// "What am I supposed to be doing?" — the worker's half of the Tarefas board.
//
// Explicitly NOT `list_tasks` (../tasks.ts) and NOT `agenda` (../agenda.ts).
// Both of those are scoped by companyId alone, which is the MANAGER's boundary:
// correct for someone who is responsible for the whole company, wrong for a
// person who should see their own work and nothing else. Reusing either would
// have been one line and would have handed every worker the entire board.
//
// Reads `task_board` like everything else that answers "what is on today", so
// the worker, the manager's screen and Capo cannot disagree about which tasks
// are live (AGENTS.md: one clock, one definition of today).

/**
 * One task as a worker may see it.
 *
 * The absences are the design. `task_board` exposes no `jobs.client_name` at
 * all (0013:36-37 selects only name and status from jobs), so the manager's
 * commercial picture is structurally out of reach here rather than filtered
 * out — there is nothing to filter. `job_address` was APPENDED to the view by
 * 0027 precisely because "which site" is the first thing a worker needs and the
 * only jobs column worth widening for.
 */
export interface WorkerTaskRow {
  id: string;
  title: string | null;
  description: string | null;
  status: string | null;
  start_date: string | null;
  due_date: string | null;
  materials: string[] | null;
  job_name: string | null;
  /** Optional on purpose: undefined on a deploy that landed before 0027. */
  job_address?: string | null;
  depends_on_titles: string[] | null;
  overdue: boolean | null;
  active_today: boolean | null;
}

// A crew member with more open tasks than this is a data problem, not a
// workload — and an unbounded select on a webhook path is how one tenant's bad
// data becomes everybody's timeout. It also bounds the system prompt, which
// embeds this list verbatim.
const MAX_WORKER_TASKS = 40;

/**
 * Every OPEN task assigned to this worker, in this company.
 *
 * Three filters, and only the first two are the boundary:
 *   .eq('company_id')          — phone-derived, never from input
 *   .eq('assignee_worker_id')  — phone-derived, never from input
 *   .eq('is_open', true)       — a courtesy; finished work is not a to-do list
 *
 * `is_open` is task_board's DENYLIST (`status not in ('done','cancelled')`), so
 * a task already declared finished and awaiting the manager — `pending_review`
 * — is still returned here. That is deliberate and matches the board: the
 * worker sees that it is waiting on someone, rather than seeing it vanish and
 * concluding Capo lost it.
 *
 * `select('*')`, not a column list, because 0027 appends `job_address` to this
 * view and AGENTS.md requires a reader to degrade rather than 42703 when a
 * deploy lands ahead of its migration.
 */
export async function loadWorkerTasks(db: Db, companyId: string, workerId: string): Promise<WorkerTaskRow[]> {
  const { data, error } = await db
    .from('task_board')
    .select('*')
    .eq('company_id', companyId)
    .eq('assignee_worker_id', workerId)
    .eq('is_open', true)
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(MAX_WORKER_TASKS);
  if (error) throw new Error(`worker task_board read failed: ${error.message}`);
  // Every column of a view is nullable in the generated types, `id` included. A
  // row without an id cannot be referenced by any tool, so it is dropped here
  // rather than making every consumer re-narrow — and the projection is written
  // out by hand so that adding a column to the view never silently widens what
  // a worker is shown.
  return (data ?? [])
    .filter(row => typeof row.id === 'string')
    .map(row => ({
      id: row.id as string,
      title: row.title,
      description: row.description,
      status: row.status,
      start_date: row.start_date,
      due_date: row.due_date,
      materials: row.materials,
      job_name: row.job_name,
      // `undefined` at runtime on a deploy that landed before 0027 appended it,
      // even though the generated types say the column exists. That is exactly
      // the degradation AGENTS.md's select('*') rule buys, and why this field is
      // optional on WorkerTaskRow.
      job_address: row.job_address,
      depends_on_titles: row.depends_on_titles,
      overdue: row.overdue,
      active_today: row.active_today,
    }));
}

/** Model-facing shape. Ids are included because `declare_task_done` needs one. */
export function toWorkerTaskView(row: WorkerTaskRow) {
  return {
    task_id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    obra: row.job_name,
    // Reported as null rather than omitted when the view predates 0027, so the
    // model says "não tenho a morada" instead of inventing one.
    morada: row.job_address ?? null,
    start_date: row.start_date,
    due_date: row.due_date,
    overdue: row.overdue ?? false,
    today: row.active_today ?? false,
    materials: row.materials ?? [],
    waiting_on: row.depends_on_titles ?? [],
  };
}

export const myTasksInput = z.object({});

export const myTasks: WorkerTool<z.infer<typeof myTasksInput>> = {
  audience: 'worker',
  name: 'my_tasks',
  description:
    "The tasks assigned to THIS crew member that are still open, with their obra, site address, dates, materials and what they are waiting on. This is the only way to see any task, and it can only ever return this person's own. Read-only. Use it before answering anything about what they have to do, and to find the task_id that declare_task_done needs.",
  inputSchema: myTasksInput,
  execute: async (_input, ctx) => {
    const rows = await loadWorkerTasks(ctx.db, ctx.companyId, ctx.workerId);
    return { total: rows.length, tasks: rows.map(toWorkerTaskView) };
  },
};
