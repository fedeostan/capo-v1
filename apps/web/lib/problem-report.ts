// The pure half of "report a problem" (issue #120).
//
// A bare report keyword ("bug", "problema") arms a staging row in
// `problem_report_requests` (0042); the sender's next text message is stored
// as the report. The two messages are two serverless invocations sharing no
// process state, so the expectation lives in the database — the same design,
// for the same reason, as the check-in photo request (0034), and like it the
// row stages the EXPECTATION only. The report text itself goes straight into
// `problem_reports` and nowhere else.
//
// Everything in this file is PURE: no Db, no clock beyond a `now` argument, no
// network. That is what lets `pnpm whatsapp-check` assert it with no
// credentials, which is the only automated coverage this path will ever get.

/**
 * How long "your next message is the report" stays armed.
 *
 * Thirty minutes: long enough to type a sentence with site gloves on or to be
 * interrupted by the actual work, short enough that a forgotten prompt cannot
 * survive to swallow a later, unrelated message as a report. Deliberately far
 * inside Meta's 24-hour free-form window, so the acknowledgement is always a
 * free session message.
 */
export const REPORT_REQUEST_TTL_MS = 30 * 60 * 1000;

export function reportRequestExpiry(now: number): string {
  return new Date(now + REPORT_REQUEST_TTL_MS).toISOString();
}

/**
 * Whether an armed request is still worth honouring.
 *
 * Expiry is enforced HERE, in the reader, rather than trusted to any sweep:
 * nothing sweeps `problem_report_requests`, and a row that is merely old must
 * be dead to every reader the moment it passes `expires_at`. An unparseable
 * timestamp reads as EXPIRED — fail closed, because this direction costs "the
 * message goes to the agent as usual", and the other direction costs "an
 * ordinary message is quietly diverted into the report table".
 */
export function reportRequestLive(expiresAt: string | null | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at > now;
}

/**
 * The bound `problem_reports.text`'s CHECK enforces (0042). Mirrored here so
 * both writers clamp BEFORE inserting: a WhatsApp message can be twice this
 * long, and a report refused 23514 for its length is a report lost — the one
 * failure this feature exists to end. Clamping keeps the first 2000 characters
 * and drops the rest, which beats refusing all of them.
 */
export const REPORT_TEXT_MAX = 2000;

/**
 * Code points, not UTF-16 units, because char_length() counts code points too
 * — a `.slice(0, 2000)` would agree with Postgres on plain text and disagree
 * on the emoji a site photo caption is full of, and could split a surrogate
 * pair at the boundary besides.
 */
export function clampReportText(text: string): string {
  const trimmed = text.trim();
  const points = [...trimmed];
  return points.length <= REPORT_TEXT_MAX ? trimmed : points.slice(0, REPORT_TEXT_MAX).join('');
}
