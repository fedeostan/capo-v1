import { z } from 'zod';
import type { CapoTool } from './types';

// Split out of plan.ts so propose.ts can import the proposable tool without
// pulling in plan.ts (which imports createProposal from propose.ts) — that
// would be an import cycle.

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('ISO date, YYYY-MM-DD');

const planTaskInput = z.object({
  key: z.string().min(1).describe('Unique id for this task within the plan — used to resolve depends_on.'),
  title: z.string().min(1),
  description: z.string().optional(),
  trade: z.string().optional().describe('Trade/ofício — informational only, not stored on the task.'),
  start_date: isoDate,
  due_date: isoDate,
  duration_days: z.number().int().positive(),
  materials: z.array(z.string()).optional(),
  assignee_worker_id: z.string().uuid().optional(),
  depends_on: z.array(z.string()).optional().describe('Keys of sibling tasks in this plan that must finish first.'),
});

export const applyPlanInput = z.object({
  job_id: z.string().uuid().describe('Job (obra) this plan belongs to.'),
  tasks: z.array(planTaskInput).min(1).max(25),
});

// Deterministic execution of an approved plan: what the manager approved
// (the stored, already-dated tasks) is exactly what gets inserted — no model
// in the loop. Not atomic across tasks (documented in the plan): a mid-way
// insert failure leaves earlier tasks in place, visible/cancellable via chat,
// and resolveProposal marks the proposal 'failed'.
export const applyPlan: CapoTool<z.infer<typeof applyPlanInput>> = {
  name: 'apply_plan',
  description:
    'Apply an already-generated, already-dated day-by-day plan: creates every task and its dependency edges for a job. Only ever runs via an approved proposal — never call this directly.',
  inputSchema: applyPlanInput,
  guarded: true,
  async execute(input, ctx) {
    const keyToId = new Map<string, string>();
    const insertedTasks: unknown[] = [];

    for (const t of input.tasks) {
      const { data, error } = await ctx.db
        .from('tasks')
        .insert({
          company_id: ctx.companyId,
          job_id: input.job_id,
          title: t.title,
          description: t.description ?? null,
          assignee_worker_id: t.assignee_worker_id ?? null,
          start_date: t.start_date,
          due_date: t.due_date,
          duration_days: t.duration_days,
          materials: t.materials ?? null,
          source: ctx.actor,
        })
        .select()
        .single();
      if (error) throw new Error(`apply_plan failed inserting task "${t.title}": ${error.message}`);
      keyToId.set(t.key, data.id);
      insertedTasks.push(data);
    }

    for (const t of input.tasks) {
      if (!t.depends_on?.length) continue;
      const taskId = keyToId.get(t.key);
      if (!taskId) continue;
      for (const depKey of t.depends_on) {
        const depId = keyToId.get(depKey);
        if (!depId) throw new Error(`apply_plan: unknown depends_on key "${depKey}" for task "${t.title}"`);
        const { error } = await ctx.db.from('task_dependencies').insert({ task_id: taskId, depends_on_task_id: depId });
        if (error) throw new Error(`apply_plan failed inserting dependency for "${t.title}": ${error.message}`);
      }
    }

    return { tasks: insertedTasks };
  },
};

export const planApplyTools = [applyPlan];
