import { z } from 'zod';
import type { CapoTool, ToolContext } from './types';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('ISO date, YYYY-MM-DD');

const taskStatus = z.enum(['pending', 'in_progress', 'pending_review', 'blocked', 'done', 'cancelled']);

// update_task must NOT be an entry point into pending_review: that status is
// meaningful only alongside a task_reviews row, which only open_task_review
// creates, and every UI control keys off that row existing. Writing the status
// alone yields a task badged "a aguardar controlo" with no way to resolve it.
// Exits from pending_review stay allowed — tasks_supersede_review (0020)
// closes the stranded review when the task leaves.
const updatableTaskStatus = z.enum(['pending', 'in_progress', 'blocked', 'done', 'cancelled']);

const startDate = isoDate
  .optional()
  .describe(
    "When work begins. A task is active — and appears in the assigned worker's daily WhatsApp briefing — from start_date (or its creation date if unset) through due_date.",
  );

// ── TWO PEOPLE ON ONE TASK (issue #44) ──────────────────────────────────────
// The bug this closes: with only `assignee_worker_id`, the sole shape the model
// had for "o Miguel e o João fazem a pintura" was TWO tasks. Two board rows,
// two `materials` arrays, and therefore twice the material on /materiais and in
// materials_outlook — which is the complaint in Federico's own words.
//
// The description below is the fix, and it is aimed squarely at that instinct:
// the model must reach for this field instead of a second create_task. It says
// so in the imperative, because a rule the model has to infer is a rule it
// infers wrong under pressure.
const collaboratorIds = z
  .array(z.string().uuid())
  .max(20)
  .optional()
  .describe(
    'Other workers helping on this SAME task, besides the assignee. Use list_workers for ids. When several people work on one job, ALWAYS use one task with collaborators — NEVER create a second copy of the task, because the materials belong to the task and duplicating it duplicates the order. The assignee stays the person in charge; collaborators are told in their morning message that they are helping. Sending this REPLACES the whole list, so include everyone who should be on it; send an empty array to remove them all.',
  );

/**
 * Apply a collaborator list to a task that already exists.
 *
 * One RPC, never client-side inserts and deletes: "who is on this task" is a
 * SET, and a half-applied set — the new helper added, the old one not removed —
 * is a wrong WhatsApp message to a real person at 07:00 the next morning.
 * set_task_collaborators (0035) replaces the whole set in one transaction, drops
 * the lead if they were named, and is the only writer the table has.
 *
 * `undefined` means "not mentioned" and does nothing at all. That distinction is
 * load-bearing on update_task: an edit to a due date must not silently clear the
 * crew off a task. An empty ARRAY is the explicit "remove everybody".
 */
async function applyCollaborators(
  ctx: ToolContext,
  taskId: string,
  workerIds: string[] | undefined,
): Promise<void> {
  if (!workerIds) return;
  const { error } = await ctx.db.rpc('set_task_collaborators', {
    p_task: taskId,
    p_workers: workerIds,
  });
  // Thrown, never swallowed. The manager was told who would be on the job; if
  // only half of that landed they have to hear so, because the other half is a
  // person who will not get a briefing tomorrow.
  if (error) throw new Error(`set_task_collaborators failed: ${error.message}`);
}

export const createTaskInput = z.object({
  // Tool schemas are built once per process, not per request, so they cannot
  // name a concrete language — the Language policy block in the system prompt
  // carries the company dial. Same reasoning everywhere a stored field is
  // described.
  title: z
    .string()
    .min(1)
    .describe("Short task title, written in the company's domain language (see the Language policy in your instructions)."),
  description: z.string().optional(),
  job_id: z
    .string()
    .uuid()
    .optional()
    .describe('Job (obra) this task belongs to. Attach whenever possible — use list_jobs to find ids.'),
  assignee_worker_id: z
    .string()
    .uuid()
    .optional()
    .describe('Assigned worker — use list_workers to find ids.'),
  collaborator_worker_ids: collaboratorIds,
  start_date: startDate,
  due_date: isoDate.optional(),
  duration_days: z.number().int().positive().optional().describe('Estimated work duration in days.'),
  materials: z.array(z.string()).optional().describe('Materials needed for this task.'),
});

export const createTask: CapoTool<z.infer<typeof createTaskInput>> = {
  name: 'create_task',
  description:
    'Create a construction task (real site work, tied to a job when possible). Several people on the same job means ONE task with collaborator_worker_ids — never two tasks. This is a write: only call it directly for an explicit manager command; otherwise use propose.',
  inputSchema: createTaskInput,
  guarded: true,
  async execute(input, ctx) {
    const { data, error } = await ctx.db
      .from('tasks')
      .insert({
        company_id: ctx.companyId,
        title: input.title,
        description: input.description ?? null,
        job_id: input.job_id ?? null,
        assignee_worker_id: input.assignee_worker_id ?? null,
        start_date: input.start_date ?? null,
        due_date: input.due_date ?? null,
        duration_days: input.duration_days ?? null,
        materials: input.materials ?? null,
        source: ctx.actor,
      })
      .select()
      .single();
    if (error) throw new Error(`create_task failed: ${error.message}`);
    // After the insert, because the RPC needs a task id — and it is the row
    // that exists that matters. A failure here throws with the task already
    // created, which is the recoverable direction: a task with the wrong crew
    // is visible on the board and fixable in one sentence, whereas the reverse
    // ordering is not expressible at all.
    await applyCollaborators(ctx, data.id, input.collaborator_worker_ids);
    return { task: data };
  },
};

