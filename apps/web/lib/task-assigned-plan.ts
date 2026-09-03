// The DECISION half of the immediate assignment note (issue W7), pure.
//
// The drain (apps/web/app/notifications/task-assigned.ts) owns the database,
// the consent gate and the Graph API. This owns the two things that decide
// whether a real person's phone buzzes, and it owns them where `pnpm
// whatsapp-check` can drive them with no credentials: WHAT to do about one
// crew member's queued notices, and the ORDER in which the doing happens.
//
// The order is the part that had to move out of the drain. Claiming after
// sending, or sending without claiming, is not a thing a type checker or a
// linter can see — and the symptom is a crew member getting the same message
// twice, seconds apart, only when two drains happen to overlap. That is a race
// nobody reproduces by hand, so it has to be asserted.

/**
 * What the drain wrote on a queue row. The single definition — 0048
 * deliberately puts no CHECK on the column, so that adding an outcome can never
 * fail a write at the moment somebody is waiting for their message.
 */
export type NoticeOutcome =
  /** Sent as free text, inside the crew member's own 24-hour window. */
  | 'sent_free_form'
  /** Sent as the paid template, outside it. */
  | 'sent_template'
  /** CLAIMED and being sent right now. The lock; see claimThenSend. */
  | 'sending'
  /** The task does not start today, or is no longer in a briefable status. */
  | 'not_today'
  /** Queued on an earlier Lisbon day. Never sent — the 07:00 briefing carried it. */
  | 'stale'
  /** No consent, not reachable, or not an active crew row. */
  | 'not_messageable'
  /** The task is no longer this person's by the time the drain looked. */
  | 'reassigned'
  /** Outside the window, and `capo_task_assigned` is not approved for their locale. */
  | 'template_unapproved'
  /** Outside the window, and this person already had their one template today. */
  | 'already_claimed_today'
  /** Meta refused the send. */
  | 'send_failed'
  /** The company is no longer paying, so no proactive send may cost money on it. */
  | 'not_billable'
  /** Queued outside working hours. NOT decided: `notified_at` stays null. */
  | 'outside_hours';

/**
 * The outcomes that mean "we actually reached out to this person".
 *
 * `sending` is in the set, and that is the whole point of it existing: a drain
 * that has CLAIMED but not yet heard back from Meta has already committed to a
 * message, and a second drain starting two seconds later must treat that as
 * "already messaged" rather than as "nothing has happened yet". Reading only
 * the finished outcomes is what made the first version's coalescing guard blind
 * in exactly the fast case it was written for.
 *
 * `sent_template` is in it too: somebody who got the paid template a minute ago
 * must not get a free-form follow-up on top of it.
 */
export const ENGAGED_OUTCOMES: ReadonlySet<NoticeOutcome> = new Set<NoticeOutcome>([
  'sending',
  'sent_free_form',
  'sent_template',
]);

/**
 * Was this notice queued on an earlier Lisbon day?
 *
 * ── WHY A STALE NOTICE IS NEVER SENT ───────────────────────────────────────
 * A notice queued outside working hours is deliberately left in the queue so a
 * later drain can look again. Without this test, the common manager habit of
 * planning tomorrow's work at nine in the evening produces this: the task is
 * for tomorrow, so nothing is sent tonight (right), the notice survives the
 * night, and at 08:00 the task now DOES start today — so a full "your boss just
 * gave you a new task" message goes out about an hour after the 07:00 briefing
 * has already said the same thing.
 *
 * The queue row remembers the day it was written on. If that is not today, the
 * moment for saying "just now" has passed and the morning briefing has already
 * done the job.
 *
 * Both arguments are `lisbon_today()`'s own YYYY-MM-DD strings — one clock, and
 * no date arithmetic here or anywhere else in this feature.
 */
export function noticeIsStale(queuedDate: string | null | undefined, today: string): boolean {
  // An unreadable or absent date reads as stale: sending nothing is the safe
  // direction, and the task is still on the board for the morning.
  return typeof queuedDate !== 'string' || queuedDate !== today;
}

