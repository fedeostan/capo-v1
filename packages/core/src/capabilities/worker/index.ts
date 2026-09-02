import { tool, type ToolSet } from 'ai';
import { myTasks } from './tasks';
import { workerSearchKnowledge } from './knowledge';
import { declareTaskDone } from './complete';
import { setMyLanguage } from './language';
import { askManager } from './request';
import type { WorkerContext, WorkerTool } from './types';

// The worker roster: five tools, and everything else is absent rather than
// forbidden.
//
// ── WHY THIS IS AN ARRAY AND NOT A FILTER ──────────────────────────────────
// The obvious implementation is `roster.filter(t => WORKER_SAFE.has(t.name))`.
// It is one line, it reads as a restriction, and it is a DENYLIST BY ACCIDENT:
// ../index.ts is an array that grows — it currently spreads nine tool modules
// plus `propose` and `generatePlan` — and the next capability appended there
// would land in a worker's hands the moment someone forgot to update the set.
// The failure would be silent, would arrive in a commit about something else,
// and would be a privilege escalation.
//
// A separate array in a separate file inverts the default. Nothing reaches a
// worker unless a person writes its name here, on purpose, in a diff that is
// obviously about the worker agent. The `deliberately absent` table in the PRD
// exists only for tools whose absence someone might mistake for an oversight —
// it is NOT a denylist and must never become one.
//
// The type system enforces what the file layout suggests: `WorkerTool` requires
// `audience: 'worker'` and an `execute` taking a `WorkerContext`, and
// `WorkerContext` and `ToolContext` are mutually unassignable. Putting a
// `CapoTool` in this array is a `tsc --noEmit` failure, not a review comment.
//
// `askManager` (issue #152) is the first addition since the roster was written,
// and it is the case the paragraph above was written for: it arrived because
// somebody chose to add it here, in a diff about the crew agent, rather than by
// appearing for free in a commit about a manager capability.
export const workerRoster: WorkerTool[] = [
  myTasks,
  workerSearchKnowledge,
  declareTaskDone,
  setMyLanguage,
  askManager,
];

// Mechanical mapping to AI SDK tools — and note what is NOT here, against
// ../index.ts:toAiTools. There is no `managerInstructionField` extension and no
// `runGuarded` branch, because `WorkerTool` has no `guarded` field to test.
// The guard authorizes a direct write by matching the model's quote against the
// MANAGER's own recent messages; there is no manager in this loop, so the
// concept is not merely unused here, it is unrepresentable.
export function toWorkerAiTools(ctx: WorkerContext): ToolSet {
  return Object.fromEntries(
    workerRoster.map(t => [
      t.name,
      tool({
        description: t.description,
        inputSchema: t.inputSchema,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (input: any) => t.execute(input, ctx),
      }),
    ]),
  ) as ToolSet;
}

export type { WorkerContext, WorkerTool, PendingPhoto } from './types';
export { loadWorkerTasks, toWorkerTaskView } from './tasks';
// The ROW shape, exported for the web app's guided menu (issue #49), which
// renders it into a crew member's own copy catalog. Deliberately the row and
// not `toWorkerTaskView`'s output: that projection is MODEL-FACING and its
// field names are part of a prompt, so a renderer reading it would couple the
// two and a prompt tweak would silently change what a worker sees on WhatsApp.
export type { WorkerTaskRow } from './tasks';
// The crew-request date guard (issue #152), exported for `pnpm whatsapp-check`
// — pure, `now` injected, and the only automated coverage the fifth tool will
// ever get. The band it enforces catches the one date mistake with no symptom:
// "amanhã" computed into the wrong year files as "later" and never surfaces.
export { neededByIsSane, REQUEST_TEXT_MAX } from './request';
