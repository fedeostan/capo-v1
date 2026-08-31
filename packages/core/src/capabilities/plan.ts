import { z } from 'zod';
import { generateObject } from 'ai';
import { getModel } from '../agent/models';
import { managerOrSystem } from '../agent/usage';
import { embedQuery } from '../agent/embeddings';
import { buildPlannerPrompt } from '../agent/prompts/planner';
import { createProposal } from './propose';
import { addWorkdays, nextWorkday, workdayAfter } from './workdays';
import type { CapoTool } from './types';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('ISO date, YYYY-MM-DD');

export const generatePlanInput = z.object({
  job_id: z.string().uuid().describe('Job (obra) to plan — use list_jobs to find ids. Must already exist.'),
  source_text: z.string().min(1).describe("The manager's quote/scope text, verbatim."),
  start_date: isoDate.describe('Confirmed start date for the plan.'),
  notes: z.string().optional().describe('Extra constraints the manager mentioned (crew size, deadline, etc.).'),
});

// The model's output: a task DAG with relative durations, no dates yet — the
// scheduler below turns this into concrete start/due dates.
const relativePlanTaskSchema = z.object({
  key: z.string().min(1).describe('Short unique id for this task within the plan, e.g. "t1".'),
  title: z.string().min(1),
  description: z.string().optional(),
  trade: z.string().optional(),
  duration_days: z.number().int().positive().max(30),
  materials: z.array(z.string()).optional(),
  assignee_worker_id: z.string().uuid().optional(),
  depends_on: z.array(z.string()).optional().describe('Keys of sibling tasks that must finish first.'),
});

