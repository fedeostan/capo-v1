// Scheduler & working-day calendar check — the deterministic half of the QA
// gate. Unlike `pnpm agent-smoke`, this needs NO credentials, no network and
// no model: it runs in about a second and can therefore live in CI, which is
// where a silent scheduling regression would otherwise reach production.
//
// It guards the specific bug this file was written for: durations were being
// advanced in CALENDAR days, so every plan was quietly compressed by weekends
// and by the thirteen Portuguese national holidays.
//
// Since #51 it also guards the OTHER schedule in the product — the one Vercel
// runs rather than the one the planner computes. See the send-window section
// at the bottom.
//
// Run with `pnpm scheduler-check`. Exit 0 = green, 1 = at least one failure.

import { readFileSync } from 'node:fs';
import { scheduleTasks } from '@capo/core/capabilities/plan';
// The plan materials checker (issue #119) is pure by the same contract as the
// scheduler above it: no Db, no clock, no model. Its heuristics are asserted
// here because being wrong in EITHER direction is silent — over-flagging
// erodes the warning's credibility, under-flagging is the bug it exists for.
import {
  checkPlanQuality,
  renderPlanWarningLines,
  type PlanQualityTask,
  type PlanWarning,
} from '@capo/core/capabilities/plan-quality';
import {
  addWorkdays,
  countWorkdays,
  isHoliday,
  isWorkday,
  nextWorkday,
  workdayAfter,
  workdayDelta,
} from '@capo/core/capabilities/workdays';
// The crew day link's expiry (issue #114). Same justification as the send-window
// import below: apps/web/lib/day-link.ts is the seam that owns it, it touches no
// env at module scope, and the Lisbon-vs-UTC arithmetic in it is exactly the
// class of defect this file exists to catch.
import { lisbonDayEnd } from '../apps/web/lib/day-link';
// The welcome's TWO quiet-hours gates (issue #45, and the immediate trigger).
// Imported for lib/cron.ts's reason: this is the seam the cron route and the
// immediate trigger both read, it touches no env at module scope, and a copy
// here could drift from the numbers the routes actually run on.
import {
  WELCOME_IMMEDIATE_HOUR,
  WELCOME_IMMEDIATE_WINDOW_HOURS,
  WELCOME_SEND_HOUR,
  WELCOME_WINDOW_HOURS,
  welcomeWindowFor,
} from '../apps/web/lib/welcome-window';
import {
  dependentsClosure,
  recomputeSchedule,
  RescheduleError,
  type ExistingTask,
  type RescheduleChange,
} from '@capo/core/capabilities/reschedule';
// The one import in this file that reaches into an app rather than a package.
// The send window has to live in apps/web/lib/cron.ts — that is the seam the
// two scheduled routes share, and moving it into @capo/core to make this import
// prettier would put it somewhere neither route naturally reads. The module is
// pure enough to load here: it touches no env at module scope and opens no
// connection, so this check still needs no credentials and no network.
import {
  CONSOLIDATE_HOUR,
  CONSOLIDATE_WINDOW_HOURS,
  SEND_WINDOW_HOURS,
  sendWindowEnd,
  withinSendWindow,
} from '../apps/web/lib/cron';
// Same reasoning, and since #51 part B this one is IMPORTED rather than
// restated: the send hour stopped being a module-local const in a route file
// and became data, with its defaults and its legal range in this module. A copy
// here would be a second statement of the range that bounds whether a window
// can wrap past midnight, which is the one number in this file that must not be
// allowed to drift.
import {
  DEFAULT_SEND_HOURS,
  MAX_SEND_HOUR,
  MIN_SEND_HOUR,
  SEND_HOUR_CHOICES,
} from '../apps/web/lib/schedule';
// The working-day window for the immediate assignment note (issue W7).
// IMPORTED rather than restated, for the same reason the send hours are: it is
// the one number that decides whether somebody's phone buzzes while they are
// asleep, and a copy here would be a second statement of it.
import {
  TASK_ASSIGNED_END_HOUR,
  TASK_ASSIGNED_START_HOUR,
  withinAssignmentHours,
} from '../apps/web/lib/task-assigned-window';

let failures = 0;
const lines: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `got ${String(actual)}, want ${String(expected)}`);
}

