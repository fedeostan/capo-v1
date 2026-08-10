import { z } from 'zod';
import type { CapoTool } from './types';

// Split out of the cascade's own modules for exactly the reason plan-apply.ts
// was split out of plan.ts: propose.ts must import this proposable tool, and
// the module that PRODUCES the proposal imports createProposal from propose.ts.
// Importing it from there would be a cycle.

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('ISO date, YYYY-MM-DD');

const rescheduleChangeInput = z.object({
  task_id: z.string().uuid(),
  // BOTH sides are stored. The `from_*` pair is not documentation — it is the
  // compare-and-set predicate that execution runs against, see below.
  from_start_date: isoDate.nullable(),
  from_due_date: isoDate.nullable(),
  to_start_date: isoDate,
  to_due_date: isoDate,
});

export const applyRescheduleInput = z
  .object({
    job_id: z.string().uuid().describe('Job (obra) whose remaining work is being rescheduled.'),
    reason: z.enum(['early_completion', 'late_completion', 'manual']),
    trigger_task_id: z.string().uuid().optional().describe('The task whose completion set off the cascade.'),
    trigger_shift_days: z
      .number()
      .int()
      .optional()
      .describe('Signed working-day delta of the trigger against its planned due date; negative = finished early.'),
    // 60 rather than apply_plan's 30: that cap matches what the PLANNER can
    // generate in one go, but a live job accumulates tasks across several
    // plans. Raising a max is backward compatible — proposals stored under an
    // old cap still re-validate when the manager approves them.
    changes: z.array(rescheduleChangeInput).min(1).max(60),
  })
  .superRefine((input, ctx) => {
    const ids = new Set(input.changes.map(c => c.task_id));
    if (ids.size !== input.changes.length) {
      // Two rows for one task would make the second compare-and-set fail
      // against the first one's write, failing the whole proposal for no
      // reason the manager could act on.
      ctx.addIssue({ code: 'custom', path: ['changes'], message: 'Duplicate task_id in changes' });
    }
  });

type ApplyRescheduleInput = z.infer<typeof applyRescheduleInput>;

// NOT in the roster (index.ts) — only in propose.ts's `proposable` array, the
// third member of the apply_plan / apply_company_translation family. Absent
// rather than merely guarded for the reason AGENTS.md already documents: a
// guarded tool in the roster executes DIRECTLY whenever the model can quote
// the manager, and for "a Pintura acabou mais cedo" it always can.
export const applyReschedule: CapoTool<ApplyRescheduleInput> = {
  name: 'apply_reschedule',
  description:
    "Move the start and due dates of a job's remaining tasks to the already-computed dates a cascade produced. Only ever runs via an approved proposal — never call this directly.",
  inputSchema: applyRescheduleInput,
  guarded: true,
  async execute(input, ctx) {
    const ids = input.changes.map(c => c.task_id);

    // ── pre-flight ────────────────────────────────────────────────────────
    // resolveProposal re-validates and re-renders before executing, but it has
    // no way to know a ROW changed underneath. Without this, approving a card
    // left open overnight silently stomps a manual edit the manager made in
    // between — the same failure apply_company_translation's languageMoved
    // re-check exists to prevent (render.ts:169-178).
    //
    // Checked in full BEFORE the first write because the alternative is a
    // half-moved job: PostgREST cannot express a conditional multi-row update
    // as one statement, and the atomic version would mean another SECURITY
    // DEFINER function whose internal tenant check is the entire boundary.
    // The narrow race that remains (an edit landing between this read and the
    // matching write) is still caught by the per-row predicate below, which
    // fails the proposal — it just may leave earlier rows moved, exactly like
    // apply_plan's documented non-atomicity.
    const { data: current, error: readError } = await ctx.db
      .from('tasks')
      .select('id, job_id, start_date, due_date')
      .eq('company_id', ctx.companyId)
      .in('id', ids);
    if (readError) throw new Error(`apply_reschedule failed reading tasks: ${readError.message}`);

    const byId = new Map((current ?? []).map(row => [row.id, row]));
    for (const change of input.changes) {
      const row = byId.get(change.task_id);
      if (!row) throw new Error(`apply_reschedule: task ${change.task_id} no longer exists`);
      if (row.job_id !== input.job_id) {
        throw new Error(`apply_reschedule: task ${change.task_id} is no longer on this job`);
      }
      if (row.start_date !== change.from_start_date || row.due_date !== change.from_due_date) {
        throw new Error(
          `apply_reschedule: task ${change.task_id} was changed after this card was created — nothing was moved`,
        );
      }
    }

    // ── apply ─────────────────────────────────────────────────────────────
    const now = new Date().toISOString();
    const moved: string[] = [];
    for (const change of input.changes) {
      let query = ctx.db
        .from('tasks')
        .update({ start_date: change.to_start_date, due_date: change.to_due_date, updated_at: now })
        .eq('id', change.task_id)
        .eq('company_id', ctx.companyId);
      // `is not distinct from`, spelled the way PostgREST spells it: .is() for
      // NULL, .eq() for a value. A plain .eq(col, null) would match nothing.
      query = change.from_start_date === null ? query.is('start_date', null) : query.eq('start_date', change.from_start_date);
      query = change.from_due_date === null ? query.is('due_date', null) : query.eq('due_date', change.from_due_date);

      const { data, error } = await query.select('id');
      if (error) throw new Error(`apply_reschedule failed on task ${change.task_id}: ${error.message}`);
      if (!data || data.length === 0) {
        throw new Error(`apply_reschedule: task ${change.task_id} changed while the reschedule was being applied`);
      }
      moved.push(change.task_id);
    }

    return { job_id: input.job_id, reason: input.reason, moved };
  },
};

export const rescheduleApplyTools = [applyReschedule];
