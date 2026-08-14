import type { Db } from '@capo/db/client';
import { logEvent } from './log';
import { SEND_WINDOW_HOURS, sendWindowEnd } from './cron';

// ── THE SCHEDULE IS DATA NOW (issue #51, part B1) ───────────────────────────
//
// Until this file existed, "07:00" was a `const SEND_HOUR = 7` in the route and
// a set of UTC entries in apps/web/vercel.json. vercel.json is a static file
// baked into the deployment: a tenant cannot edit a Vercel cron entry, and no
// amount of UI could change one. So "let the manager move the morning message
// to 06:30" was not a hard feature — it was an impossible one.
//
// The fix is to invert what the platform cron is FOR. It used to BE the
// schedule; it is now a HEARTBEAT that asks, hourly, "is anything due for
// anyone right now?" The answer lives in company_schedules (0036), and the
// per-company gate below is what turns a heartbeat into a send.
//
// ── WHY HOURLY, AND NOT EVERY 10 OR 15 MINUTES ─────────────────────────────
// This is the number the issue warns about: get it wrong and you either miss
// sends or multiply cost. Both halves of that sentence deserve an answer.
//
// MISSING A SEND. The gate's resolution is one Lisbon HOUR — lisbon_hour()
// returns an integer and withinSendWindow compares integers — so a sub-hour
// tick cannot make the send land any more precisely than an hourly one. What
// actually protects against Vercel's measured 33–49 minutes of dispatch drift
// is the two-hour WINDOW from part A, not the tick rate. With an entry every
// hour at :00, a target hour T is covered by the entry at T (which lands at T
// or, drifting, at T+1 — both inside the window) and again by the entry at
// T+1. Two independent chances every day, in every season, at every legal
// target hour. A quarter-hourly tick would only start to help once drift exceeded two
// hours, at which point the window is the binding constraint and the fix is to
// widen the window, not the tick.
//
// MULTIPLYING COST. The expensive thing in this product is a Meta template
// send, and the tick rate cannot change that number AT ALL: notification_log's
// unique constraint is the idempotency lock, so a second in-window invocation
// claims nothing (23505) and messages nobody. What the tick rate DOES multiply
// is platform invocations and database work — which is why the routes gate on
// this file BEFORE calling loadCompanyBriefing. An out-of-window invocation
// costs the clock, the company list and one read of this table, and never
// touches task_board. 24 cheap ticks a day per route is a rounding error next
// to the existing 144-a-day push sweep; 96 would be four times that for no
// gain in accuracy.
//
// EVERY ENTRY STAYS AT :00. `0 * * * *` satisfies that rule, and the rule has
// not been retired — see the header of withinSendWindow. A half-hourly heartbeat
// would put half its ticks thirty minutes into the hour, which is exactly the
// headroom arithmetic that made the check-in ship and never send.

/**
 * The two sends a company can schedule. These strings are `notification_log`'s
 * `kind` values, deliberately, so a run row, a claim and a schedule row all
 * name the same thing.
 */
export const JOB_KINDS = ['daily_briefing', 'task_checkin'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * What each send is aimed at when a company has never chosen — which is every
 * company on the day this ships, because 0036 deliberately backfills nothing.
 *
 * These are the numbers that used to be `const SEND_HOUR` in each route, and
 * they are still the ONLY hours in play until a manager touches the screen.
 */
export const DEFAULT_SEND_HOURS: Record<JobKind, number> = {
  daily_briefing: 7,
  task_checkin: 16,
};

/**
 * The earliest and latest hour a manager may aim a send at, Europe/Lisbon.
 *
 * The floor is quiet hours: a mistyped 4 must not buzz a crew's phones before
 * dawn. The ceiling is STRUCTURAL and is the more important of the two —
 * sendWindowEnd() clamps at 23 and must never wrap past midnight, because
 * `notification_date` comes from lisbon_today() and a run on the far side of
 * midnight reads as a fresh unclaimed day to the idempotency lock, i.e. it
 * messages everybody a second time. At 21 the window is 21–22 and cannot
 * reach it. The same pair is a CHECK constraint in 0036, and
 * `pnpm scheduler-check` derives the no-wrap property from these constants
 * rather than trusting the comment.
 */
export const MIN_SEND_HOUR = 5;
export const MAX_SEND_HOUR = 21;

export function isSendHour(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_SEND_HOUR && value <= MAX_SEND_HOUR;
}

/** Every hour a manager may pick, for rendering a selector. */
export const SEND_HOUR_CHOICES: number[] = Array.from(
  { length: MAX_SEND_HOUR - MIN_SEND_HOUR + 1 },
  (_, i) => MIN_SEND_HOUR + i,
);

export interface CompanySchedule {
  sendHour: number;
  enabled: boolean;
  /** False when this is the built-in default rather than a stored choice. */
  chosen: boolean;
}

export type ScheduleMap = Map<string, CompanySchedule>;

/**
 * Every stored schedule for one job kind, across the estate, in ONE read.
 *
 * Per-company rather than per-invocation because the cron runs across tenants
 * and a query per company would turn an hourly heartbeat into N queries an
 * hour for nothing.
 *
 * ⚠ DEGRADES, NEVER THROWS. A deploy landing before 0036 answers 42P01
 * ("relation does not exist"), and the only safe reading of that is "nobody has
 * chosen anything", i.e. the built-in defaults — which is byte-identical to the
 * product before this feature. Throwing here would take the whole morning down
 * for every company over a table that, on the day it ships, is empty. The
 * failure is logged rather than swallowed, so "the schedule screen does
 * nothing" stays a greppable fact rather than a mystery.
 */
export async function readCompanySchedules(db: Db, jobKind: JobKind): Promise<ScheduleMap> {
  const map: ScheduleMap = new Map();
  const { data, error } = await db
    .from('company_schedules')
    .select('company_id, send_hour, enabled')
    .eq('job_kind', jobKind);
  if (error) {
    logEvent('schedule.read_failed', { jobKind, error: error.message, code: error.code });
    return map;
  }
  for (const row of data ?? []) {
    // A row whose hour is out of range should not be able to exist — the CHECK
    // constraint refuses it — but a restore, a hand-edit or a future widening
    // of the constraint could produce one, and an out-of-range hour here means
    // a send that either never fires or fires past midnight. Falling back to
    // the default is the safe reading, and it is logged.
    if (!isSendHour(row.send_hour)) {
      logEvent('schedule.hour_out_of_range', {
        companyId: row.company_id,
        jobKind,
        sendHour: row.send_hour,
      });
      continue;
    }
    map.set(row.company_id, { sendHour: row.send_hour, enabled: row.enabled, chosen: true });
  }
  return map;
}

/** What this company's send is aimed at — their choice, or the built-in default. */
export function scheduleFor(map: ScheduleMap, companyId: string, jobKind: JobKind): CompanySchedule {
  return (
    map.get(companyId) ?? { sendHour: DEFAULT_SEND_HOURS[jobKind], enabled: true, chosen: false }
  );
}

/**
 * The window a schedule opens, as a pair of Lisbon hours, for display.
 *
 * Rendered on /perfil/automacoes so the manager reads "between 07:00 and 08:59"
 * rather than "07:00" — because "07:00" is what he read on 13 August, and the
 * message arrived at 07:49. Stating the window is how the product stops
 * promising a precision the platform does not have.
 */
export function scheduleWindow(sendHour: number): { from: number; to: number } {
  return { from: sendHour, to: sendWindowEnd(sendHour, SEND_WINDOW_HOURS) };
}
