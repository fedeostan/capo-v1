// The pure half of "…and now send me a photo of it" (issue #52).
//
// #54 made a "Sim, terminei" tap file a completion CLAIM — open_task_review per
// task, so the task lands in `pending_review` and waits for the manager. What it
// could not do was ask for proof, and that asymmetry was the bug: the worker
// agent's `declare_task_done` has required at least one photo at the SCHEMA
// level since #22, while the button path required nothing at all. Two doors into
// the same state, disagreeing about evidence, with nothing telling the manager
// which door a claim came through.
//
// ── WHY THE PHOTO CANNOT SIMPLY BE ATTACHED ─────────────────────────────────
// A task photo's object key is `{company_id}/{task_id}/{uuid}.{ext}` and
// segment 1 of it IS the tenant boundary (0023). So the bytes cannot be written
// anywhere legitimate until the TASK is known. On the agent path the model names
// the task in the same turn the photo arrives; after a tap the photo arrives in
// a LATER message carrying nothing that names anything. Something has to
// remember, between the two messages, which tasks were claimed and which one is
// currently being asked about — that is `checkin_photo_requests` (0034), and
// what it stages is the EXPECTATION, never the bytes.
//
// Everything in this file is PURE: no Db, no clock beyond a `now` argument, no
// network. That is what lets `pnpm whatsapp-check` assert it with no
// credentials, which is the only automated coverage this path will ever get.

import type { ClaimOutcome } from './checkin-claim';

/**
 * One task in the check-in snapshot and what the claim attempt did to it.
 *
 * Paired at the source rather than zipped by position afterwards. The loop that
 * produces these owns both halves, so pairing them there costs nothing — and
 * "never zip two lists by position" is a rule this codebase already paid for
 * once, in the translation applier.
 */
export interface ClaimResult {
  taskId: string;
  outcome: ClaimOutcome;
}

/**
 * The tasks a photo is worth asking about: the ones now sitting in
 * `pending_review` because of this tap, or already sitting there from an earlier
 * one.
 *
 * `already_pending` is included deliberately. It means the same end state
 * reached earlier — the manager is waiting on that task either way — and a
 * worker who re-taps after remembering to photograph something should be able
 * to send it. `closed`, `missing` and `failed` are excluded: there is nothing
 * for a photo to be proof OF.
 *
 * Order is preserved, because it is the order the tasks will be asked about and
 * that order is the snapshot's own.
 */
export function claimedTaskIds(results: readonly ClaimResult[]): string[] {
  return results
    .filter(r => r.outcome === 'claimed' || r.outcome === 'already_pending')
    .map(r => r.taskId);
}

/**
 * How long Capo keeps expecting a photo after a tap.
 *
 * Three hours, and the number is shaped by the site rather than by the
 * protocol. The check-in goes out between 16:00 and 17:59 Lisbon, so three hours
 * covers "I'll do it when I get to the van" and stops well short of the next
 * morning — a request still live at 07:00 would attach a photo of TOMORROW's
 * work to yesterday's claim, silently and with a perfectly plausible timestamp.
 *
 * It is deliberately SHORTER than Meta's 24-hour free-form window, not longer:
 * the window bounds what we may SEND for free, and this bounds what we are
 * willing to BELIEVE an unlabelled photo is about. Widening it past the window
 * would also mean the follow-up "and the next one?" could no longer be sent
 * without a paid template, which it must never be.
 */
export const PHOTO_REQUEST_TTL_MS = 3 * 60 * 60 * 1000;

export function photoRequestExpiry(now: number): string {
  return new Date(now + PHOTO_REQUEST_TTL_MS).toISOString();
}

/**
 * Whether an open request is still worth honouring.
 *
 * Expiry is checked HERE, in the reader, rather than trusted to any sweep: no
 * cron closes these rows, and a request that is merely old must be dead to every
 * reader the moment it passes `expires_at`, not the moment somebody remembers to
 * tidy it. An unparseable timestamp reads as EXPIRED — fail closed, because the
 * failure this direction is "the photo goes to the agent instead", and the other
 * direction is "an unlabelled photo is filed as proof of something arbitrary".
 */
export function photoRequestLive(expiresAt: string | null | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at > now;
}

/**
 * Which task the next photo is for, or null when the request has run out of
 * tasks.
 *
 * `taskIds` has already been through readTaskIds(), so it holds no holes; the
 * bounds check is still written out because `next_index` is a plain integer
 * column and a stale row from an older shape must read as "finished" rather than
 * as `undefined` handed to a uuid argument.
 */
export function nextPhotoTaskId(taskIds: readonly string[], nextIndex: number): string | null {
  if (!Number.isInteger(nextIndex) || nextIndex < 0) return null;
  return taskIds[nextIndex] ?? null;
}

/**
 * The cursor is advanced by the route's `seekPhotoTarget`, which walks forward
 * from an index until it finds a task that is STILL this worker's and still in
 * `pending_review`, skipping any that were reassigned, closed or deleted between
 * the tap and the photo. That walk has to touch the database, so it lives in the
 * route rather than here; `nextPhotoTaskId` above is the step it takes.
 *
 * Skipping rather than stalling is the load-bearing half: a request that cannot
 * move past an unusable task would ask about it forever, and every photo the
 * worker sent afterwards would land nowhere.
 */