export const updateTaskInput = z.object({
  task_id: z.string().uuid().describe('Task to update — use list_tasks to find ids.'),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: updatableTaskStatus
    .optional()
    .describe("Cannot be set to 'pending_review' — that status only comes from a worker or manager filing a review claim, not a direct write."),
  job_id: z.string().uuid().optional(),
  assignee_worker_id: z.string().uuid().optional(),
  collaborator_worker_ids: collaboratorIds,
  start_date: startDate,
  due_date: isoDate.optional(),
  duration_days: z.number().int().positive().optional().describe('Estimated work duration in days.'),
  materials: z.array(z.string()).optional().describe('Materials needed for this task.'),
});

export const updateTask: CapoTool<z.infer<typeof updateTaskInput>> = {
  name: 'update_task',
  description:
    'Update an existing task (status, assignee, due date, title, who else is helping…). To put a second person on a job, add them to collaborator_worker_ids here — never create a copy of the task. This is a write: only call it directly for an explicit manager command; otherwise use propose.',
  inputSchema: updateTaskInput,
  guarded: true,
  async execute(input, ctx) {
    // collaborator_worker_ids is pulled OUT before the update: it is not a
    // column on `tasks` and would 42703 the whole write. It travels to the
    // join table through its own RPC (0035) instead.
    const { task_id, collaborator_worker_ids, ...fields } = input;

    // An update naming ONLY collaborators leaves `fields` empty, which is a
    // legitimate call ("põe o Zé também na pintura") and still worth writing —
    // the timestamp is what makes the board and every cached page refresh.
    const { data, error } = await ctx.db
      .from('tasks')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', task_id)
      .eq('company_id', ctx.companyId)
      .select()
      .single();
    if (error) throw new Error(`update_task failed: ${error.message}`);
    // AFTER the task update, so a reassignment in the same call has already
    // landed by the time the RPC reads `assignee_worker_id` to decide who the
    // lead is. Reversing these two would let "o João passa a responsável e o
    // Miguel ajuda" leave the old lead listed as their own helper.
    await applyCollaborators(ctx, task_id, collaborator_worker_ids);
    return { task: data };
  },
};

export const listTasksInput = z.object({
  job_id: z.string().uuid().optional(),
  assignee_worker_id: z.string().uuid().optional(),
  status: taskStatus.optional(),
  due_from: isoDate.optional().describe('Only tasks with due_date on or after this date.'),
  due_until: isoDate.optional().describe('Only tasks with due_date on or before this date.'),
  include_done: z
    .boolean()
    .optional()
    .describe('Include done/cancelled tasks. Defaults to false — normally the manager is asking about open work.'),
});

export const listTasks: CapoTool<z.infer<typeof listTasksInput>> = {
  name: 'list_tasks',
  description:
    'List tasks (including duration_days, materials, and dependencies), optionally filtered by job, worker, status, or due-date range. Read-only. For "what is on today/tomorrow/overdue" use the `agenda` tool instead — it matches the screens the manager is looking at.',
  inputSchema: listTasksInput,
  async execute(input, ctx) {
    let query = ctx.db
      .from('tasks')
      .select('*, job:jobs(name), assignee:workers(name)')
      .eq('company_id', ctx.companyId)
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(100);
    if (input.job_id) query = query.eq('job_id', input.job_id);
    if (input.assignee_worker_id) query = query.eq('assignee_worker_id', input.assignee_worker_id);
    if (input.status) query = query.eq('status', input.status);
    if (input.due_from) query = query.gte('due_date', input.due_from);
    if (input.due_until) query = query.lte('due_date', input.due_until);
    // Closed work is noise unless asked for; an explicit `status` filter always
    // wins, so "list the done ones" still works without include_done.
    if (!input.include_done && !input.status) query = query.not('status', 'in', '("done","cancelled")');
    const { data, error } = await query;
    if (error) throw new Error(`list_tasks failed: ${error.message}`);

    // task_dependencies has two FKs into tasks (self-referencing), which
    // makes PostgREST embedding ambiguous — a plain follow-up query is
    // simpler and unambiguous than an FK-hinted embed.
    const taskIds = (data ?? []).map(t => t.id);
    const dependenciesByTask: Record<string, string[]> = {};
    if (taskIds.length > 0) {
      const { data: deps } = await ctx.db.from('task_dependencies').select('task_id, depends_on_task_id').in('task_id', taskIds);
      for (const d of deps ?? []) {
        (dependenciesByTask[d.task_id] ??= []).push(d.depends_on_task_id);
      }
    }
    const tasks = (data ?? []).map(t => ({ ...t, depends_on_task_ids: dependenciesByTask[t.id] ?? [] }));
    return { tasks };
  },
};

export const taskTools = [createTask, updateTask, listTasks];
