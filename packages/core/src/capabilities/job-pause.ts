import { z } from 'zod';
import { createProposal } from './propose';
import type { CapoTool } from './types';

// "Vou de férias" / "esta obra está parada e não sei quando voltamos"
// (issue #95) — the proposing half.
//
// Pausing an obra has always meant "book no work on these days": task_board
// already excludes a paused job's tasks from active_today / active_tomorrow,
// so the 07:00 briefing and the afternoon check-in stop mentioning them with
// no code change at all. What was missing was the OTHER half of what the
// manager means when he does not know the restart date: the tasks are still
// carrying dates that everybody can now see are fiction, and the board will
// keep marking them late against a plan nobody is following.
//
// A DEFINITE pause — "parada até dia 3" — is a different thing and already has
// a tool: update_job(status: 'paused') keeps every date exactly where it is,
// which is right, because the plan is still the plan. That distinction is the
// whole reason this tool exists separately, and the description below is where
// the model is told which is which.

// A whole obra's remaining work, capped where the applier caps it. Beyond
// this something has gone wrong with the request, not with the obra.
const MAX_TASKS = 200;

export type PauseJobOutcome =
  | {
      status: 'no_changes';
      /** Machine-readable so a silent no-op still leaves a trace, the same
       *  reason proposeReschedule carries one. */
      reason: 'job_not_found' | 'already_paused_and_undated' | 'no_dated_tasks' | 'too_many_tasks';
    }
  | { status: 'proposed'; proposalId: string; renderedText: string };

export const pauseJobInput = z.object({
  job_id: z
    .string()
    .uuid()
    .describe('Job (obra) to put on hold indefinitely — use list_jobs to find ids.'),
});

// UNGUARDED, exactly like generate_plan, translate_company_data and
// reschedule_job: it never mutates anything, it only ever produces a proposal.
// Its applier (apply_job_pause) is deliberately absent from the roster, so
// erasing real dates stays reachable only through an approved card.
export const pauseJob: CapoTool<z.infer<typeof pauseJobInput>> = {
  name: 'pause_job',
  description:
    "Propose putting a job (obra) on hold when the manager does NOT know when work restarts — holidays with no return date, a site stopped waiting on something, a client who has gone quiet. Produces one approval card that pauses the job and takes the dates off its unfinished tasks, listing every task that loses its dates. Use update_job with status 'paused' instead whenever the manager DID say when work resumes: that keeps the existing dates, which is what a definite pause should do. If the job's remaining tasks already have no dates, no card is created — that is a normal answer, not a failure, so do not retry.",
  inputSchema: pauseJobInput,
  async execute(input, ctx) {
    const { data: job } = await ctx.db
      .from('jobs')
      .select('id, name, status')
      .eq('id', input.job_id)
      .eq('company_id', ctx.companyId)
      .maybeSingle();
    // Error strings go TO THE MODEL, which relays them in the manager's own
    // language — so they are English, like the rest of the model-facing surface.
    if (!job) return { status: 'error' as const, message: `Job not found (${input.job_id})` };

    // Base `tasks`, never task_board: that view windows on lisbon_today(), and
    // the rows this tool exists to un-book are precisely the FUTURE ones it
    // would drop. Same reasoning reschedule-load.ts gives.
    const { data: tasks, error } = await ctx.db
      .from('tasks')
      .select('id, start_date, due_date, status')
      .eq('company_id', ctx.companyId)
      .eq('job_id', input.job_id)
      .not('status', 'in', '("done","cancelled")')
      .order('start_date', { ascending: true, nullsFirst: false })
      .limit(MAX_TASKS + 1);
    if (error) return { status: 'error' as const, message: `Could not read the job's tasks: ${error.message}` };

    // Finished and cancelled work keeps its dates: those are the record of
    // when the work actually happened, not a booking to be released.
    const dated = (tasks ?? []).filter(task => task.start_date !== null || task.due_date !== null);

    if (dated.length === 0) {
      return {
        status: 'no_changes' as const,
        reason: job.status === 'paused' ? ('already_paused_and_undated' as const) : ('no_dated_tasks' as const),
        message:
          job.status === 'paused'
            ? `"${job.name}" is already on hold and none of its remaining tasks carry dates. Nothing to propose.`
            : `None of the remaining tasks on "${job.name}" carry dates, so there is nothing to un-book. Pause it with update_job instead.`,
      };
    }
    if (dated.length > MAX_TASKS) {
      return {
        status: 'no_changes' as const,
        reason: 'too_many_tasks' as const,
        message: `"${job.name}" has more than ${MAX_TASKS} dated tasks — too many for one card.`,
      };
    }

    try {
      const created = await createProposal(ctx, 'apply_job_pause', {
        job_id: input.job_id,
        changes: dated.map(task => ({
          task_id: task.id,
          from_start_date: task.start_date,
          from_due_date: task.due_date,
        })),
      });
      if (created.status === 'already_pending') return created;
      return { status: 'proposed' as const, proposalId: created.proposalId, renderedText: created.renderedText };
    } catch (e) {
      return { status: 'error' as const, message: e instanceof Error ? e.message : String(e) };
    }
  },
};

export const jobPauseTools = [pauseJob];
