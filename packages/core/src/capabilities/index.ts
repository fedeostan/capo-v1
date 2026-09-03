import { tool, type ToolSet } from 'ai';
import type { z } from 'zod';
import { taskTools } from './tasks';
import { agendaTools } from './agenda';
import { jobTools } from './jobs';
import { workerTools } from './workers';
import { crewRequestTools } from './crew-requests';
import { memoryTools } from './memory';
import { knowledgeTools } from './knowledge';
import { languageTools } from './language';
import { translationTools } from './translate';
import { propose } from './propose';
import { generatePlan } from './plan';
import { rescheduleTools } from './reschedule-propose';
import { jobPauseTools } from './job-pause';
import { onboardingTools } from './onboarding';
// #123: reaching one crew member. Unguarded on purpose, see message-worker.ts.
import { crewMessageTools } from './message-worker';
import { managerInstructionField, runGuarded } from './guard';
import type { CapoTool, ToolContext } from './types';

// The roster: the seam where future capabilities plug in. An Execution Agent
// later is one more entry (a dispatch tool that spawns a background agent and
// reports via the sink) — same interface, no core changes. generate_plan is
// unguarded (like propose) — it never mutates domain state directly, it only
// ever produces a proposal (apply_plan) for the manager to approve.
// translate_company_data is the same shape for the same reason: its applier
// (apply_company_translation) is deliberately absent from this roster and lives
// only in propose.ts, so it is reachable exclusively through an approved card.
// reschedule_job is the third of that family — apply_reschedule is likewise
// absent here. pause_job (issue #95) is the fourth: apply_job_pause erases
// dates, which nothing in its payload could put back, so it lives only in
// propose.ts.
//
// crew_requests (issue #152's follow-up) is the one entry here that reads
// WORKER-AUTHORED text. It is a read, so it is unguarded like every other read,
// and the isolation rule it lives under is 0027's and 0043's: worker prose may
// be SHOWN to the manager as an attributed quote, and may never be WRITTEN into
// `messages`, which is the evidence pool runGuarded matches a manager's quote
// against. Nothing in that tool writes anywhere.
export const roster: CapoTool[] = [
  ...taskTools,
  ...agendaTools,
  ...jobTools,
  ...workerTools,
  ...crewRequestTools,
  ...memoryTools,
  ...knowledgeTools,
  ...languageTools,
  ...translationTools,
  ...rescheduleTools,
  ...jobPauseTools,
  ...crewMessageTools,
  propose,
  generatePlan,
  // Appended at the END, and it must stay there: the tool cache breakpoint
  // (agent/cache.ts) is placed on whatever tool is last, so an insertion in the
  // middle rewrites every tenant's cached tool prefix for nothing.
  ...onboardingTools,
];

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
