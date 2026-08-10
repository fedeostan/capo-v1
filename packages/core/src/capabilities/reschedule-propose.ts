import { z } from 'zod';
import type { Db } from '@capo/db/client';
import type { Locale } from '@capo/i18n/locale';
import { createProposalForCompany } from './propose';
import { loadJobSchedule } from './reschedule-load';
import { dependentsClosure, recomputeSchedule, RescheduleError } from './reschedule';
import { workdayDelta } from './workdays';
import type { CapoTool } from './types';

// The orchestration seam: load → recompute → propose. Kept out of both
// reschedule.ts (which must stay pure for scheduler-check) and
// reschedule-apply.ts (which propose.ts imports, so importing createProposal
// from there would be a cycle).
//
// Takes a Db and an explicit target rather than a ToolContext, so the same
// entry point serves a chat tool, a web server action, and — when PRD 4's
// restricted worker agent lands — the worker path, none of which share a
// context shape.

/** Statuses a cascade may write. Everything else is a fixed constraint:
 *  `done`/`cancelled` are over, and `pending_review` is immovable BECAUSE its
 *  claim is what fired the cascade — it counts as finished for the floor and
 *  as untouchable for movement. */
const MOVABLE_STATUSES = new Set(['pending', 'in_progress', 'blocked']);

/** Matches applyRescheduleInput's `changes` cap. A cascade this wide is not
 *  something a manager can meaningfully approve from a card anyway. */
const MAX_CHANGES = 60;

export type RescheduleOutcome =
  | {
      status: 'no_changes';
      /** Machine-readable so callers can log WHY nothing happened — an empty
       *  card would be worse than silence, but a silent no-op with no trace is
       *  how "the cascade never fires" becomes an unfalsifiable bug report. */
      reason: 'no_job_tasks' | 'trigger_not_found' | 'no_dependents' | 'nothing_moves' | 'too_many_changes';
    }
  | { status: 'proposed'; proposalId: string; renderedText: string };

export interface RescheduleRequest {
  companyId: string;
  jobId: string;
  /** The task that just finished (or was declared finished). */
  taskId: string;
  /** Its ACTUAL finish date, ISO. Never derived from new Date() — callers take
   *  it from lisbon_today() or from what the manager said. */
  completedOn: string;
  /**
   * The thread the card should land in, resolved LAZILY: "nothing moved" is
   * the dominant outcome, and a caller that has to find-or-create a
   * conversation must not do so as a side effect of a completion that turned
   * out to cascade to nothing.
   */
  resolveConversationId: () => Promise<string | null>;
  locale: Locale;
}

/**
 * Propose a cascade over a job's remaining dependency graph after one task
 * finished early or late. Produces at most ONE approval card, and creates no
 * proposal at all when nothing would move.
 *
 * That last part is the dominant case, not an error: a job whose tasks were
 * all created one at a time by `create_task` has zero dependency edges, so a
 * completion cascades to nothing. An empty approval card is worse than
 * silence.
 *
 * Never throws on an ordinary miss — callers invoke this as a side effect of
 * completing a task, and a cascade failing must not fail the completion.
 * RescheduleError (a cyclic graph) IS propagated: refusing loudly is the whole
 * point of detecting it.
 */
export async function proposeReschedule(db: Db, request: RescheduleRequest): Promise<RescheduleOutcome> {
  const schedule = await loadJobSchedule(db, request.companyId, request.jobId);
  if (schedule.tasks.length === 0) return { status: 'no_changes', reason: 'no_job_tasks' };

  const trigger = schedule.tasks.find(task => task.id === request.taskId);
  if (!trigger) return { status: 'no_changes', reason: 'trigger_not_found' };

  const movable = new Set(
    [...dependentsClosure(schedule.edges, [request.taskId])].filter(id => {
      // Restricted to THIS job: task_dependencies only requires both ends be
      // same-company, so the closure can walk into another job's work, and
      // silently rescheduling a job the manager did not touch is not something
      // a card about "obra Rua X" could honestly describe.
      if (!schedule.jobTaskIds.has(id)) return false;
      const task = schedule.tasks.find(t => t.id === id);
      return task != null && MOVABLE_STATUSES.has(task.status);
    }),
  );
  if (movable.size === 0) return { status: 'no_changes', reason: 'no_dependents' };

  const changes = recomputeSchedule({
    tasks: schedule.tasks,
    today: schedule.today,
    completedOn: { [request.taskId]: request.completedOn },
    movable,
  });
  if (changes.length === 0) return { status: 'no_changes', reason: 'nothing_moves' };
  if (changes.length > MAX_CHANGES) return { status: 'no_changes', reason: 'too_many_changes' };

  // Early vs late is measured against what the task was PLANNED to finish. A
  // task with no due date has nothing to be early or late against, which is
  // what 'manual' means here.
  const shift = trigger.due_date ? workdayDelta(trigger.due_date, request.completedOn) : 0;
  const reason = !trigger.due_date || shift === 0 ? 'manual' : shift < 0 ? 'early_completion' : 'late_completion';

  const { proposalId, renderedText } = await createProposalForCompany(
    db,
    { companyId: request.companyId, conversationId: await request.resolveConversationId(), locale: request.locale },
    'apply_reschedule',
    {
      job_id: request.jobId,
      reason,
      trigger_task_id: request.taskId,
      ...(reason === 'manual' ? {} : { trigger_shift_days: shift }),
      changes: changes.map(change => ({
        task_id: change.task_id,
        from_start_date: change.from.start_date,
        from_due_date: change.from.due_date,
        to_start_date: change.to.start_date,
        to_due_date: change.to.due_date,
      })),
    },
  );
  return { status: 'proposed', proposalId, renderedText };
}

