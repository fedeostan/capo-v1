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
import {
  addWorkdays,
  countWorkdays,
  isHoliday,
  isWorkday,
  nextWorkday,
  workdayAfter,
  workdayDelta,
} from '@capo/core/capabilities/workdays';
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
import { SEND_WINDOW_HOURS, sendWindowEnd, withinSendWindow } from '../apps/web/lib/cron';

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

// Restated here rather than imported: each route's SEND_HOUR is a module-local
// const in a Next route file, and exporting arbitrary symbols from a route.ts
// is not something to do for a script's convenience. The cost is that moving a
// route's SEND_HOUR without touching this file leaves the two disagreeing — but
// the vercel.json sweep below is checked against THESE numbers, so a route that
// moved alone would still have to move its UTC entries or fail on the next PR.
const BRIEFING_HOUR = 7;
const CHECKIN_HOUR = 16;

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

// ── the UTC entries that feed the window ────────────────────────────────────
// vercel.json is the other half of the mechanism and is JSON, so nothing in it
// can explain itself and nothing in CI reads it. Lisbon is UTC+0 in winter and
// UTC+1 in summer, so each hour-gated route needs the UNION of the UTC hours
// that land inside its window under BOTH offsets — and in each season one of
// them must land exactly on the target hour, or the route starts the day
// already one hour into its own window with no headroom left.

interface CronEntry {
  path: string;
  schedule: string;
}

const crons = (
  JSON.parse(readFileSync(new URL('../apps/web/vercel.json', import.meta.url), 'utf8')) as {
    crons: CronEntry[];
  }
).crons;

function scheduledUtcHours(path: string): number[] {
  const entries = crons.filter(c => c.path === path);
  check(`${path} has at least one schedule`, entries.length > 0);
  return entries.map(entry => {
    const [minute, hour] = entry.schedule.split(' ');
    // The :00 rule (AGENTS.md). A :30 entry has thirty minutes of headroom
    // before the Lisbon hour rolls over instead of sixty, and that is exactly
    // how the check-in shipped and then never sent a single message.
    check(`${path} "${entry.schedule}" fires at :00`, minute === '0', `minute field is "${minute}"`);
    return Number(hour);
  });
}

const SEASONS = [
  ['winter (UTC+0)', 0],
  ['summer (UTC+1)', 1],
] as const;

for (const [path, sendHour] of [
  ['/api/cron/reminders', BRIEFING_HOUR],
  ['/api/cron/checkin', CHECKIN_HOUR],
] as const) {
  const utcHours = scheduledUtcHours(path);
  for (const [season, offset] of SEASONS) {
    const inWindow = utcHours.map(h => (h + offset) % 24).filter(h => withinSendWindow(h, sendHour));
    const detail = `in-window Lisbon hours: [${inWindow.join(', ')}] from UTC [${utcHours.join(', ')}]`;
    check(`${path} has an entry inside its window in ${season}`, inWindow.length > 0, detail);
    check(
      `${path} has an entry landing ON the target hour in ${season}, so a late dispatch keeps the full window`,
      inWindow.includes(sendHour),
      detail,
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
// So it carries a WIDE gate (Lisbon 09:00–19:59) fed by a minute-based
// schedule, which is why the "one UTC entry per window hour under both DST
// offsets" sweep above does not apply to it: every quarter of an hour covers
// every hour in every season by construction. These numbers are duplicated from
// the route for the same reason BRIEFING_HOUR and CHECKIN_HOUR are — a route
// that moved alone would fail here on the next pull request.
const WELCOME_HOUR = 9;
const WELCOME_WINDOW_HOURS = 11;

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

// ── report ──────────────────────────────────────────────────────────────────
console.log(lines.join('\n'));
console.log(`\nScheduler check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
