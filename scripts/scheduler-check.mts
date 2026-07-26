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
import { addWorkdays, isHoliday, isWorkday, nextWorkday, workdayAfter } from '@capo/core/capabilities/workdays';

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

// ── report ──────────────────────────────────────────────────────────────────
console.log(lines.join('\n'));
console.log(`\nScheduler check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
