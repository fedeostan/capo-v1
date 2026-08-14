// The pure half of "a worker tapped 'Sim, terminei'" (issue #54).
//
// Until #54 that tap wrote a row in `worker_checkins` and stopped there. The
// worker believed they had reported the job; the manager's board still said
// pending; Capo, reading the board, told the manager "still pending". Three
// parties, three beliefs, and nothing anywhere recording the disagreement.
//
// The tap now files the SAME completion claim the worker agent's
// `declare_task_done` files: open_task_review(), which moves the task to
// `pending_review` and writes a `task_reviews` row in one transaction. Not
// `done` — a tap is a claim, not a verification, and `task_board.is_open` is a
// denylist so a task in review stays visible and still goes overdue if its
// dates say so (AGENTS.md, on pending_review).
//
// Everything in this file is PURE: no Db, no clock, no network. That is what
// lets `pnpm whatsapp-check` assert it with no credentials, which is the only
// automated coverage this path will ever get — the RPC itself cannot be
// exercised without a database.
//
// The impure half — the per-task RPC loop — lives in the webhook route, next to
// the ownership read that is the tenant boundary for it.

/**
 * What happened to ONE task in the check-in's snapshot.
 *
 * Per task, deliberately. `notification_log.task_ids` holds everything the
 * worker was asked about that afternoon, and open_task_review refuses a task
 * that is already `done`/`cancelled` (0019) while
 * `task_reviews_one_pending_idx` refuses a second pending review for the same
 * task (0018). Either refusal is an ordinary, expected outcome for ONE task and
 * must never abort the others: a worker with three tasks, one of which the
 * manager already closed, still gets the other two claimed.
 */
export type ClaimOutcome =
  /** A review was filed and the task is now `pending_review`. */
  | 'claimed'
  /** A review was already outstanding for it — the same end state, reached earlier. */
  | 'already_pending'
  /** The task was already `done` or `cancelled`; there was nothing left to declare. */
  | 'closed'
  /** open_task_review could not find the task at all. */
  | 'missing'
  /** Anything else: a transport error, a permission error, an unknown SQLSTATE. */
  | 'failed';

/**
 * `notification_log.task_ids` is typed `Json`, so it is `unknown` in practice —
 * the column is written by the cron as a string array but nothing in the type
 * system says so, and every id here goes straight into `p_task` on a uuid
 * argument.
 *
 * Validated rather than cast: a malformed snapshot must claim nothing, not
 * throw halfway through and leave the worker with no acknowledgement. Anything
 * that is not a non-empty string is dropped, and duplicates are collapsed so a
 * repeated id cannot produce a spurious `already_pending` against itself.
 */
export function readTaskIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return [...new Set(ids)];
}

/**
 * Map one PostgREST error from `open_task_review` onto a ClaimOutcome.
 *
 * The SQLSTATEs are the ones 0018/0019 raise deliberately:
 *   - 23505  the unique violation from task_reviews_one_pending_idx.
 *   - 23514  `raise … using errcode = 'check_violation'` — "task % is %, not open".
 *   - 02000  `raise … using errcode = 'no_data_found'` — "task % not found".
 * Everything else, 42501 (`insufficient_privilege`) included, is 'failed'. That
 * one should be unreachable on this path — the guard in open_task_review is
 * skipped when `auth.uid()` is null, which it always is for the service role —
 * so if it ever appears it is a real defect and deserves the loud branch.
 *
 * The message regexes are a second, weaker key on purpose. A SQLSTATE can be
 * lost in transit (PostgREST has re-mapped errors before, and the supabase-js
 * client synthesises its own error objects on a transport failure), and the
 * cost of misreading a duplicate as a hard failure is that a worker whose claim
 * is already waiting is told to go and find their foreman.
 */
export function classifyClaimError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): ClaimOutcome {
  if (!error) return 'claimed';
  const code = error.code ?? '';
  const message = error.message ?? '';
  if (code === '23505' || /task_reviews_one_pending/i.test(message)) return 'already_pending';
  if (code === '23514' || /not open/i.test(message)) return 'closed';
  if (code === '02000' || /not found/i.test(message)) return 'missing';
  return 'failed';
}

/**
 * Which acknowledgement the worker gets, from the whole set of per-task
 * outcomes. Three answers, because there are exactly three things worth telling
 * someone holding a phone on a building site.
 *
 * NONE of them says "done". That is the entire point of #54: the task is
 * waiting for the manager, and a worker told "feito" who then sees the same
 * task on tomorrow's 07:00 message concludes Capo is broken. The same reasoning
 * is already written into `declare_task_done`'s model-facing instruction.
 *
 * 'awaiting' wins over everything else: if ANY task is now with the manager,
 * that is the fact the worker needs. A partial failure is not worth a second
 * sentence they cannot act on — it is worth a log line, which the caller
 * writes per task.
 *
 * 'missing' is grouped with 'failed', not with 'closed'. A task that is closed
 * is a state the worker can understand; a task that has vanished is one we
 * cannot explain, and the honest answer to something we cannot explain is
 * "speak to your foreman".
 *
 * An EMPTY outcome list is 'nothing': the ask carried no task ids, so the
 * answer was recorded and there was never anything to claim.
 */
export type CheckinAck = 'awaiting' | 'nothing' | 'error';

export function checkinDoneAck(outcomes: readonly ClaimOutcome[]): CheckinAck {
  if (outcomes.some(o => o === 'claimed' || o === 'already_pending')) return 'awaiting';
  if (outcomes.some(o => o === 'failed' || o === 'missing')) return 'error';
  return 'nothing';
}
