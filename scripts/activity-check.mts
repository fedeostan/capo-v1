// The activity feed's pure half, asserted without credentials or network.
//
// WHY THIS FILE EXISTS. Rounds 2 and 3 put the same events on two surfaces —
// the Atividade tab and Home's "what just happened" widget — and everything
// that could make those two disagree, or make either one say something false,
// lives in `render.ts` and in the grouping half of `feed.ts`. None of it can
// be exercised in a browser without a seeded tenant, and this repo has no test
// suite, so the alternative to this file is no coverage at all.
//
// What it does NOT cover, stated rather than implied: the three database reads
// in loadActivity. Those need credentials, so they are outside a CI gate by
// construction — the same line `pnpm scheduler-check` draws.
import { getCatalog } from '../packages/i18n/src/catalogs.ts';
import type { Locale } from '../packages/i18n/src/locale.ts';
import { activityDayLabel, activitySentence, groupByDay } from '../apps/web/app/activity/render.ts';
import type { ActivityEvent } from '../apps/web/app/activity/feed.ts';

const lines: string[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function event(over: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: 'e1',
    kind: 'task_claimed',
    at: '2026-08-24T09:00:00.000Z',
    taskId: 't1',
    taskTitle: 'Pintar tecto',
    jobName: 'Casa de Paco',
    workerName: 'Zé',
    count: 0,
    ...over,
  };
}

const LOCALES: Locale[] = ['pt-PT', 'es-ES', 'en-US'];

// ── every kind renders a sentence, in every language ──────────────────────
//
// A missing branch here is a blank line on the manager's first screen, and
// TypeScript's exhaustiveness check on the switch only catches a kind that was
// ADDED — never one whose catalog entry was left as an empty string.
const KINDS: ActivityEvent['kind'][] = [
  'task_claimed',
  'task_approved',
  'task_rejected',
  'photos_added',
  'checkin_done',
  'checkin_not_done',
];
for (const locale of LOCALES) {
  const t = getCatalog(locale);
  for (const kind of KINDS) {
    const sentence = activitySentence(event({ kind, count: 3 }), t);
    check(
      `${locale} renders ${kind}`,
      sentence.trim().length > 0 && !sentence.includes('undefined') && !sentence.includes('null'),
      JSON.stringify(sentence),
    );
  }
}

// ── the anonymous branch ──────────────────────────────────────────────────
//
// A claim with no worker is the MANAGER declaring a task finished himself. The
// bug this guards is "null says Pintar tecto is finished" reaching a screen.
for (const locale of LOCALES) {
  const t = getCatalog(locale);
  const anon = activitySentence(event({ workerName: null }), t);
  check(`${locale} names nobody when no worker is attached`, !/\bnull\b|undefined/.test(anon), JSON.stringify(anon));
  check(`${locale} still names the task when anonymous`, anon.includes('Pintar tecto'), JSON.stringify(anon));
}

// ── a missing task title degrades, never prints "null" ────────────────────
for (const locale of LOCALES) {
  const t = getCatalog(locale);
  const orphan = activitySentence(event({ taskTitle: null }), t);
  check(
    `${locale} degrades a missing task title to the catalog fallback`,
    orphan.includes(t.notifications.noSubject) && !/\bnull\b/.test(orphan),
    JSON.stringify(orphan),
  );
}

// ── photo pluralisation ───────────────────────────────────────────────────
//
// One photo must not read "1 fotografias". Pluralisation is hand-written per
// language in the catalog, which is exactly the kind of thing that is correct
// in the language it was written in and wrong in the other two.
for (const locale of LOCALES) {
  const t = getCatalog(locale);
  const one = activitySentence(event({ kind: 'photos_added', count: 1 }), t);
  const many = activitySentence(event({ kind: 'photos_added', count: 6 }), t);
  check(`${locale} singular photo`, one !== many && one.includes('1'), JSON.stringify(one));
  check(`${locale} plural photos`, many.includes('6'), JSON.stringify(many));
}

// ── day grouping ──────────────────────────────────────────────────────────
//
// The feed arrives newest-first and the grouping must PRESERVE that order
// while collapsing runs of the same day. A grouping that reordered would put
// yesterday above today, which is the one thing a feed cannot do.
{
  const t = getCatalog('pt-PT');
  const today = '2026-08-24';
  const events = [
    event({ id: 'a', at: '2026-08-24T17:00:00.000Z' }),
    event({ id: 'b', at: '2026-08-24T09:00:00.000Z' }),
    event({ id: 'c', at: '2026-08-23T18:00:00.000Z' }),
    event({ id: 'd', at: '2026-08-20T08:00:00.000Z' }),
  ];
  const groups = groupByDay(events, today, t);
  check('grouping produces one bucket per day', groups.length === 3, `${groups.length} buckets`);
  check('today is labelled Hoje', groups[0]?.label === t.activity.today, groups[0]?.label);
  check('the day before is labelled Ontem', groups[1]?.label === t.activity.yesterday, groups[1]?.label);
  check(
    'an older day gets a real date, not Hoje/Ontem',
    groups[2] !== undefined &&
      groups[2].label !== t.activity.today &&
      groups[2].label !== t.activity.yesterday,
    groups[2]?.label,
  );
  check('same-day events stay in one bucket', groups[0]?.events.length === 2, `${groups[0]?.events.length}`);
  check(
    'newest-first order survives grouping',
    groups[0]?.events[0]?.id === 'a' && groups[0]?.events[1]?.id === 'b',
    groups[0]?.events.map(e => e.id).join(','),
  );
  check(
    'every event survives grouping',
    groups.flatMap(g => g.events).length === events.length,
    `${groups.flatMap(g => g.events).length} of ${events.length}`,
  );
}

// ── the day boundary is LISBON, not UTC ───────────────────────────────────
//
// The trap this pins: 2026-08-24T23:30Z is already the 25th in Lisbon during
// summer time (UTC+1). Labelling it from the UTC date would file an event
// under the wrong day, which is the same class of bug as the cron hour gate.
{
  const t = getCatalog('pt-PT');
  check(
    'a late-evening UTC stamp is labelled by the LISBON day',
    activityDayLabel('2026-08-24T23:30:00.000Z', '2026-08-25', t) === t.activity.today,
    activityDayLabel('2026-08-24T23:30:00.000Z', '2026-08-25', t),
  );
  // And the winter case, where Lisbon is UTC+0 and the two agree.
  check(
    'a winter stamp agrees with UTC',
    activityDayLabel('2026-01-15T23:30:00.000Z', '2026-01-15', t) === t.activity.today,
    activityDayLabel('2026-01-15T23:30:00.000Z', '2026-01-15', t),
  );
}

// ── a null `today` must not throw ─────────────────────────────────────────
//
// loadToday() degrades to null when its read fails, and a feed that threw on
// that would turn a soft failure into a blank screen.
{
  const t = getCatalog('pt-PT');
  const groups = groupByDay([event({})], null, t);
  check('a null today still groups', groups.length === 1 && groups[0]!.events.length === 1);
  check(
    'a null today never claims Hoje',
    groups[0]!.label !== t.activity.today && groups[0]!.label !== t.activity.yesterday,
    groups[0]!.label,
  );
}

// ── empty in, empty out ───────────────────────────────────────────────────
check('no events produces no buckets', groupByDay([], '2026-08-24', getCatalog('pt-PT')).length === 0);

console.log(lines.join('\n'));
console.log(`\nActivity check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
