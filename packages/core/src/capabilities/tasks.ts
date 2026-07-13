import { z } from 'zod';
import type { CapoTool } from './types';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('ISO date, YYYY-MM-DD');

const taskStatus = z.enum(['pending', 'in_progress', 'blocked', 'done', 'cancelled']);

const startDate = isoDate
  .optional()
  .describe(
    'When work begins. A task is active — and appears in the assigned worker\'s daily SMS briefing — from start_date (or its creation date if unset) through due_date.',
  );

export const createTaskInput = z.object({
  title: z.string().min(1).describe('Short task title, in European Portuguese'),
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
  start_date: startDate,
  due_date: isoDate.optional(),
  duration_days: z.number().int().positive().optional().describe('Estimated work duration in days.'),
  materials: z.array(z.string()).optional().describe('Materials needed for this task.'),
});

export const createTask: CapoTool<z.infer<typeof createTaskInput>> = {
  name: 'create_task',
  description:
    'Create a construction task (real site work, tied to a job when possible). This is a write: only call it directly for an explicit manager command; otherwise use propose.',
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
    return { task: data };
  },
};

export const updateTaskInput = z.object({
  task_id: z.string().uuid().describe('Task to update — use list_tasks to find ids.'),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: taskStatus.optional(),
  job_id: z.string().uuid().optional(),
  assignee_worker_id: z.string().uuid().optional(),
  start_date: startDate,
  due_date: isoDate.optional(),
  duration_days: z.number().int().positive().optional().describe('Estimated work duration in days.'),
  materials: z.array(z.string()).optional().describe('Materials needed for this task.'),
});

export const updateTask: CapoTool<z.infer<typeof updateTaskInput>> = {
  name: 'update_task',
  description:
    'Update an existing task (status, assignee, due date, title…). This is a write: only call it directly for an explicit manager command; otherwise use propose.',
  inputSchema: updateTaskInput,
  guarded: true,
  async execute(input, ctx) {
    const { task_id, ...fields } = input;
    const { data, error } = await ctx.db
      .from('tasks')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', task_id)
      .eq('company_id', ctx.companyId)
      .select()
      .single();
    if (error) throw new Error(`update_task failed: ${error.message}`);
    return { task: data };
  },
};

export const listTasksInput = z.object({
  job_id: z.string().uuid().optional(),
  assignee_worker_id: z.string().uuid().optional(),
  status: taskStatus.optional(),
});

export const listTasks: CapoTool<z.infer<typeof listTasksInput>> = {
  name: 'list_tasks',
  description: 'List tasks (including duration_days, materials, and dependencies), optionally filtered by job, worker, or status. Read-only.',
  inputSchema: listTasksInput,
  async execute(input, ctx) {
    let query = ctx.db
      .from('tasks')
      .select('*, job:jobs(name), assignee:workers(name)')
      .eq('company_id', ctx.companyId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (input.job_id) query = query.eq('job_id', input.job_id);
    if (input.assignee_worker_id) query = query.eq('assignee_worker_id', input.assignee_worker_id);
    if (input.status) query = query.eq('status', input.status);
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
