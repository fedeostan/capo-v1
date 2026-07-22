import { tool, type ToolSet } from 'ai';
import type { z } from 'zod';
import { taskTools } from './tasks';
import { jobTools } from './jobs';
import { workerTools } from './workers';
import { memoryTools } from './memory';
import { knowledgeTools } from './knowledge';
import { propose } from './propose';
import { generatePlan } from './plan';
import { managerInstructionField, runGuarded } from './guard';
import type { CapoTool, ToolContext } from './types';

// The roster: the seam where future capabilities plug in. An Execution Agent
// later is one more entry (a dispatch tool that spawns a background agent and
// reports via the sink) — same interface, no core changes. generate_plan is
// unguarded (like propose) — it never mutates domain state directly, it only
// ever produces a proposal (apply_plan) for the manager to approve.
export const roster: CapoTool[] = [...taskTools, ...jobTools, ...workerTools, ...memoryTools, ...knowledgeTools, propose, generatePlan];

// Mechanical mapping from the roster to AI SDK tools. Guarded writes get the
// manager_instruction evidence field and run through the guard.
export function toAiTools(ctx: ToolContext): ToolSet {
  return Object.fromEntries(
    roster.map(t => [
      t.name,
      tool({
        description: t.description,
        inputSchema: t.guarded
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? (t.inputSchema as unknown as z.ZodObject<any>).extend(managerInstructionField)
          : t.inputSchema,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (input: any) => (t.guarded ? runGuarded(t, input, ctx) : t.execute(input, ctx)),
      }),
    ]),
  ) as ToolSet;
}