function weekday(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

// ── calendar ────────────────────────────────────────────────────────────────
eq('nextWorkday skips Sunday', nextWorkday('2026-07-26'), '2026-07-27');
eq('addWorkdays is inclusive of the start day', addWorkdays('2026-07-27', 1), '2026-07-27');
eq('5 working days from Thursday lands on Wednesday', addWorkdays('2026-07-30', 5), '2026-08-05');
eq('workdayAfter Friday is Monday', workdayAfter('2026-07-31'), '2026-08-03');

// Easter-derived holidays (computus): 2026 Easter = 5 Apr, 2027 = 28 Mar.
check('Sexta-feira Santa 2026 (3 Apr) is a holiday', isHoliday('2026-04-03'));
check('Corpo de Deus 2026 (4 Jun) is a holiday', isHoliday('2026-06-04'));
check('Easter 2027 (28 Mar) is a holiday', isHoliday('2027-03-28'));
check('25 de Abril is a holiday', isHoliday('2026-04-25'));
check('Natal is a holiday', isHoliday('2026-12-25'));
check('Carnaval is deliberately NOT a holiday', !isHoliday('2026-02-17'));

// 1 May 2026 is a Friday (Dia do Trabalhador): a span across it must stretch.
eq('span across 1 May 2026 stretches', addWorkdays('2026-04-29', 4), '2026-05-05');

// ── scheduler ───────────────────────────────────────────────────────────────
// A chain with a parallel branch, started on a Friday so weekend handling and
// dependency ordering are both exercised.
const scheduled = scheduleTasks(
  [
    { key: 't1', title: 'Demolição', duration_days: 3 },
    { key: 't2', title: 'Canalização', duration_days: 2, depends_on: ['t1'] },
    { key: 't3', title: 'Eletricidade', duration_days: 2, depends_on: ['t1'] },
    { key: 't4', title: 'Azulejo', duration_days: 4, depends_on: ['t2', 't3'] },
  ],
  '2026-07-31', // a Friday
);

const byKey = new Map(scheduled.map(t => [t.key, t]));
const t1 = byKey.get('t1')!;
const t2 = byKey.get('t2')!;
const t3 = byKey.get('t3')!;
const t4 = byKey.get('t4')!;

eq('every task is scheduled', scheduled.length, 4);
eq('t1 starts on the requested Friday', t1.start_date, '2026-07-31');
eq('t1 (3 working days from Fri) is due Tuesday', t1.due_date, '2026-08-04');
eq('t2 starts the workday after t1', t2.start_date, '2026-08-05');
eq('t3 runs in parallel with t2', t3.start_date, '2026-08-05');
eq('t4 waits for the later of t2/t3', t4.start_date, workdayAfter(t2.due_date > t3.due_date ? t2.due_date : t3.due_date));

check(
  'no task starts or ends on a weekend or holiday',
  scheduled.every(t => isWorkday(t.start_date) && isWorkday(t.due_date)),
  scheduled.map(t => `${t.key}:${t.start_date}→${t.due_date}(${weekday(t.start_date)})`).join(' '),
);
check(
  'every task starts on or after the plan start date',
  scheduled.every(t => t.start_date >= '2026-07-31'),
);
check(
  'every dependency finishes strictly before its dependent starts',
  scheduled.every(t => (t.depends_on ?? []).every(dep => byKey.get(dep)!.due_date < t.start_date)),
);

// A start date that falls on a holiday must roll forward, not schedule work
// on 25 de Abril.
const onHoliday = scheduleTasks([{ key: 'a', title: 'Arranque', duration_days: 1 }], '2026-04-25');
eq('a plan starting on a holiday rolls forward', onHoliday[0].start_date, '2026-04-27');

// ── measuring a span ────────────────────────────────────────────────────────
// countWorkdays is the inverse of addWorkdays and must agree with it exactly,
// or a task with no duration_days (every pre-planner task) gets its length read
// back wrong and the cascade quietly changes how long the work takes.
eq('countWorkdays is inclusive of both ends', countWorkdays('2026-07-27', '2026-07-27'), 1);
eq('countWorkdays skips the weekend', countWorkdays('2026-07-30', '2026-08-05'), 5);
eq('countWorkdays subtracts a weekday holiday', countWorkdays('2026-04-29', '2026-05-05'), 4);
check(
  'countWorkdays inverts addWorkdays for every length 1..40',
  Array.from({ length: 40 }, (_, i) => i + 1).every(n => countWorkdays('2026-04-27', addWorkdays('2026-04-27', n)) === n),
);
eq('workdayDelta is 0 for the same day', workdayDelta('2026-08-04', '2026-08-04'), 0);
eq('workdayDelta Friday → Monday is 1', workdayDelta('2026-07-31', '2026-08-03'), 1);
eq('workdayDelta is signed when pulled earlier', workdayDelta('2026-08-13', '2026-08-12'), -1);
eq('workdayDelta counts across a weekend', workdayDelta('2026-08-13', '2026-08-17'), 2);

// ── cascade reschedule ──────────────────────────────────────────────────────
// The highest-risk pure function in the repo: it proposes moving dates on a
// LIVE job, and nothing else in CI can catch it being wrong.
//
// Fixture — one job, the classic diamond. A is the trigger; every date below
// is a plain Mon–Fri week (Assunção 2026 falls on a Saturday, so August has no
// holiday in the way).
//
//   A Demolição  Mon 03 – Wed 05   done
//   ├── B Canalização  Thu 06 – Fri 07   pending (2d)
//   ├── C Eletricidade Thu 06 – Fri 07   pending (2d)
//   └──────┴── D Azulejo  Mon 10 – Thu 13   pending (4d)

const TRIGGER = 'A';
function task(over: Partial<ExistingTask> & { id: string }): ExistingTask {
  return {
    status: 'pending',
    start_date: null,
    due_date: null,
    duration_days: null,
    depends_on_task_ids: [],
    ...over,
  };
}

const diamond: ExistingTask[] = [
  task({ id: 'A', status: 'done', start_date: '2026-08-03', due_date: '2026-08-05', duration_days: 3 }),
  task({ id: 'B', start_date: '2026-08-06', due_date: '2026-08-07', duration_days: 2, depends_on_task_ids: ['A'] }),
  task({ id: 'C', start_date: '2026-08-06', due_date: '2026-08-07', duration_days: 2, depends_on_task_ids: ['A'] }),
  task({ id: 'D', start_date: '2026-08-10', due_date: '2026-08-13', duration_days: 4, depends_on_task_ids: ['B', 'C'] }),
];
const diamondEdges = [
  { task_id: 'B', depends_on_task_id: 'A' },
  { task_id: 'C', depends_on_task_id: 'A' },
  { task_id: 'D', depends_on_task_id: 'B' },
  { task_id: 'D', depends_on_task_id: 'C' },
];

function byTask(changes: RescheduleChange[]): Map<string, RescheduleChange> {
  return new Map(changes.map(c => [c.task_id, c]));
}

// dependents closure — what the caller uses to decide what may move at all.
const closure = dependentsClosure(diamondEdges, [TRIGGER]);
check('closure reaches every dependent of the trigger', ['B', 'C', 'D'].every(id => closure.has(id)));
check('closure excludes the trigger itself', !closure.has(TRIGGER));
eq('closure of a graph with no edges is empty', dependentsClosure([], [TRIGGER]).size, 0);
check(
  'closure terminates on a cyclic edge set',
  dependentsClosure(
    [
      { task_id: 'y', depends_on_task_id: 'x' },
      { task_id: 'x', depends_on_task_id: 'y' },
    ],
    ['x'],
  ).has('y'),
);

// Early finish: A was due Wed 05 but finished Tue 04, so everything downstream
// pulls in by one working day.
const early = byTask(
  recomputeSchedule({
    tasks: diamond,
    today: '2026-08-04',
    completedOn: { A: '2026-08-04' },
    movable: new Set(['B', 'C', 'D']),
  }),
);
eq('early finish: B starts the workday after the ACTUAL finish', early.get('B')?.to.start_date, '2026-08-05');
eq('early finish: B is due 2 working days later', early.get('B')?.to.due_date, '2026-08-06');
eq('early finish: C runs in parallel with B', early.get('C')?.to.start_date, '2026-08-05');
eq('early finish: D waits for the later of B/C', early.get('D')?.to.start_date, '2026-08-07');
eq('early finish: D is due 4 working days later', early.get('D')?.to.due_date, '2026-08-12');
eq('early finish: D is pulled in by 1 working day', early.get('D')?.shift_days, -1);
eq('early finish: the trigger itself is never rewritten', early.get('A'), undefined);
check('early finish: nothing is proposed in the past', [...early.values()].every(c => c.to.start_date >= '2026-08-04'));

// Late finish: A slipped to Fri 07, so everything downstream pushes out.
const late = byTask(
  recomputeSchedule({
    tasks: diamond,
    today: '2026-08-07',
    completedOn: { A: '2026-08-07' },
    movable: new Set(['B', 'C', 'D']),
  }),
);
eq('late finish: B starts the following Monday', late.get('B')?.to.start_date, '2026-08-10');
eq('late finish: D is due a week later than planned', late.get('D')?.to.due_date, '2026-08-17');
eq('late finish: D is pushed out by 2 working days', late.get('D')?.shift_days, 2);

// Nothing outside `movable` may ever be written — the specific way
// scheduleTasks would have destroyed a live job.
const partial = recomputeSchedule({
  tasks: diamond,
  today: '2026-08-04',
  completedOn: { A: '2026-08-04' },
  movable: new Set(['B']),
});
check('only movable tasks are ever emitted', partial.every(c => c.task_id === 'B'));
eq(
  'an empty movable set produces no changes',
  recomputeSchedule({ tasks: diamond, today: '2026-08-04', completedOn: {}, movable: new Set() }).length,
  0,
);
eq(
  'a job with no dependency edges cascades to nothing',
  recomputeSchedule({
    tasks: [task({ id: 'A', status: 'done' }), task({ id: 'Z', start_date: '2026-09-01', due_date: '2026-09-04' })],
    today: '2026-08-04',
    completedOn: { A: '2026-08-04' },
    // dependentsClosure returned nothing, so the caller marks nothing movable.
    movable: new Set(),
  }).length,
  0,
);

// A cancelled predecessor must not hold a successor back. X is cancelled with a
// due date two months out; D must ignore it entirely and follow A.
const withCancelled: ExistingTask[] = [
  task({ id: 'A', status: 'done', start_date: '2026-08-03', due_date: '2026-08-05', duration_days: 3 }),
  task({ id: 'X', status: 'cancelled', start_date: '2026-09-28', due_date: '2026-09-30', depends_on_task_ids: ['A'] }),
  task({ id: 'D', start_date: '2026-10-01', due_date: '2026-10-02', duration_days: 2, depends_on_task_ids: ['A', 'X'] }),
];
const cancelledDep = byTask(
  recomputeSchedule({
    tasks: withCancelled,
    today: '2026-08-04',
    completedOn: { A: '2026-08-04' },
    movable: new Set(['D']),
  }),
);
eq('a cancelled predecessor does not hold a successor back', cancelledDep.get('D')?.to.start_date, '2026-08-05');

// …and when EVERY predecessor is cancelled the task becomes an effective root
// and floors at today, rather than inheriting a date from work that will never
// happen.
const allCancelled = byTask(
  recomputeSchedule({
    tasks: [
      task({ id: 'A', status: 'done', due_date: '2026-08-05' }),
      task({ id: 'X', status: 'cancelled', due_date: '2026-09-30', depends_on_task_ids: ['A'] }),
      task({ id: 'D', start_date: '2026-10-01', due_date: '2026-10-02', duration_days: 2, depends_on_task_ids: ['X'] }),
    ],
    today: '2026-08-04',
    completedOn: { A: '2026-08-04' },
    movable: new Set(['D']),
  }),
);
eq('all-cancelled dependencies floor the task at today', allCancelled.get('D')?.to.start_date, '2026-08-04');

// A task already under way keeps its start: moving it would be a lie about the
// site. Only its finish is recomputed, and successors follow the new finish.
const started = byTask(
  recomputeSchedule({
    tasks: [
      task({ id: 'A', status: 'done', due_date: '2026-08-05', duration_days: 3 }),
      task({
        id: 'B',
        status: 'in_progress',
        start_date: '2026-08-03',
        due_date: '2026-08-07',
        duration_days: 2,
        depends_on_task_ids: ['A'],
      }),
      task({ id: 'D', start_date: '2026-08-10', due_date: '2026-08-11', duration_days: 2, depends_on_task_ids: ['B'] }),
    ],
    today: '2026-08-04',
    completedOn: { A: '2026-08-04' },
    movable: new Set(['B', 'D']),
  }),
);
eq('an in_progress task keeps the start it actually began on', started.get('B')?.to.start_date, '2026-08-03');
eq('an in_progress task still has its finish recomputed', started.get('B')?.to.due_date, '2026-08-04');
eq('a successor follows the in_progress finish', started.get('D')?.to.start_date, '2026-08-05');

// …but a pinned start must never produce a deadline in the past. B began three
// weeks ago with only 2 days recorded against it; recomputing naively would
// propose a due date before today, i.e. instantly overdue.
const longRunning = byTask(
  recomputeSchedule({
    tasks: [
      task({ id: 'A', status: 'done', due_date: '2026-08-05' }),
      task({
        id: 'B',
        status: 'in_progress',
        start_date: '2026-07-13',
        due_date: '2026-08-20',
        duration_days: 2,
        depends_on_task_ids: ['A'],
      }),
    ],
    today: '2026-08-04',
    completedOn: { A: '2026-08-04' },
    movable: new Set(['B']),
  }),
);
eq('a long-running in_progress task is never given a past deadline', longRunning.get('B')?.to.due_date, '2026-08-04');
eq('…and still keeps the start it began on', longRunning.get('B')?.to.start_date, '2026-07-13');

// A task that has never been scheduled (start_date null — the board falls back
// to created_at) gets concrete dates and renders its "before" as a blank.
const unscheduled = byTask(
  recomputeSchedule({
    tasks: [
      task({ id: 'A', status: 'done', due_date: '2026-08-05' }),
      task({ id: 'U', duration_days: 3, depends_on_task_ids: ['A'] }),
    ],
    today: '2026-08-04',
    completedOn: { A: '2026-08-04' },
    movable: new Set(['U']),
  }),
);
eq('an unscheduled task gets a start', unscheduled.get('U')?.to.start_date, '2026-08-05');
eq('an unscheduled task reports no prior dates', unscheduled.get('U')?.from.due_date, null);
eq('an unscheduled task reports a zero shift rather than a fake one', unscheduled.get('U')?.shift_days, 0);

// duration_days is nullable (0010): a pre-planner task must keep the length it
// visibly has on the board rather than collapsing to a single day.
const noDuration = byTask(
  recomputeSchedule({
    tasks: [
      task({ id: 'A', status: 'done', due_date: '2026-08-05' }),
      // Mon 10 → Thu 13 is four working days, with no duration_days recorded.
      task({ id: 'N', start_date: '2026-08-10', due_date: '2026-08-13', depends_on_task_ids: ['A'] }),
    ],
    today: '2026-08-04',
    completedOn: { A: '2026-08-04' },
    movable: new Set(['N']),
  }),
);
eq('a task with no duration_days keeps its existing span', noDuration.get('N')?.to.due_date, '2026-08-10');

// A cycle must be REFUSED, never silently resolved. task_dependencies has no
// anti-cycle constraint in SQL, so nothing upstream has ever checked this.
let cycleThrew = false;
try {
  recomputeSchedule({
    tasks: [
      task({ id: 'p', due_date: '2026-08-05', depends_on_task_ids: ['q'] }),
      task({ id: 'q', due_date: '2026-08-05', depends_on_task_ids: ['p'] }),
    ],
    today: '2026-08-04',
    completedOn: {},
    movable: new Set(['p', 'q']),
  });
} catch (e) {
  cycleThrew = e instanceof RescheduleError;
}
check('a dependency cycle throws RescheduleError', cycleThrew);

let selfCycleThrew = false;
try {
  recomputeSchedule({
    tasks: [task({ id: 's', due_date: '2026-08-05', depends_on_task_ids: ['s'] })],
    today: '2026-08-04',
    completedOn: {},
    movable: new Set(['s']),
  });
} catch (e) {
  selfCycleThrew = e instanceof RescheduleError;
}
check('a self-dependency throws RescheduleError', selfCycleThrew);

// ── the cron send window (#51) ──────────────────────────────────────────────
// A different schedule from everything above: not the one the planner computes
// for a job, but the one Vercel runs the two daily WhatsApp sends on.
//
// The bug being guarded is total silence. Both routes used to demand
// `lisbonHour === SEND_HOUR`, which survives only while Vercel's cron dispatch
// is under 60 minutes late — and on this project it was measured at 45, 45, 33
// and 49 minutes on 9/10/11/13 August 2026. Eleven minutes from the edge. Past
// it, the route answers 200 with {skipped}, writes no notification_log row,
// raises no error, and the whole crew hears nothing on a morning that looks
// completely healthy from every surface in the product.
//
// Nothing else in the repo can catch a regression here: there are no route
// tests, and the symptom in production is an absence rather than a failure.

// The DEFAULTS, not constants any more (issue #51 part B). Every company uses
// these until a manager moves them on /perfil/automacoes, so they are still the
// hours the whole estate runs on today — but the sweep below deliberately
// checks the vercel.json heartbeat against EVERY legal hour rather than only
// these two, because a schedule that only worked at 07:00 would look perfectly
// healthy right up until somebody used the feature.
const BRIEFING_HOUR = DEFAULT_SEND_HOURS.daily_briefing;
const CHECKIN_HOUR = DEFAULT_SEND_HOURS.task_checkin;

eq('the briefing still defaults to 07:00 Lisbon', BRIEFING_HOUR, 7);
eq('the check-in still defaults to 16:00 Lisbon', CHECKIN_HOUR, 16);

eq('the send window is two Lisbon hours wide', SEND_WINDOW_HOURS, 2);
eq('the 07:00 briefing window ends at Lisbon 08', sendWindowEnd(BRIEFING_HOUR), 8);
eq('the late-afternoon check-in window ends at Lisbon 17', sendWindowEnd(CHECKIN_HOUR), 17);

check('the briefing sends on time, at Lisbon 07', withinSendWindow(BRIEFING_HOUR, BRIEFING_HOUR));
check('the check-in sends on time, at Lisbon 16', withinSendWindow(CHECKIN_HOUR, CHECKIN_HOUR));

// ⚠ THE REGRESSION THIS WHOLE ISSUE EXISTS FOR. A dispatch 49 minutes late that
// spills over into the NEXT Lisbon hour must still send. Before #51 both of
// these were false and the crew got nothing.
check(
  'a 49-minutes-late briefing dispatch that lands in the next Lisbon hour (08) still sends',
  withinSendWindow(BRIEFING_HOUR + 1, BRIEFING_HOUR),
);
check(
  'a 49-minutes-late check-in dispatch that lands in the next Lisbon hour (17) still sends',
  withinSendWindow(CHECKIN_HOUR + 1, CHECKIN_HOUR),
);

// The other direction is the reason the gate exists at all: a "bom dia, aqui
// está o teu dia" arriving in the evening is worse than no message.
check('two hours late is too late for the briefing (Lisbon 09)', !withinSendWindow(BRIEFING_HOUR + 2, BRIEFING_HOUR));
check('two hours late is too late for the check-in (Lisbon 18)', !withinSendWindow(CHECKIN_HOUR + 2, CHECKIN_HOUR));
check('the briefing never sends early (Lisbon 06)', !withinSendWindow(BRIEFING_HOUR - 1, BRIEFING_HOUR));
check('the check-in never sends early (Lisbon 15)', !withinSendWindow(CHECKIN_HOUR - 1, CHECKIN_HOUR));

// Clamped at 23, never wrapped. A window that wrapped past midnight would make
// lisbon_today() roll over, which turns notification_log's unique constraint
// from an idempotency lock into a fresh unclaimed day and messages everybody a
// second time.
eq('a 22:00 send hour still gets its second hour', sendWindowEnd(22), 23);
eq('a 23:00 send hour is clamped rather than wrapped', sendWindowEnd(23), 23);
check('a 23:00 send hour still accepts its own hour', withinSendWindow(23, 23));
check('a 23:00 send hour does NOT spill into hour 0 the next day', !withinSendWindow(0, 23));

// ── the legal range of a chosen send hour (issue #51, part B1) ──────────────
// The send hour is DATA now — a manager picks it on /perfil/automacoes — so the
// dangerous number is no longer "7", it is the RANGE. Two properties matter and
// neither is obvious from the screen:
//
//   * no chosen hour may produce a window that wraps past midnight. A wrapped
//     run rolls lisbon_today() over, which turns notification_log's unique
//     constraint from an idempotency lock into a fresh unclaimed day and
//     messages the entire crew a second time — a DOUBLE-BILLED send, silently.
//   * no chosen hour may be in the middle of the night.
//
// Both are also CHECK constraints in 0036. Asserted here from the constants the
// app actually reads, so widening one without the other fails on the next PR.
check(
  'no legal send hour can produce a window that wraps past midnight',
  SEND_HOUR_CHOICES.every(h => sendWindowEnd(h) <= 23 && sendWindowEnd(h) >= h),
  `MAX_SEND_HOUR ${MAX_SEND_HOUR} → window ends ${sendWindowEnd(MAX_SEND_HOUR)}`,
);
check(
  'the latest legal send hour still gets its full window',
  sendWindowEnd(MAX_SEND_HOUR) === MAX_SEND_HOUR + SEND_WINDOW_HOURS - 1,
  `${MAX_SEND_HOUR} → ${sendWindowEnd(MAX_SEND_HOUR)}`,
);
check('no send may be aimed at the small hours', MIN_SEND_HOUR >= 5, `MIN_SEND_HOUR ${MIN_SEND_HOUR}`);
check(
  'both defaults are inside the range a manager may choose',
  SEND_HOUR_CHOICES.includes(BRIEFING_HOUR) && SEND_HOUR_CHOICES.includes(CHECKIN_HOUR),
  `choices ${MIN_SEND_HOUR}..${MAX_SEND_HOUR}`,
);

// ── the UTC entries that feed the window ────────────────────────────────────
// vercel.json is the other half of the mechanism and is JSON, so nothing in it
// can explain itself and nothing in CI reads it.
//
// It used to name the exact UTC hours each route needed — the union over both
// DST offsets, hand-computed from a fixed SEND_HOUR. That is no longer possible:
// vercel.json is baked into the deployment and cannot know what hour any tenant
// chose. Both hour-gated routes are an HOURLY HEARTBEAT now, and the sweep below
// proves the property that replaces the old table — that for EVERY hour a
// manager may pick, in BOTH seasons, an entry lands exactly on it.

interface CronEntry {
  path: string;
  schedule: string;
}

const crons = (
  JSON.parse(readFileSync(new URL('../apps/web/vercel.json', import.meta.url), 'utf8')) as {
    crons: CronEntry[];
  }
).crons;

/**
 * The UTC hours one path actually fires at.
 *
 * Deliberately narrow: it understands `0 *` and `0 H` and `0 A,B` and NOTHING
 * else. A step or a range (`4-22`) in the hour field would silently parse as
 * NaN and turn every assertion below into a vacuous pass, which is the failure
 * mode this whole file exists to prevent — so an unrecognised field is a loud
 * failure rather than a clever parse.
 */
function scheduledUtcHours(path: string): number[] {
  const entries = crons.filter(c => c.path === path);
  check(`${path} has at least one schedule`, entries.length > 0);
  const hours: number[] = [];
  for (const entry of entries) {
    const [minute, hour] = entry.schedule.split(' ');
    // The :00 rule (AGENTS.md). A :30 entry has thirty minutes of headroom
    // before the Lisbon hour rolls over instead of sixty, and that is exactly
    // how the check-in shipped and then never sent a single message. `0 * * * *`
    // satisfies it by construction; a half-hourly heartbeat would not.
    check(`${path} "${entry.schedule}" fires at :00`, minute === '0', `minute field is "${minute}"`);
    if (hour === '*') {
      for (let h = 0; h < 24; h += 1) hours.push(h);
      continue;
    }
    const parts = hour.split(',');
    const parsed = parts.map(Number);
    check(
      `${path} "${entry.schedule}" has an hour field this check can read`,
      parsed.every(h => Number.isInteger(h) && h >= 0 && h < 24),
      `hour field is "${hour}" — ranges and steps are not supported here on purpose`,
    );
    hours.push(...parsed.filter(h => Number.isInteger(h) && h >= 0 && h < 24));
  }
  return hours;
}

const SEASONS = [
  ['winter (UTC+0)', 0],
  ['summer (UTC+1)', 1],
] as const;

for (const path of ['/api/cron/reminders', '/api/cron/checkin'] as const) {
  const utcHours = scheduledUtcHours(path);
  for (const [season, offset] of SEASONS) {
    const lisbonHours = utcHours.map(h => (h + offset) % 24);
    // The whole property, in one assertion per season: whatever hour a manager
    // chooses, an entry lands exactly on it (so the send starts the day with
    // its FULL window of drift headroom, not one hour into it) and a second
    // entry lands inside the window behind it (so a dispatch late enough to
    // miss the first still has a second chance).
    const uncovered = SEND_HOUR_CHOICES.filter(sendHour => !lisbonHours.includes(sendHour));
    check(
      `${path} has an entry landing ON the target hour in ${season}, for every hour a manager may pick`,
      uncovered.length === 0,
      uncovered.length ? `uncovered target hours: [${uncovered.join(', ')}]` : `${MIN_SEND_HOUR}..${MAX_SEND_HOUR} all covered`,
    );
    const thin = SEND_HOUR_CHOICES.filter(
      sendHour => lisbonHours.filter(h => withinSendWindow(h, sendHour)).length < 2,
    );
    check(
      `${path} has a SECOND in-window entry behind every target hour in ${season}`,
      thin.length === 0,
      thin.length ? `single-entry target hours: [${thin.join(', ')}]` : 'every window carries two entries',
    );
  }
}

// The push sweep is deliberately NOT in this scheme: it has no hour gate and is
// meant to run all day, so giving it one would be the check-in bug again.
const pushEntries = crons.filter(c => c.path === '/api/cron/push');
eq('/api/cron/push is scheduled exactly once', pushEntries.length, 1);
eq('/api/cron/push still runs all day, ungated', pushEntries[0]?.schedule, '*/10 * * * *');

// ── the welcome sweep (issue #45) ───────────────────────────────────────────
// The THIRD shape in the product, and it is neither of the other two. Unlike
// the daily sends it has no correct time — it fires whenever somebody was
// added — but unlike the push sweep it must not run all night: a first-ever
// message from an unknown business number at 03:00 is how that number earns a
// block report.
//
// So it carries a WIDE gate (Lisbon 09:00-19:59) fed by a minute-based
// schedule, which is why the "one UTC entry per window hour under both DST
// offsets" sweep above does not apply to it: every quarter of an hour covers
// every hour in every season by construction.
//
// Since the immediate trigger landed there are TWO of these windows, and they
// are IMPORTED rather than re-declared — apps/web/lib/welcome-window.ts is the
// seam both the cron and the trigger read, it touches no env at module scope,
// and having the pair in one place is what stops somebody widening the sweep
// while leaving the trigger where it was.
const WELCOME_HOUR = WELCOME_SEND_HOUR;

eq('the welcome window ends at Lisbon 19', sendWindowEnd(WELCOME_HOUR, WELCOME_WINDOW_HOURS), 19);
check('a welcome may go out at 09', withinSendWindow(WELCOME_HOUR, WELCOME_HOUR, WELCOME_WINDOW_HOURS));
check('a welcome may still go out at 19', withinSendWindow(19, WELCOME_HOUR, WELCOME_WINDOW_HOURS));
// The two directions quiet hours exist for. Nobody's first ever contact from
// Capo arrives while they are asleep.
check('no welcome at 20:00', !withinSendWindow(20, WELCOME_HOUR, WELCOME_WINDOW_HOURS));
check('no welcome at 03:00', !withinSendWindow(3, WELCOME_HOUR, WELCOME_WINDOW_HOURS));
// Starts AFTER the 07:00 briefing's own window (07–08) closes, so a crew member
// added overnight cannot be welcomed and briefed inside the same hour in an
// order nobody chose.
check(
  'the welcome window opens only after the briefing window has closed',
  WELCOME_HOUR > sendWindowEnd(BRIEFING_HOUR),
  `welcome starts at ${WELCOME_HOUR}, briefing window ends at ${sendWindowEnd(BRIEFING_HOUR)}`,
);

const welcomeEntries = crons.filter(c => c.path === '/api/cron/welcome');
eq('/api/cron/welcome is scheduled exactly once', welcomeEntries.length, 1);
eq('/api/cron/welcome sweeps every 15 minutes', welcomeEntries[0]?.schedule, '*/15 * * * *');
// The eleven-hour window is what makes a minute-based schedule safe here. If
// somebody narrows the window toward the one-hour shape of the daily sends, the
// ":00, never :30" rule starts applying again and this entry becomes the
// check-in bug — so the two facts are asserted together.
check(
  'the welcome window is wide enough that cron drift cannot close it',
  WELCOME_WINDOW_HOURS >= 4,
  `${WELCOME_WINDOW_HOURS} hours`,
);

// ── the immediate assignment note (issue W7) ────────────────────────────────
// The FIFTH shape, and the first that is triggered by a MANAGER's action rather
// than by a clock. It has no target hour at all: it fires whenever somebody is
// put on a task. What it has instead is a WORKING DAY, and the whole point of
// the gate is the two ends of it — nobody's phone buzzes about tiling at 23:40,
// and nothing is announced as "today's work" once today is over.

eq('the assignment note may not go out before 08', withinAssignmentHours(7), false);
check('an assignment at 08 is announced', withinAssignmentHours(TASK_ASSIGNED_START_HOUR));
check('and so is one at 18', withinAssignmentHours(TASK_ASSIGNED_END_HOUR));
check('but not one at 19', !withinAssignmentHours(19));
check('and certainly not one at 03', !withinAssignmentHours(3));
check('nor at 23', !withinAssignmentHours(23));

// It opens only after the 07:00 briefing's own target hour, so an assignment
// made first thing cannot land in the same hour as the morning message and read
// as two Capos talking over each other.
check(
  'the assignment window opens after the briefing hour',
  TASK_ASSIGNED_START_HOUR > BRIEFING_HOUR,
  `assignment starts at ${TASK_ASSIGNED_START_HOUR}, briefing targets ${BRIEFING_HOUR}`,
);
// And it closes before the latest hour a manager may aim a scheduled send at,
// so the two never contend for the same 300-second function ceiling at the far
// end of the day.
check(
  'the assignment window closes before the latest legal send hour',
  TASK_ASSIGNED_END_HOUR < MAX_SEND_HOUR,
  `assignment ends at ${TASK_ASSIGNED_END_HOUR}, MAX_SEND_HOUR is ${MAX_SEND_HOUR}`,
);
// Wide enough that Vercel's measured 33-49 minutes of cron dispatch drift can
// cost lateness but never silence — the same >= 4 shape the welcome sweep uses,
// and the same reason AGENTS.md's ":00, never :30" rule does not bind here.
check(
  'the assignment window is wide enough that cron drift cannot close it',
  TASK_ASSIGNED_END_HOUR - TASK_ASSIGNED_START_HOUR + 1 >= 4,
  `${TASK_ASSIGNED_END_HOUR - TASK_ASSIGNED_START_HOUR + 1} hours`,
);

const assignedEntries = crons.filter(c => c.path === '/api/cron/task-assigned');
eq('/api/cron/task-assigned is scheduled exactly once', assignedEntries.length, 1);
eq('/api/cron/task-assigned sweeps every 15 minutes', assignedEntries[0]?.schedule, '*/15 * * * *');

// ── the IMMEDIATE welcome's own window ──────────────────────────────────────
// The second gate, and the reason there are two. A manager who has just typed
// somebody's number into Capo is standing next to them, on site, at whatever
// hour a construction day actually runs — before the vans leave, or when the
// paperwork gets done. Making that person wait until 09:00 tomorrow because
// their manager added them at 20:15 is the exact complaint the trigger answers.
//
// It is therefore WIDER AT BOTH ENDS than the sweep's, and that relationship is
// asserted rather than described: collapsing the two into one number is the
// change that would silently take the evening half of the feature away.
eq('the immediate welcome window ends at Lisbon 21', sendWindowEnd(WELCOME_IMMEDIATE_HOUR, WELCOME_IMMEDIATE_WINDOW_HOURS), 21);
check(
  'an immediate welcome may go out at 08, an hour before the sweep opens',
  withinSendWindow(8, WELCOME_IMMEDIATE_HOUR, WELCOME_IMMEDIATE_WINDOW_HOURS) &&
    !withinSendWindow(8, WELCOME_HOUR, WELCOME_WINDOW_HOURS),
);
check(
  'and at 21, two hours after the sweep closes',
  withinSendWindow(21, WELCOME_IMMEDIATE_HOUR, WELCOME_IMMEDIATE_WINDOW_HOURS) &&
    !withinSendWindow(21, WELCOME_HOUR, WELCOME_WINDOW_HOURS),
);
// The two directions quiet hours exist for. Nobody's first ever contact from
// Capo arrives while they are asleep, however fast their manager types.
check('no immediate welcome at 22:00', !withinSendWindow(22, WELCOME_IMMEDIATE_HOUR, WELCOME_IMMEDIATE_WINDOW_HOURS));
check('no immediate welcome at 03:00', !withinSendWindow(3, WELCOME_IMMEDIATE_HOUR, WELCOME_IMMEDIATE_WINDOW_HOURS));
// ⚠ IT OVERLAPS THE BRIEFING'S DRIFT TAIL BY EXACTLY ONE HOUR, KNOWINGLY.
// The sweep starts at 09 so a crew member added OVERNIGHT cannot be welcomed
// and briefed inside the same hour in an order nobody chose. The immediate
// trigger cannot be swept up in that: it only ever fires because a manager did
// something a moment ago, so at 08:00 the 07:00 briefing has already gone (08
// is the drift tail, not the target). What is genuinely possible is a crew
// member added at 08:05 reading their tasks and then, a minute later, an
// introduction — the same cosmetic misordering /api/cron/welcome already
// records as known-and-not-fixed, reachable one hour earlier.
//
// Two properties are pinned instead of the sweep's, and the second is the one
// that matters: the immediate window must never open at or before the
// briefing's TARGET hour, where the two sends would genuinely collide.
check(
  'the immediate window opens after the briefing has been SENT, not merely scheduled',
  WELCOME_IMMEDIATE_HOUR > BRIEFING_HOUR,
  `immediate starts at ${WELCOME_IMMEDIATE_HOUR}, the briefing targets ${BRIEFING_HOUR}`,
);
check(
  'and overlaps the briefing window by at most its drift tail',
  sendWindowEnd(BRIEFING_HOUR) - WELCOME_IMMEDIATE_HOUR <= 0,
  `immediate ${WELCOME_IMMEDIATE_HOUR}, briefing window ends ${sendWindowEnd(BRIEFING_HOUR)}`,
);
// The containment property, in both directions and derived rather than pinned:
// every hour the sweep may send in, the trigger may too. If it were ever
// otherwise, a person added inside the sweep's window would be refused by the
// trigger and then picked up minutes later by the cron anyway — a gap nobody
// could see and nobody would report.
for (let hour = 0; hour <= 23; hour += 1) {
  if (!withinSendWindow(hour, WELCOME_HOUR, WELCOME_WINDOW_HOURS)) continue;
  check(
    `the immediate trigger may also send at Lisbon ${hour}`,
    withinSendWindow(hour, WELCOME_IMMEDIATE_HOUR, WELCOME_IMMEDIATE_WINDOW_HOURS),
  );
}
// And the no-wrap property the whole family depends on: sendWindowEnd clamps at
// 23, and a window that wrapped past midnight would roll lisbon_today() over
// and make the once-ever ledger read a fresh unclaimed day.
check(
  'neither welcome window can wrap past midnight',
  sendWindowEnd(WELCOME_IMMEDIATE_HOUR, WELCOME_IMMEDIATE_WINDOW_HOURS) <= 23 &&
    WELCOME_IMMEDIATE_HOUR + WELCOME_IMMEDIATE_WINDOW_HOURS - 1 <= 23,
);
eq('welcomeWindowFor gives the cron its own hours', welcomeWindowFor('cron').sendHour, WELCOME_SEND_HOUR);
eq('and the immediate path its own', welcomeWindowFor('immediate').sendHour, WELCOME_IMMEDIATE_HOUR);
eq('and the widths do not cross over', welcomeWindowFor('cron').windowHours, WELCOME_WINDOW_HOURS);
eq('either', welcomeWindowFor('immediate').windowHours, WELCOME_IMMEDIATE_WINDOW_HOURS);

// ── the nightly memory review (issue #48) ───────────────────────────────────
// The FOURTH shape, and the first that sends nothing to anybody. It still has
// an hour gate, because reviewing a day only makes sense once the day has
// finished — but the gate is four Lisbon hours wide and, crucially, the pass
// carries a WATERMARK (memory_consolidations.covers_until_at), so a night it
// misses is covered by the next one. That is what makes an hour gate acceptable
// here at all: the failure mode is lateness, not the silence that was eleven
// minutes from taking the crew's morning on 13 August 2026.
//
// Unlike WELCOME_HOUR above, these are IMPORTED rather than re-declared: they
// live in lib/cron.ts precisely so this file and the route cannot drift.
eq('the nightly review window ends at Lisbon 04', sendWindowEnd(CONSOLIDATE_HOUR, CONSOLIDATE_WINDOW_HOURS), 4);
check(
  'the nightly review may run at its target hour',
  withinSendWindow(CONSOLIDATE_HOUR, CONSOLIDATE_HOUR, CONSOLIDATE_WINDOW_HOURS),
);
check(
  'the nightly review still runs two hours late',
  withinSendWindow(4, CONSOLIDATE_HOUR, CONSOLIDATE_WINDOW_HOURS),
);
// The direction the gate exists for: never while the manager is using Capo.
check('no nightly review at 05:00', !withinSendWindow(5, CONSOLIDATE_HOUR, CONSOLIDATE_WINDOW_HOURS));
check('no nightly review at 06:00', !withinSendWindow(6, CONSOLIDATE_HOUR, CONSOLIDATE_WINDOW_HOURS));
check('no nightly review at 14:00', !withinSendWindow(14, CONSOLIDATE_HOUR, CONSOLIDATE_WINDOW_HOURS));
check('no nightly review at 01:00', !withinSendWindow(1, CONSOLIDATE_HOUR, CONSOLIDATE_WINDOW_HOURS));
// The window must close before the EARLIEST hour a manager may aim a send at,
// or a company could be mid-consolidation while its crew is being messaged —
// two jobs contending for the same 300-second ceiling, one of them paid. This
// assertion is not decoration: it is what caught the first version of this
// window, which ran 02–05 and touched MIN_SEND_HOUR exactly.
check(
  'the nightly review closes before the earliest legal send hour',
  sendWindowEnd(CONSOLIDATE_HOUR, CONSOLIDATE_WINDOW_HOURS) < MIN_SEND_HOUR,
  `review ends at ${sendWindowEnd(CONSOLIDATE_HOUR, CONSOLIDATE_WINDOW_HOURS)}, sends may start at ${MIN_SEND_HOUR}`,
);
// The window never wraps past midnight, for the same reason the sends' never
// does — lisbon_today() would roll over and the (company_id, run_date) claim
// would read as a fresh unclaimed night.
check(
  'the nightly review window cannot wrap past midnight',
  CONSOLIDATE_HOUR + CONSOLIDATE_WINDOW_HOURS - 1 <= 23,
  `${CONSOLIDATE_HOUR}..${sendWindowEnd(CONSOLIDATE_HOUR, CONSOLIDATE_WINDOW_HOURS)}`,
);
// Wide enough that Vercel's measured 33–49 minutes of dispatch drift cannot
// close it. Asserted with the same >= 4 shape the welcome sweep uses… except
// this one is bounded ABOVE by MIN_SEND_HOUR, so the honest floor here is 2.
check(
  'the nightly review window survives more than an hour of cron drift',
  CONSOLIDATE_WINDOW_HOURS >= 2,
  `${CONSOLIDATE_WINDOW_HOURS} hours`,
);

const consolidateEntries = crons.filter(c => c.path === '/api/cron/consolidate');
eq('/api/cron/consolidate is scheduled exactly once', consolidateEntries.length, 1);
// An HOURLY HEARTBEAT AT :00, like the two hour-gated send routes and unlike the
// welcome sweep. `0 * * * *` covers every Lisbon hour in both DST offsets by
// construction, puts four ticks inside the window, and satisfies the
// ":00, never :30" rule with nothing left to compute by hand.
eq('/api/cron/consolidate is an hourly heartbeat', consolidateEntries[0]?.schedule, '0 * * * *');
check(
  '/api/cron/consolidate fires at :00, never :30',
  /^0 /.test(consolidateEntries[0]?.schedule ?? ''),
  consolidateEntries[0]?.schedule ?? 'missing',
);

// ── THE CREW DAY LINK'S EXPIRY (issue #114) ─────────────────────────────────
//
// The token is a bearer credential sent in plain text over WhatsApp, and #114
// settles what a leaked one may expose: TODAY ONLY. The page reads the LIVE
// board rather than a morning snapshot, so that promise is kept by the EXPIRY
// and by nothing else — a token that outlives its Lisbon day goes on exposing
// tomorrow's work, and the day after's.
//
// So the expiry is a DAY BOUNDARY, not a duration, and computing a Lisbon day
// boundary from a UTC clock is the same trap activity-check pins for the feed:
// wrong by an hour for five months of the year, and only in one direction.

// WINTER — Lisbon runs at UTC+0, so the boundary is plain midnight UTC.
eq(
  'a winter link expires at Lisbon midnight',
  lisbonDayEnd('2026-01-15').toISOString(),
  '2026-01-16T00:00:00.000Z',
);
// SUMMER — Lisbon runs at UTC+1, so local midnight is 23:00 UTC the day before.
// Get this wrong and every summer link lives an hour into the next day, which
// is an hour in which it shows work it was never meant to.
eq(
  'a summer link expires at Lisbon midnight, an hour before UTC midnight',
  lisbonDayEnd('2026-07-15').toISOString(),
  '2026-07-15T23:00:00.000Z',
);
// The two DST days themselves, where a single-pass offset lookup is most likely
// to be wrong. Lisbon transitions at 01:00 UTC, which is why one refinement is
// enough — asserted rather than asserted-in-a-comment.
eq(
  'the spring-forward day still expires at local midnight',
  lisbonDayEnd('2026-03-29').toISOString(),
  '2026-03-29T23:00:00.000Z',
);
eq(
  'the autumn fall-back day still expires at local midnight',
  lisbonDayEnd('2026-10-25').toISOString(),
  '2026-10-26T00:00:00.000Z',
);

// The property that actually matters, derived rather than pinned: a link minted
// during the morning send window must still be alive that evening and dead
// before the NEXT morning's send. Checked across a whole year so a DST edge
// cannot hide in a hand-picked date.
{
  let alive = 0;
  let leaks = 0;
  for (let i = 0; i < 365; i += 1) {
    const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    const end = lisbonDayEnd(day).getTime();
    // 20:00 Lisbon on the day itself — a crew member checking after work.
    const evening = Date.parse(`${day}T19:00:00Z`);
    // The earliest the next morning's briefing could go out (07:00 Lisbon in
    // summer is 06:00 UTC), which is when a fresh token replaces this one.
    const nextMorning = Date.parse(`${day}T06:00:00Z`) + 24 * 60 * 60 * 1000;
    if (end > evening) alive += 1;
    if (end > nextMorning) leaks += 1;
  }
  eq('a link is alive all evening, every day of the year', alive, 365);
  eq('and never survives to the next briefing', leaks, 0);
}

// ── plan materials quality (issue #119) ─────────────────────────────────────
//
// The checker behind the plan card's warning section. Both live defects are
// pinned as positives ("Tiles" vs "Tiles 30x60"; two tiling tasks, one
// missing grout), and the conservative refusals are pinned as negatives so a
// well-meant widening cannot land silently: different colours are different
// materials, different trades are never compared, and same-trade tasks that
// share nothing (different sub-phases) are left alone.

function qt(
  title: string,
  materials: string[] | undefined,
  trade?: string,
): PlanQualityTask {
  return { title, trade, materials };
}

function variantWarnings(ws: PlanWarning[]) {
  return ws.filter(w => w.kind === 'material_name_variants');
}
function gapWarnings(ws: PlanWarning[]) {
  return ws.filter(w => w.kind === 'trade_materials_gap');
}

// A clean plan: consistent spellings, both tiling tasks carrying the same
// consumables. Zero warnings, and zero warnings must mean ZERO card text.
{
  const clean = checkPlanQuality([
    qt('Azulejo cozinha', ['azulejo 30x60', 'cola de azulejo', 'juntas'], 'azulejo'),
    qt('Azulejo casa de banho', ['azulejo 30x60', 'cola de azulejo', 'juntas'], 'azulejo'),
    qt('Pintura', ['tinta branca', 'rolos'], 'pintura'),
  ]);
  eq('a consistent plan raises no warnings', clean.length, 0);
  eq(
    'no warnings, no card text — not even a header',
    renderPlanWarningLines(clean, {
      header: 'H',
      nameVariants: () => 'v',
      tradeGap: () => 'g',
    }).length,
    0,
  );
}

// The first live defect: one material under several spellings. Case, accents,
// containment and a one-letter typo all collapse into ONE question naming
// every spelling, in first-seen order.
{
  const ws = checkPlanQuality([
    qt('T1', ['Azulejo', 'cimento cola']),
    qt('T2', ['azulejo 30x60', 'cemento cola']),
  ]);
  const variants = variantWarnings(ws);
  eq('case + containment + typo variants are all caught', variants.length, 2);
  eq(
    'containment cluster carries the raw spellings, first-seen order',
    JSON.stringify(variants[0]?.kind === 'material_name_variants' ? variants[0].names : []),
    JSON.stringify(['Azulejo', 'azulejo 30x60']),
  );
  eq(
    'a one-letter typo in a token is the same material',
    JSON.stringify(variants[1]?.kind === 'material_name_variants' ? variants[1].names : []),
    JSON.stringify(['cimento cola', 'cemento cola']),
  );
}
{
  const ws = variantWarnings(
    checkPlanQuality([qt('T1', ['cerâmica']), qt('T2', ['ceramica'])]),
  );
  eq('accent-only spellings are one material', ws.length, 1);
}
{
  const ws = variantWarnings(
    checkPlanQuality([qt('T1', ['Tiles']), qt('T2', ['tiles']), qt('T3', ['Tiles 30x60'])]),
  );
  eq('three spellings come out as ONE question, not three pairs', ws.length, 1);
  eq(
    'the cluster lists all three spellings',
    ws[0]?.kind === 'material_name_variants' ? ws[0].names.length : 0,
    3,
  );
}
// The conservative refusals. Each of these is a pair a person would NOT ask
// about, so flagging it would teach the manager to ignore the section.
eq(
  'different colours are different materials',
  checkPlanQuality([qt('T1', ['tinta branca']), qt('T2', ['tinta azul'])]).length,
  0,
);
eq(
  'a one-character difference in a SIZE is two purchases, not a typo',
  checkPlanQuality([qt('T1', ['prego 40mm']), qt('T2', ['prego 60mm'])]).length,
  0,
);
eq(
  'short words never typo-match ("cal" is not "cola")',
  checkPlanQuality([qt('T1', ['cal']), qt('T2', ['cola'])]).length,
  0,
);

// The second live defect: two tiling tasks, only one has grout. The deficient
// task is named and told exactly what its sibling lists.
{
  const ws = gapWarnings(
    checkPlanQuality([
      qt('Azulejo cozinha', ['azulejo 30x60', 'cola'], 'azulejo'),
      qt('Azulejo casa de banho', ['azulejo 30x60', 'cola', 'juntas'], 'azulejo'),
    ]),
  );
  eq('a same-trade consumable gap is caught', ws.length, 1);
  const gap = ws[0]?.kind === 'trade_materials_gap' ? ws[0] : undefined;
  eq('…naming the task that is missing it', gap?.title, 'Azulejo cozinha');
  eq('…and what it is missing', JSON.stringify(gap?.missing), JSON.stringify(['juntas']));
}
// A task carrying a VARIANT spelling of a sibling's material is not "missing"
// it — that pair is already the name-variants question, and repeating it as a
// gap would be the same doubt stated twice.
{
  const ws = checkPlanQuality([
    qt('T1', ['azulejo 30x60', 'juntas'], 'azulejo'),
    qt('T2', ['azulejo'], 'azulejo'),
  ]);
  eq('variant coverage: the tile pair is a variants question', variantWarnings(ws).length, 1);
  const gap = gapWarnings(ws)[0];
  eq(
    'variant coverage: the gap lists only what is genuinely absent',
    JSON.stringify(gap?.kind === 'trade_materials_gap' ? gap.missing : []),
    JSON.stringify(['juntas']),
  );
}
eq(
  'different trades are never compared',
  checkPlanQuality([
    qt('Pintura', ['rolos'], 'pintura'),
    qt('Azulejo', ['rolos', 'fita'], 'azulejo'),
  ]).length,
  0,
);
eq(
  'same trade, disjoint lists = different sub-phases, left alone',
  checkPlanQuality([
    qt('Tubagens', ['tubo multicamada', 'abracadeiras'], 'canalizacao'),
    qt('Loiças', ['torneiras', 'sifoes'], 'canalizacao'),
  ]).length,
  0,
);
eq(
  'a task with NO materials is skipped, not flagged as missing everything',
  checkPlanQuality([
    qt('Azulejo cozinha', ['azulejo', 'cola', 'juntas'], 'azulejo'),
    qt('Azulejo casa de banho', undefined, 'azulejo'),
  ]).length,
  0,
);
eq(
  'tasks without a trade are never trade-compared',
  checkPlanQuality([qt('T1', ['cola', 'juntas']), qt('T2', ['cola'])]).length,
  0,
);

// The rendered section: header first, one line per warning.
{
  const ws = checkPlanQuality([
    qt('T1', ['Azulejo', 'cola'], 'azulejo'),
    qt('T2', ['azulejo', 'cola', 'juntas'], 'azulejo'),
  ]);
  const rendered = renderPlanWarningLines(ws, {
    header: 'HEADER',
    nameVariants: names => `V:${names.join('|')}`,
    tradeGap: p => `G:${p.title}:${p.missing.join('|')}`,
  });
  eq('warnings render as header + one line each', rendered.length, ws.length + 1);
  eq('the header leads the section', rendered[0], 'HEADER');
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(lines.join('\n'));
console.log(`\nScheduler check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
