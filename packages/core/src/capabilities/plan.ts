import { z } from 'zod';
import { generateObject } from 'ai';
import { getModel } from '../agent/models';
import { embedQuery } from '../agent/embeddings';
import plannerPrompt from '../agent/prompts/planner';
import { createProposal } from './propose';
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
  .object({ tasks: z.array(relativePlanTaskSchema).min(1).max(20) })
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

function isWeekend(iso: string): boolean {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nextWorkday(iso: string): string {
  let d = iso;
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
}

// Deterministic day-by-day scheduler: topological order over the dependency
// graph, then each task starts the workday after its latest dependency ends
// (or the plan start date for a root task), skipping Sat/Sun for start_date.
function scheduleTasks(tasks: RelativePlanTask[], startDate: string): (RelativePlanTask & { start_date: string; due_date: string })[] {
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
        const dayAfter = addDays(depTask.due_date, 1);
        if (dayAfter > earliestStart) earliestStart = dayAfter;
      }
    }
    const start = nextWorkday(earliestStart);
    const due = addDays(start, t.duration_days - 1);
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
    if (jobError || !job) {
      return { status: 'error' as const, message: `Obra não encontrada (${input.job_id})` };
    }

    const { data: workers } = await ctx.db
      .from('workers')
      .select('id, name, trade')
      .eq('company_id', ctx.companyId)
      .eq('active', true);
    const workerList =
      (workers ?? []).map(w => `- ${w.id}: ${w.name}${w.trade ? ` (${w.trade})` : ''}`).join('\n') ||
      '(sem trabalhadores registados)';

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
        model: getModel('planner'),
        schema: relativePlanSchema,
        system: plannerPrompt,
        prompt: [
          `## Texto do orçamento/âmbito (verbatim do gerente)\n${input.source_text}`,
          `## Trabalhadores disponíveis (id: nome (ofício))\n${workerList}`,
          input.notes ? `## Notas adicionais\n${input.notes}` : null,
          knowledgeBlock ? `## Conhecimento técnico relevante (da base de conhecimento)\n${knowledgeBlock}` : null,
          'Gera o plano.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      });
      relativePlan = result.object;
    } catch (e) {
      return { status: 'error' as const, message: `Falha a gerar o plano: ${e instanceof Error ? e.message : String(e)}` };
    }

    const scheduled = scheduleTasks(relativePlan.tasks, input.start_date);

    try {
      const { proposalId, renderedText } = await createProposal(ctx, 'apply_plan', {
        job_id: input.job_id,
        tasks: scheduled,
      });
      return { status: 'proposed' as const, proposalId, renderedText };
    } catch (e) {
      return { status: 'error' as const, message: e instanceof Error ? e.message : String(e) };
    }
  },
};