export { RescheduleError };

// ── the chat entry point ────────────────────────────────────────────────────

export const rescheduleJobInput = z.object({
  task_id: z
    .string()
    .uuid()
    .describe('The task that has finished — use list_tasks or agenda to find ids. It must already be marked done or awaiting review.'),
  completed_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('The date it actually finished, YYYY-MM-DD. Defaults to today — only pass it if the manager said a different day.'),
});

// UNGUARDED, exactly like generate_plan and translate_company_data: it never
// mutates domain state, it only ever produces a proposal. Its applier
// (apply_reschedule) is deliberately absent from the roster, so moving real
// dates stays reachable only through an approved card.
export const rescheduleJob: CapoTool<z.infer<typeof rescheduleJobInput>> = {
  name: 'reschedule_job',
  description:
    "Propose pulling in (or pushing out) the rest of a job's schedule after one of its tasks finished early or late. Use it when the manager tells you a task is finished ahead of or behind plan and the job has follow-on work. Produces an approval card showing every date that would move. If the job's tasks have no dependencies between them nothing can cascade and no card is created — that is a normal answer, not a failure, so do not retry.",
  inputSchema: rescheduleJobInput,
  async execute(input, ctx) {
    const { data: task } = await ctx.db
      .from('tasks')
      .select('id, job_id, status, title')
      .eq('id', input.task_id)
      .eq('company_id', ctx.companyId)
      .maybeSingle();
    // Error strings go TO THE MODEL, which relays them in the manager's own
    // language — so they are English, like the rest of the model-facing surface.
    if (!task) return { status: 'error' as const, message: `Task not found (${input.task_id})` };
    if (!task.job_id) {
      return { status: 'error' as const, message: `Task "${task.title}" is not on a job, so there is nothing to cascade.` };
    }
    // A cascade off a task that is still open would move real dates on the
    // strength of nothing at all. Marking it finished is a separate, guarded
    // write — the model must go through update_task (or the manager through
    // the board) first.
    if (task.status !== 'done' && task.status !== 'pending_review') {
      return {
        status: 'error' as const,
        message: `Task "${task.title}" is ${task.status}, not finished. Mark it complete first, then reschedule.`,
      };
    }

    const { data: today } = await ctx.db.rpc('lisbon_today');
    if (!today) return { status: 'error' as const, message: 'Could not read the current date.' };

    try {
      const outcome = await proposeReschedule(ctx.db, {
        companyId: ctx.companyId,
        jobId: task.job_id,
        taskId: task.id,
        completedOn: input.completed_on ?? today,
        // Already inside a conversation turn — nothing to resolve.
        resolveConversationId: async () => ctx.conversationId || null,
        locale: ctx.locales.user,
      });
      if (outcome.status === 'no_changes') {
        return {
          status: 'no_changes' as const,
          reason: outcome.reason,
          message:
            outcome.reason === 'no_dependents'
              ? `Nothing depends on "${task.title}", so no other task moves. No card was created.`
              : 'The rest of the job already sits where it should. No card was created.',
        };
      }
      return { status: 'proposed' as const, proposalId: outcome.proposalId, renderedText: outcome.renderedText };
    } catch (e) {
      return { status: 'error' as const, message: e instanceof Error ? e.message : String(e) };
    }
  },
};

export const rescheduleTools = [rescheduleJob];
