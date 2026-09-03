// The hours in which Capo may tell a crew member about a task they were just
// given (issue W7).
//
// Pure, dependency-free and asserted by `pnpm scheduler-check`, for the same
// reason the send window lives in lib/cron.ts rather than in either cron route:
// this is the one number that decides whether somebody's phone buzzes while
// they are asleep, and a copy of it in a route file is a copy that can drift.

/**
 * The first and last Lisbon hour an assignment note may go out. 08:00 through
 * 18:59, inclusive on both ends.
 *
 * ── WHY THERE IS A GATE AT ALL ─────────────────────────────────────────────
 * Assignment is a MANAGER's action and managers do admin in the evening. The
 * crew member on the other end is not at work, and a WhatsApp message at 23:40
 * telling them about tomorrow's tiling is the shape of thing that gets a
 * business number muted or reported. Quiet hours are a courtesy nobody notices
 * working and everybody notices failing — the same argument /api/cron/welcome's
 * eleven-hour window makes.
 *
 * ── WHY IT STARTS AT 08 ────────────────────────────────────────────────────
 * The 07:00 briefing's own window is Lisbon 07-08 (SEND_WINDOW_HOURS). Starting
 * at 08 keeps an assignment made first thing from arriving in the same minute
 * as the morning briefing, which would read as two Capos talking over each
 * other. It overlaps the briefing's last hour deliberately: a task assigned at
 * 08:30 is genuinely today's work and waiting an hour to say so would defeat
 * the whole feature.
 *
 * ── WHY IT ENDS AT 18 ──────────────────────────────────────────────────────
 * After 18:59 the working day is over, so "you have a new task for today" is
 * no longer true in any useful sense — the thing to do with that task is to
 * put it in tomorrow's 07:00 briefing, which happens by itself because the
 * board still holds it. So the drain does NOT stamp an out-of-hours notice as
 * decided: it leaves it queued, the next in-hours drain finds the task no
 * longer starts today, and it is dropped as `not_today`. Nothing is lost and
 * nothing is sent at midnight.
 */
export const TASK_ASSIGNED_START_HOUR = 8;
export const TASK_ASSIGNED_END_HOUR = 18;

/**
 * Is `hour` — Europe/Lisbon, straight from `lisbon_hour()` — an hour in which
 * an assignment note may be sent?
 *
 * Deliberately NOT `withinSendWindow`. That function models a send AIMED at an
 * hour and tolerating cron drift after it; this one models a working DAY, has
 * no target hour and no drift to absorb, and its two ends mean different
 * things. Reusing it would have meant expressing "08 to 18" as a start plus a
 * width, which is exactly the arithmetic that makes an off-by-one invisible.
 */
export function withinAssignmentHours(hour: number): boolean {
  return hour >= TASK_ASSIGNED_START_HOUR && hour <= TASK_ASSIGNED_END_HOUR;
}
