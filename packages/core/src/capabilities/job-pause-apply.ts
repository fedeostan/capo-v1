import { z } from 'zod';
import type { CapoTool } from './types';

// The applier half of "pause this obra, I don't know when we go back"
// (issue #95). Split into its own module for exactly the reason plan-apply.ts
// and reschedule-apply.ts are: propose.ts must import this proposable tool,
// and the module that PRODUCES the proposal (job-pause.ts) imports
// createProposal from propose.ts. Importing it from there would be a cycle.

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('ISO date, YYYY-MM-DD');

const clearedDatesInput = z.object({
  task_id: z.string().uuid(),
  // Not documentation — this pair is the compare-and-set predicate execution
  // runs against, exactly as in apply_reschedule. A card left open overnight
  // must never silently erase a date the manager set in the meantime.
  from_start_date: isoDate.nullable(),
  from_due_date: isoDate.nullable(),
});

export const applyJobPauseInput = z
  .object({
    job_id: z.string().uuid().describe('Job (obra) being put on hold indefinitely.'),
    // No upper bound in the card's favour: a whole obra's remaining work is
    // the unit here, and the operation is uniform (every row loses its dates),
    // so unlike a cascade there is no per-row judgement for the manager to
    // make. 200 is a sanity ceiling on the payload, not a product rule.
    changes: z.array(clearedDatesInput).min(1).max(200),
  })
  .superRefine((input, ctx) => {
    const ids = new Set(input.changes.map(c => c.task_id));
    if (ids.size !== input.changes.length) {
      ctx.addIssue({ code: 'custom', path: ['changes'], message: 'Duplicate task_id in changes' });
    }
  });

type ApplyJobPauseInput = z.infer<typeof applyJobPauseInput>;

// NOT in the roster (index.ts) — only in propose.ts's `proposable` array, the
// fourth member of the apply_plan / apply_company_translation / apply_reschedule
// family. Absent rather than merely guarded for the reason AGENTS.md documents:
// a guarded tool in the roster executes DIRECTLY whenever the model can quote
// the manager, and for "vou de férias, pausa a obra" it always can. Erasing
// dates is not recoverable from anything this schema stores, so it has to sit
// behind a card the manager actually reads.
export const applyJobPause: CapoTool<ApplyJobPauseInput> = {
  name: 'apply_job_pause',
  description:
    "Put a job on hold and clear the start and due dates of its unfinished tasks. Only ever runs via an approved proposal — never call this directly.",
  inputSchema: applyJobPauseInput,
  guarded: true,
  async execute(input, ctx) {
    const ids = input.changes.map(c => c.task_id);

    // ── pre-flight ────────────────────────────────────────────────────────
    // resolveProposal re-validates and re-renders before executing, but it
    // cannot know a ROW moved underneath. Everything is checked BEFORE the
    // first write, so a stale card changes nothing at all — the same posture
    // as apply_reschedule, and it matters more here because the write is
    // destructive: a cleared date cannot be read back off anything.
    const { data: current, error: readError } = await ctx.db
      .from('tasks')
      .select('id, job_id, status, start_date, due_date')
      .eq('company_id', ctx.companyId)
      .in('id', ids);
    if (readError) throw new Error(`apply_job_pause failed reading tasks: ${readError.message}`);

    const byId = new Map((current ?? []).map(row => [row.id, row]));
    for (const change of input.changes) {
      const row = byId.get(change.task_id);
      if (!row) throw new Error(`apply_job_pause: task ${change.task_id} no longer exists`);
      if (row.job_id !== input.job_id) {
        throw new Error(`apply_job_pause: task ${change.task_id} is no longer on this job`);
      }
      // A task finished (or was cancelled) after the card was written. Its
      // dates are now the record of when the work actually happened, and
      // wiping them would destroy history rather than un-book future work.
      if (row.status === 'done' || row.status === 'cancelled') {
        throw new Error(
          `apply_job_pause: task ${change.task_id} was finished after this card was created — nothing was changed`,
        );
      }
      if (row.start_date !== change.from_start_date || row.due_date !== change.from_due_date) {
        throw new Error(
          `apply_job_pause: task ${change.task_id} was changed after this card was created — nothing was changed`,
        );
      }
    }

    // ── apply ─────────────────────────────────────────────────────────────
    // The JOB is paused first, and the order is load-bearing. Dying in between
    // leaves a paused obra with some dates still on it: visible on the board,
    // badged "em pausa", off the crew's morning message — an untidy state that
    // reads correctly and is fixed by approving again. The reverse order would
    // strip the dates while the obra still looked active, which is work that
    // has silently vanished from every day view with nothing saying why.
    const { data: job, error: jobError } = await ctx.db
      .from('jobs')
      .update({ status: 'paused' })
      .eq('id', input.job_id)
      .eq('company_id', ctx.companyId)
      .select('id')
      .maybeSingle();
    if (jobError) throw new Error(`apply_job_pause failed pausing the job: ${jobError.message}`);
    // A filter that matched nothing is a fully successful statement in
    // Postgres, so the zero-row case has to be checked rather than trusted —
    // same trap the billing webhook documents.
    if (!job) throw new Error(`apply_job_pause: job ${input.job_id} no longer exists`);

    const now = new Date().toISOString();
    const cleared: string[] = [];
    for (const change of input.changes) {
      let query = ctx.db
        .from('tasks')
        .update({ start_date: null, due_date: null, updated_at: now })
        .eq('id', change.task_id)
        .eq('company_id', ctx.companyId);
      // `is not distinct from`, spelled the way PostgREST spells it: .is() for
      // NULL, .eq() for a value. A plain .eq(col, null) would match nothing.
      query = change.from_start_date === null ? query.is('start_date', null) : query.eq('start_date', change.from_start_date);
      query = change.from_due_date === null ? query.is('due_date', null) : query.eq('due_date', change.from_due_date);

      const { data, error } = await query.select('id');
      if (error) throw new Error(`apply_job_pause failed on task ${change.task_id}: ${error.message}`);
      if (!data || data.length === 0) {
        throw new Error(`apply_job_pause: task ${change.task_id} changed while the pause was being applied`);
      }
      cleared.push(change.task_id);
    }

    return { job_id: input.job_id, status: 'paused', cleared };
  },
};

export const jobPauseApplyTools = [applyJobPause];
