// Scheduler & working-day calendar check — the deterministic half of the QA
// gate. Unlike `pnpm agent-smoke`, this needs NO credentials, no network and
// no model: it runs in about a second and can therefore live in CI, which is
// where a silent scheduling regression would otherwise reach production.
//
// It guards the specific bug this file was written for: durations were being
// advanced in CALENDAR days, so every plan was quietly compressed by weekends
// and by the thirteen Portuguese national holidays.
//
// Run with `pnpm scheduler-check`. Exit 0 = green, 1 = at least one failure.

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

// ── report ──────────────────────────────────────────────────────────────────
console.log(lines.join('\n'));
console.log(`\nScheduler check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
