import { z } from 'zod';
import type { WorkerTool } from './types';
import { workerToolError } from './types';

// "Diz ao chefe que preciso de mais tinta" — the fifth crew tool (issue #152).
//
// This tool REVERSES a deliberate design. Until it existed, Capo answered that
// sentence with a refusal, and the refusal was true: the crew roster had four
// tools and none of them could reach the manager. The person standing next to
// the empty tin, at the exact moment they notice, was turned away — and told to
// phone somebody who is probably driving.
//
// What it does NOT do is as important as what it does. It records the request
// and gets it in front of the manager. It does not promise the thing will
// happen, it does not order anything, it does not create a task, and it does
// not tell the crew member their problem is solved. The persona and the policy
// are written to keep it that way; this comment is the reason.
//
// ── WHAT IS DELIBERATELY MISSING ────────────────────────────────────────────
//
// No photo requirement. `declare_task_done` demands one at the schema level
// because a completion claim with no proof is the exact failure that tool
// exists to prevent. A request carries no such hazard: the only thing requiring
// something here would achieve is that the request does not get made.
//
// No approval card, and it is the TYPE CHECKER that says so rather than this
// comment. `createProposal` takes a `ToolContext`, and `WorkerContext` has no
// `userId`, no `actor` and no `recentUserTexts` — so a worker tool cannot
// construct one. A request is INFORMATION for the manager, never a
// pre-authorised write to their data, and that escalation stays closed.
//
// No urgency field. Ranking comes from `needed_by` and plain subtraction
// against lisbon_today(), never from the model's reading of tone. A person
// writing calmly about a blocker tomorrow is more urgent than one writing in
// capitals about next month, and tone is the signal an agent reads worst.

/** Mirrors worker_requests.text's CHECK (1..1000) with headroom. The database
 *  is the backstop; clamping here means a long message is filed short rather
 *  than refused 23514, and a request refused is a request lost. */
export const REQUEST_TEXT_MAX = 500;

/**
 * A sanity band on `needed_by`, in days either side of the RUNTIME's UTC date.
 *
 * This is NOT "today" and must never be used as one — `lisbon_today()` is the
 * only clock this product has, it lives in SQL, and it is what the ranking
 * subtracts against. The band exists for one specific model failure: computing
 * "amanhã" into the wrong YEAR. That mistake is completely silent — the request
 * files as "later", never surfaces, and nobody finds out until the paint runs
 * out. A day of clock slop is irrelevant at this width, so the runtime clock is
 * good enough to catch it and a refusal costs one extra step.
 *
 * The width is chosen to CATCH a ±1 year slip while leaving every real request
 * inside: six months ahead is far beyond "preciso de tinta", and a month behind
 * covers "era para a semana passada" without admitting last year's date.
 */
const NEEDED_BY_MAX_DAYS_AHEAD = 180;
const NEEDED_BY_MAX_DAYS_BEHIND = 30;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pure: does this string name a real calendar day inside the sanity band?
 *
 * Round-trips through Date so 2026-02-30 is refused — `Date.parse` accepts it
 * and rolls it forward to March, which would file a request against a day the
 * crew member never named.
 */
export function neededByIsSane(value: string, now: number): boolean {
  if (!ISO_DATE.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(at)) return false;
  if (new Date(at).toISOString().slice(0, 10) !== value) return false;
  const days = (at - now) / 86_400_000;
  return days <= NEEDED_BY_MAX_DAYS_AHEAD && days >= -NEEDED_BY_MAX_DAYS_BEHIND;
}

const uuid = z.string().uuid();

export const askManagerInput = z.object({
  text: z
    .string()
    .min(1)
    .max(REQUEST_TEXT_MAX)
    .describe(
      // The model is asked for THEIR words, not a summary, for the same reason
      // declare_task_done's `note` is: the manager reads this as a quote
      // attributed to a named person, and a paraphrase attributed to somebody
      // is a sentence they did not say.
      "What they need, in THEIR OWN WORDS, copied as they wrote them — never your summary of them. The manager reads this as a quote attributed to this crew member. Keep the obra or the job in it if they mentioned one.",
    ),
  category: z
    .enum(['material', 'tool', 'machine', 'delivery', 'other'])
    .optional()
    .describe(
      'Coarse filing hint only, and always optional. Leave it out rather than guessing — "other" is a perfectly good answer and a wrong one is worse than none.',
    ),
  needed_by: z
    .string()
    .regex(ISO_DATE)
    .optional()
    .describe(
      'The DAY it is needed for, as YYYY-MM-DD, worked out from today\'s date at the top of this prompt ("hoje" = today, "amanhã" = tomorrow, "para a semana" = ask which day). Ask ONCE, in one line, if they did not say. If they still do not say, LEAVE IT OUT — the request is filed as undated and shown that way. Never guess a date.',
    ),
  task_id: uuid
    .optional()
    .describe('Only if they clearly named one of their own tasks. From my_tasks or the list above. Leave it out otherwise.'),
});