const relativePlanSchema = z
  .object({ tasks: z.array(relativePlanTaskSchema).min(1).max(30) })
  .superRefine((plan, ctx) => {
    const keys = new Set(plan.tasks.map(t => t.key));
    if (keys.size !== plan.tasks.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate task keys' });
      return;
    }
    for (const t of plan.tasks) {
      for (const dep of t.depends_on ?? []) {
        if (!keys.has(dep)) {
          ctx.addIssue({ code: 'custom', message: `Unknown depends_on key "${dep}" in task "${t.key}"` });
        }
      }
    }
    // Cycle detection via DFS — a plan whose dependency graph isn't a DAG
    // cannot be scheduled.
    const byKey = new Map(plan.tasks.map(t => [t.key, t]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    function visit(key: string): boolean {
      if (visited.has(key)) return true;
      if (visiting.has(key)) return false;
      visiting.add(key);
      for (const dep of byKey.get(key)?.depends_on ?? []) {
        if (!visit(dep)) return false;
      }
      visiting.delete(key);
      visited.add(key);
      return true;
    }
    for (const t of plan.tasks) {
      if (!visit(t.key)) {
        ctx.addIssue({ code: 'custom', message: `Dependency cycle involving task "${t.key}"` });
        break;
      }
    }
  });

type RelativePlanTask = z.infer<typeof relativePlanTaskSchema>;

// Deterministic day-by-day scheduler: topological order over the dependency
// graph, then each task starts the workday after its latest dependency ends
// (or the plan start date for a root task).
//
// Durations are counted in WORKING days, not calendar days (see ./workdays):
// a 5-day task starting Thursday runs Thu–Wed, not Thu–Mon. Weekends and
// Portuguese national holidays are skipped for both the start and the span.
// Exported (not because anything else calls it, but) so scripts/scheduler-check.mts
// can assert on it directly: it is pure, it is the piece most likely to break
// silently, and it is the only part of the planner verifiable without an API key.
export function scheduleTasks(
  tasks: RelativePlanTask[],
  startDate: string,
): (RelativePlanTask & { start_date: string; due_date: string })[] {
  const byKey = new Map(tasks.map(t => [t.key, t]));
  const scheduled = new Map<string, RelativePlanTask & { start_date: string; due_date: string }>();
  const order: string[] = [];
  const visiting = new Set<string>();

  function visit(key: string) {
    if (scheduled.has(key) || order.includes(key) || visiting.has(key)) return;
    visiting.add(key);
    for (const dep of byKey.get(key)?.depends_on ?? []) visit(dep);
    visiting.delete(key);
    order.push(key);
  }
  for (const t of tasks) visit(t.key);

  for (const key of order) {
    const t = byKey.get(key);
    if (!t) continue;
    let earliestStart = startDate;
    for (const dep of t.depends_on ?? []) {
      const depTask = scheduled.get(dep);
      if (depTask) {
        const dayAfter = workdayAfter(depTask.due_date);
        if (dayAfter > earliestStart) earliestStart = dayAfter;
      }
    }
    const start = nextWorkday(earliestStart);
    const due = addWorkdays(start, t.duration_days);
    scheduled.set(key, { ...t, start_date: start, due_date: due });
  }

  return tasks.map(t => scheduled.get(t.key)).filter((t): t is NonNullable<typeof t> => t != null);
}

export const generatePlan: CapoTool<z.infer<typeof generatePlanInput>> = {
  name: 'generate_plan',
  description:
    'Generate a day-by-day construction plan (tasks, dependencies, materials, dates) from a quote/scope description, and propose it for approval. The job must already exist and the start date must be confirmed with the manager first.',
  inputSchema: generatePlanInput,
  async execute(input, ctx) {
    const { data: job, error: jobError } = await ctx.db
      .from('jobs')
      .select('id, name')
      .eq('id', input.job_id)
      .eq('company_id', ctx.companyId)
      .maybeSingle();
    // Error strings here are returned TO THE MODEL, which relays them to the
    // manager in his own language — so they are English, like the rest of the
    // model-facing surface.
    if (jobError || !job) {
      return { status: 'error' as const, message: `Job not found (${input.job_id})` };
    }

    const { data: workers } = await ctx.db
      .from('workers')
      .select('id, name, trade')
      .eq('company_id', ctx.companyId)
      .eq('active', true);
    const workerList =
      (workers ?? []).map(w => `- ${w.id}: ${w.name}${w.trade ? ` (${w.trade})` : ''}`).join('\n') ||
      '(no workers on record)';

    // Ground the planner in the shared knowledge base (techniques, sequencing,
    // materials). Best-effort: an empty corpus or a retrieval hiccup must
    // never block plan generation — the planner worked without it before.
    let knowledgeBlock: string | null = null;
    try {
      const queryEmbedding = await embedQuery(input.source_text.slice(0, 2000));
      const { data: chunks } = await ctx.db.rpc('search_knowledge', {
        query_embedding: JSON.stringify(queryEmbedding),
        query_text: input.source_text.slice(0, 500),
        match_count: 4,
      });
      if (chunks && chunks.length > 0) {
        knowledgeBlock = chunks
          .map(c => `### ${c.document_title}${c.heading_path ? ` — ${c.heading_path}` : ''}\n${c.content}`)
          .join('\n\n');
      }
    } catch {
      // planner proceeds without knowledge
    }

    let relativePlan: z.infer<typeof relativePlanSchema>;
    try {
      const result = await generateObject({
        // Billed to the manager who asked for the plan (issue #53). Generating
        // a plan is the single most expensive model call in the product, so it
        // gets its own surface rather than folding into manager_chat.
        model: getModel('planner', {
          db: ctx.db,
          companyId: ctx.companyId,
          surface: 'planner',
          // ToolContext.userId is nullable — it is null when a tool runs from
          // an APPROVED PROPOSAL, where there is no live user. `generate_plan`
          // is a roster tool and always has one today, but inventing a profile
          // id to satisfy the type would put a fabricated name on a bill.
          actor: managerOrSystem(ctx.userId),
        }),
        schema: relativePlanSchema,
        // The COMPANY dial: plan task titles become stored rows on the shared
        // dashboard, not speech to this manager.
        system: buildPlannerPrompt(ctx.locales.company),
        prompt: [
          `## Quote / scope text (verbatim from the manager)\n${input.source_text}`,
          `## Available workers (id: name (trade))\n${workerList}`,
          input.notes ? `## Additional notes\n${input.notes}` : null,
          knowledgeBlock ? `## Relevant technical knowledge (from the knowledge base)\n${knowledgeBlock}` : null,
          'Generate the plan.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      });
      relativePlan = result.object;
    } catch (e) {
      return { status: 'error' as const, message: `Failed to generate the plan: ${e instanceof Error ? e.message : String(e)}` };
    }

    const scheduled = scheduleTasks(relativePlan.tasks, input.start_date);

    try {
      const created = await createProposal(ctx, 'apply_plan', {
        job_id: input.job_id,
        tasks: scheduled,
      });
      if (created.status === 'already_pending') return created;
      return { status: 'proposed' as const, proposalId: created.proposalId, renderedText: created.renderedText };
    } catch (e) {
      return { status: 'error' as const, message: e instanceof Error ? e.message : String(e) };
    }
  },
};
