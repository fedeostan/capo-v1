// "There is no light." — the one way out of the photo requirement, and the
// arithmetic that decides when it opens.
//
// ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
// `declare_task_done` requires proof, and that requirement is the whole reason
// a completion claim means anything. It also had no exit at all: a crew member
// in an unlit basement with a dead camera was told "that is the rule no matter
// what" and stopped telling anybody anything. Federico's rule is that Capo asks
// TWICE and then takes their word for it, flags the claim to the manager as
// having no photo, and says so to the crew member as well.
//
// ── WHY THE COUNT IS A PURE FUNCTION OVER DATABASE ROWS ────────────────────
// "Asked twice" is a fact about a conversation, and the person on the other end
// of that conversation writes the text. A prompt rule ("only waive on the third
// try") is a request that both the model and the worker are free to reinterpret
// — and the model in particular can call a tool six times inside one turn. So
// the rule lives here, over rows the model cannot write, and the unit it counts
// is the INBOUND MESSAGE: an id minted by Meta, identical for every tool call
// in one turn, and carried on `WorkerContext.inboundMessageId`. Three calls in
// one turn share it and count once. Reaching the third attempt therefore costs
// three separate messages from a real phone, which is exactly the "asked twice"
// the rule describes.
//
// Pure by construction: no `Db`, no clock, no locale, no I/O. That is what lets
// `pnpm waiver-check` assert every branch with no credentials, and it is the
// same posture `capabilities/reschedule.ts` and `channels/push-rules.ts` take
// for the same reason.

/**
 * How many DISTINCT earlier inbound messages must have already asked before the
 * photo requirement can be waived.
 *
 * Two, so the waiving message is the third. It is a NUMBER rather than a
 * sentence in a prompt for the reason in the header, and it is deliberately not
 * configurable: a per-company dial on this would be a per-company answer to
 * "how much proof does a completion claim need", which is a product decision
 * and not a setting.
 */
export const WAIVER_ASKS_REQUIRED = 2;

/** One recorded attempt, as `task_photo_waiver_attempts` stores it. */
export interface PhotoWaiverAttempt {
  /** Meta's `wamid` for the message that attempt belonged to. */
  inboundMessageId: string;
}

export interface PhotoWaiverInput {
  /** Every attempt already recorded for THIS conversation and THIS task. */
  attempts: readonly PhotoWaiverAttempt[];
  /** The id of the message being answered right now. */
  currentInboundId: string;
  /** Whether this crew member has ANY photo waiting in the inbox (0047). */
  hasPhotos: boolean;
  /** The crew member's own words about why there is no photo, if they gave any. */
  reason?: string | null;
}

export type PhotoWaiverOutcome =
  /** There is a photo waiting. The waiver is not on the table at all. */
  | 'photos'
  /** First time of asking. Ask plainly. */
  | 'ask_first'
  /** Second time. Say a photo is required, and that any photo will do. */
  | 'ask_again'
  /** Third time, but they have not said why. Ask why, once. */
  | 'need_reason'
  /** Third time, with their reason. File the claim without a photo. */
  | 'waive';

export interface PhotoWaiverDecision {
  outcome: PhotoWaiverOutcome;
  /** How many DISTINCT earlier inbound messages have already asked. */
  priorAsks: number;
  /**
   * The `attempt_no` to record for this message, or null when nothing should be
   * written — because there is a photo, or because this exact inbound message
   * has already been counted (the same-turn repeat this whole design exists to
   * refuse).
   */
  attemptNo: number | null;
  /** The trimmed reason, present ONLY on 'waive'. Their words, never ours. */
  reason: string | null;
}

/**
 * Everything the waiver rule is.
 *
 * Fail-closed in every direction that matters:
 *   - a blank `currentInboundId` (which should be impossible: it comes from
 *     Meta) counts nothing and can never waive, so a caller that forgets to
 *     wire it up makes Capo stricter rather than looser;
 *   - a reason of nothing but whitespace is no reason;
 *   - an unreadable attempts table (42P01 before 0049 is applied) reaches this
 *     function as an empty list, which reads as "never asked" and produces the
 *     product exactly as it stands today.
 */
export function decidePhotoWaiver({
  attempts,
  currentInboundId,
  hasPhotos,
  reason,
}: PhotoWaiverInput): PhotoWaiverDecision {
  if (hasPhotos) {
    return { outcome: 'photos', priorAsks: 0, attemptNo: null, reason: null };
  }

  const current = currentInboundId.trim();

  // Distinct EARLIER messages. The current one is excluded on purpose: it is
  // what makes three tool calls in one turn count as one ask, and it is the
  // only thing standing between the model and a same-turn waiver.
  const earlier = new Set(
    attempts
      .map(a => a.inboundMessageId?.trim())
      .filter((id): id is string => Boolean(id) && id !== current),
  );
  const priorAsks = earlier.size;

  // Already counted this message, so record nothing. A blank id is treated the
  // same way for the reason in the doc comment: we cannot tell one turn from
  // the next, so we refuse to advance the count.
  const alreadyCounted = current === '' || attempts.some(a => a.inboundMessageId?.trim() === current);
  const attemptNo = alreadyCounted ? null : priorAsks + 1;

  if (priorAsks < WAIVER_ASKS_REQUIRED) {
    return {
      outcome: priorAsks === 0 ? 'ask_first' : 'ask_again',
      priorAsks,
      attemptNo,
      reason: null,
    };
  }

  // A blank id can never waive. See the doc comment: this is the "somebody
  // stopped passing the message id" case, and being stricter is the safe way to
  // be wrong.
  if (current === '') {
    return { outcome: 'ask_again', priorAsks, attemptNo: null, reason: null };
  }

  const said = reason?.trim() ?? '';
  if (said === '') {
    return { outcome: 'need_reason', priorAsks, attemptNo, reason: null };
  }

  return { outcome: 'waive', priorAsks, attemptNo, reason: said };
}