type AskManagerInput = z.infer<typeof askManagerInput>;

export const askManager: WorkerTool<AskManagerInput> = {
  audience: 'worker',
  name: 'ask_manager',
  description:
    'Record something this crew member needs — material, a tool, a machine, a delivery, anything — and send it to the manager. Use it whenever they ask you to tell the boss something they need. It records the request and puts it in front of the manager; it does NOT order anything, does not create a task, and does not mean the thing will arrive. Never tell them it is sorted.',
  inputSchema: askManagerInput,
  execute: async (input, ctx) => {
    // ── the in-process scope check, BEFORE any query ─────────────────────────
    // Identical rule and identical shape to declare_task_done: ctx.scope.taskIds
    // was computed from this worker's own open rows before the model ran, and
    // nothing the model or the crew member says can widen it. A uuid that is not
    // in it never reaches the database, so a real id belonging to a colleague in
    // the same company is refused without a round trip — which also means it
    // cannot be TIMED as an existence oracle.
    //
    // The refusal never quotes the id back, for the same reason.
    if (input.task_id !== undefined && !ctx.scope.taskIds.includes(input.task_id)) {
      return workerToolError(
        'That task is not one of theirs. Call ask_manager again with no task, or with an id from my_tasks.',
      );
    }

    // ── the second boundary: three filters, two of them phone-derived ────────
    // Not redundant with the scope check, and this is the case that motivates
    // it: `scope` was computed at the START of the turn and the manager may have
    // reassigned or closed the task since. Everything below runs on the service
    // role, so nothing else re-checks it. ONE query, so "no such task", "not
    // your company" and "not assigned to you" collapse into one silent outcome.
    if (input.task_id !== undefined) {
      const { data: task } = await ctx.db
        .from('tasks')
        .select('id')
        .eq('id', input.task_id)
        .eq('company_id', ctx.companyId)
        .eq('assignee_worker_id', ctx.workerId)
        .maybeSingle();
      if (!task) {
        return workerToolError(
          'That task is not one of theirs. Call ask_manager again with no task, or with an id from my_tasks.',
        );
      }
    }

    // See NEEDED_BY_MAX_DAYS_AHEAD: the band catches a date computed into the
    // wrong year, which is the one date mistake with NO symptom. Refused rather
    // than dropped, because silently filing a dated request as undated would
    // lose the very fact the crew member took the trouble to give us.
    if (input.needed_by !== undefined && !neededByIsSane(input.needed_by, Date.now())) {
      return workerToolError(
        'That date is not a real day, or is far too far away. Ask them again which day they need it for, or call ask_manager again with no date at all.',
      );
    }

    const text = input.text.trim().slice(0, REQUEST_TEXT_MAX);
    if (text.length === 0) {
      return workerToolError('There is nothing to record. Ask them what they need.');
    }

    // company_id and worker_id are PHONE-DERIVED and never model-supplied, so a
    // request cannot be filed into another company or attributed to another
    // person by anything written on the other end of this conversation. The
    // cross-company FK trigger in 0043 is the backstop for a mis-wired caller:
    // auth.uid() is null here, so RLS refuses nothing on this path.
    //
    // `.select()` is safe HERE only because ctx.db is the service role, which
    // bypasses grants — a tenant client chaining it on this table would be
    // refused 42501, because tenants hold SELECT but no INSERT (the ai_usage
    // trap, inverted). Nothing on a tenant path may insert into this table.
    const { data, error } = await ctx.db
      .from('worker_requests')
      .insert({
        company_id: ctx.companyId,
        worker_id: ctx.workerId,
        task_id: input.task_id ?? null,
        text,
        category: input.category ?? null,
        needed_by: input.needed_by ?? null,
      })
      .select('id')
      .single();

    if (error || !data) {
      // Includes 42P01 on a deploy that landed ahead of 0043. Answering "could
      // not record it" is the whole point: the failure this feature exists to
      // end is a crew member believing their message went somewhere it did not.
      return workerToolError(
        'Could not record it. Tell them plainly that it did not go through and that they should speak to their manager directly.',
      );
    }

    return {
      status: 'ok' as const,
      // Model-facing, and the one thing it MUST get across: recorded and sent,
      // NOT solved. The inbox and the lock-screen alert are immediate; the
      // WhatsApp line to the manager only goes out if they are inside their own
      // 24-hour window, so "he has seen it" is a promise we cannot make either.
      instruction:
        input.needed_by === undefined
          ? 'Recorded and sent to the manager, with no date on it. Tell them in ONE line that it has gone to the manager. Never say it is sorted, ordered, on its way, or that the manager has read it — you do not know any of that.'
          : `Recorded and sent to the manager for ${input.needed_by}. Tell them in ONE line that it has gone to the manager, and say the day back to them in words ("para amanhã"), never as a date. Never say it is sorted, ordered, on its way, or that the manager has read it — you do not know any of that.`,
    };
  },
};