/** What to do about one crew member's batch of live notices. */
export type DeliveryDecision =
  /** Stamp this outcome and send nothing. A final answer. */
  | { kind: 'skip'; outcome: NoticeOutcome }
  /** Leave the notices QUEUED and untouched; the cron folds them into one message. */
  | { kind: 'defer' }
  /** Claim the rows, then send. Never the other way round. */
  | { kind: 'send' };

/**
 * The per-person decision, in the order the reasons have to be considered.
 *
 * THE ORDER IS THE CONTENT. A `defer` placed above the two skips would leave a
 * crew member who can never be messaged sitting in the queue for ever, being
 * re-considered every fifteen minutes; both skips are permanent answers and a
 * deferral is not, so they come first.
 *
 * `newTaskCount === 0` is the reassignment case and it is not theoretical: the
 * out-of-hours and coalescing branches make the gap between queueing and
 * sending minutes to hours, and a manager who changes their mind inside it
 * would otherwise produce a self-contradicting message — "your boss just gave
 * you a new task for today", followed by the empty-day line, because the
 * renderer short-circuits when there is nothing to list.
 */
export function decideDelivery(input: {
  /** Did partitionCrew's consent/reachability gate let this person through? */
  messageable: boolean;
  /** How many of the queued tasks are still on this person's board today. */
  newTaskCount: number;
  /** Has a drain already committed to messaging them inside the coalescing window? */
  recentlyEngaged: boolean;
}): DeliveryDecision {
  if (!input.messageable) return { kind: 'skip', outcome: 'not_messageable' };
  if (input.newTaskCount === 0) return { kind: 'skip', outcome: 'reassigned' };
  if (input.recentlyEngaged) return { kind: 'defer' };
  return { kind: 'send' };
}

export interface ClaimThenSendResult<T> {
  /** The notice ids this drain won. Empty when another drain got there first. */
  won: readonly string[];
  /** Was `send` called at all? */
  sent: boolean;
  result?: T;
}

/**
 * CLAIM, THEN SEND. Never send, then claim; never send without claiming.
 *
 * ── WHY THE QUEUE ROW IS THE LOCK ──────────────────────────────────────────
 * The free-form path writes nothing to `notification_log` — that table is the
 * PAID ledger and nothing free belongs in it — so it had no lock at all. Two
 * drains starting two seconds apart (a manager tapping assign on one task, then
 * another; or `apply_plan` landing at the same moment as the fifteen-minute
 * cron) both read the same undrained notices, both found nothing stamped, and
 * both sent a whole-day message. The duplicate costs nothing and crosses no
 * consent boundary, but a duplicated proactive WhatsApp message to a crew
 * member is the failure class this codebase builds claim protocols to prevent.
 *
 * So `claim` is an atomic conditional stamp — `update … set notified_at = now(),
 * outcome = 'sending' where id in (…) and notified_at is null returning id` —
 * and only the ids that come BACK may be sent about. A losing drain gets zero
 * rows and does not call `send` at all. That is the same "a zero-row update is
 * not an error, so ask for the rows back" device the Stripe webhook already
 * uses, and the same claim-before-the-Graph-call trade-off `claimNotification`
 * makes: a crash mid-send costs this person their message rather than risking a
 * second one.
 *
 * Generic over the send's result and injected on both sides, so `pnpm
 * whatsapp-check` can drive it with fakes and assert the ordering itself —
 * which is not something a type checker can see.
 */
export async function claimThenSend<T>(args: {
  ids: readonly string[];
  claim: (ids: readonly string[]) => Promise<readonly string[]>;
  send: (wonIds: readonly string[]) => Promise<T>;
}): Promise<ClaimThenSendResult<T>> {
  if (args.ids.length === 0) return { won: [], sent: false };
  const won = await args.claim(args.ids);
  if (won.length === 0) return { won: [], sent: false };
  const result = await args.send(won);
  return { won, sent: true, result };
}
