// The two quiet-hours gates the welcome runs behind (issue #45, and the
// immediate trigger that followed it).
//
// There are TWO now, and the difference between them is the whole feature.
//
// ── WHY THERE IS AN HOUR GATE AT ALL ────────────────────────────────────────
// Unlike the two daily sends the welcome has no "correct" time — it fires
// whenever somebody was added. But a manager doing admin at 23:40 must not wake
// their crew, and a first-ever message from an unknown business number at 03:00
// is how that number earns a block report. Quiet hours are a courtesy the crew
// will never see working and would certainly notice failing.
//
// ── WHY THE IMMEDIATE ONE IS WIDER ──────────────────────────────────────────
// The sweep's window starts at 09 so a crew member added overnight cannot be
// welcomed and briefed inside the same hour in an order nobody chose, and ends
// at 19 because nothing about a background sweep is urgent.
//
// The immediate trigger is a different question. A manager who has just typed
// somebody's number into Capo is standing next to them, on site, at whatever
// hour a construction day actually runs — 08:00 before the vans leave, 20:00
// when the paperwork gets done. Making that person wait until 09:00 tomorrow
// because their manager added them at 20:15 is the exact complaint this
// feature exists to answer. So the immediate gate is 08:00 through 21:59: wide
// enough to cover a working day at both ends, and still closed over the hours
// when a stranger's message on your phone is an intrusion rather than a
// welcome.
//
// Outside the immediate gate the trigger does NOTHING and says so in a log
// line. It never queues, never sets a timer and never writes app state: the
// */15 sweep re-derives its queue from the database on every run, so a person
// added at 23:00 is simply picked up at 09:00, exactly as they were before this
// existed. That is the difference between an optimisation and a mechanism —
// remove every immediate call site and the product still welcomes everybody,
// just later.
//
// Pure and dependency-free, like apps/web/lib/briefing-template.ts, so
// `pnpm scheduler-check` can assert both windows from the same numbers the
// routes run on.

/** The first Lisbon hour the every-15-minutes sweep may send in, and how
 *  wide that window is: 09:00 through 19:59. */
export const WELCOME_SEND_HOUR = 9;
export const WELCOME_WINDOW_HOURS = 11;

/**
 * The immediate trigger's own gate: Lisbon 08:00 through 21:59 inclusive.
 *
 * WIDER at both ends than the sweep's, deliberately, and the two must never be
 * collapsed into one number. Narrowing this to the sweep's window would make
 * the whole feature invisible for the evening half of a construction day;
 * widening it further would put Capo's first ever message to a stranger inside
 * their night.
 */
export const WELCOME_IMMEDIATE_HOUR = 8;
export const WELCOME_IMMEDIATE_WINDOW_HOURS = 14;

/** Which of the two ways a welcome run was started. */
export type WelcomeWindow = 'cron' | 'immediate';

/**
 * The gate for one kind of run, in the shape withinSendWindow/sendWindowEnd
 * take. One function rather than two constants at each call site, so a route
 * cannot accidentally read the sweep's hour with the immediate width.
 */
export function welcomeWindowFor(window: WelcomeWindow): { sendHour: number; windowHours: number } {
  return window === 'immediate'
    ? { sendHour: WELCOME_IMMEDIATE_HOUR, windowHours: WELCOME_IMMEDIATE_WINDOW_HOURS }
    : { sendHour: WELCOME_SEND_HOUR, windowHours: WELCOME_WINDOW_HOURS };
}
