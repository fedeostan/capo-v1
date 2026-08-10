// Portuguese working-day calendar for the plan scheduler.
//
// Before this existed the scheduler advanced in CALENDAR days
// (due = start + duration_days - 1), so a 5-day task starting on a Thursday
// was "due Monday" — three working days of real capacity. Every plan was
// silently compressed by ~2/7, and plans happily scheduled work on 25 de Abril
// or Natal. A Portuguese builder spots that on the first plan they read, and
// once they spot it they stop trusting the dates.
//
// Scope: the thirteen NATIONAL holidays (feriados nacionais obrigatórios).
// Deliberately excluded — they are not national, and a wrong skip is worse
// than a missing one because it invents idle days the manager did not ask for:
//   - Municipal holidays (Lisboa 13 Jun, Porto 24 Jun, …) — need the company's
//     município, which Capo does not collect today.
//   - Carnaval (Easter − 47) — "tolerância de ponto", granted year by year by
//     the Government, not a statutory holiday.
// If Federico wants either, they belong here as an explicit, per-company opt-in
// rather than a guess baked into the scheduler.

/** Anonymous Gregorian computus — Easter Sunday for a given year, as ISO. */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toIso(new Date(Date.UTC(year, month - 1, day)));
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

// Fixed-date national holidays, MM-DD.
const FIXED = [
  '01-01', // Ano Novo
  '04-25', // Dia da Liberdade
  '05-01', // Dia do Trabalhador
  '06-10', // Dia de Portugal
  '08-15', // Assunção de Nossa Senhora
  '10-05', // Implantação da República
  '11-01', // Todos os Santos
  '12-01', // Restauração da Independência
  '12-08', // Imaculada Conceição
  '12-25', // Natal
];

// Plans span weeks, not decades — a tiny per-year cache keeps the hot path
// (one Set lookup per candidate day) free of repeated computus work.
const cache = new Map<number, Set<string>>();

function holidaysFor(year: number): Set<string> {
  const cached = cache.get(year);
  if (cached) return cached;
  const easter = easterSunday(year);
  const set = new Set<string>([
    ...FIXED.map(md => `${year}-${md}`),
    shift(easter, -2), // Sexta-feira Santa
    easter, // Domingo de Páscoa (a Sunday anyway — kept for completeness)
    shift(easter, 60), // Corpo de Deus
  ]);
  cache.set(year, set);
  return set;
}

export function isHoliday(iso: string): boolean {
  return holidaysFor(Number(iso.slice(0, 4))).has(iso);
}

export function isWeekend(iso: string): boolean {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

export function isWorkday(iso: string): boolean {
  return !isWeekend(iso) && !isHoliday(iso);
}

/** The first workday on or after `iso`. */
export function nextWorkday(iso: string): string {
  let d = iso;
  // Bounded: at most a weekend plus the longest run of adjacent PT holidays.
  for (let guard = 0; guard < 30 && !isWorkday(d); guard++) d = shift(d, 1);
  return d;
}

/** The first workday strictly after `iso`. */
export function workdayAfter(iso: string): string {
  return nextWorkday(shift(iso, 1));
}

/**
 * The due date of a task that starts on `start` and needs `days` working days.
 * Inclusive of the start day: a 1-day task is due the day it starts.
 */
export function addWorkdays(start: string, days: number): string {
  let d = nextWorkday(start);
  for (let remaining = days - 1; remaining > 0; remaining--) d = workdayAfter(d);
  return d;
}

// ── measuring a span, not walking one ───────────────────────────────────────
// The reschedule cascade needs the inverse of addWorkdays: given two dates,
// how many working days apart are they? Two callers need it and neither can
// use a day-by-day loop safely — the dates come from the DB, not from the
// planner, so nothing bounds how far apart they are.
//
//   - a task created before the planner has duration_days = null (nullable
//     since 0010), so its duration has to be read back off its existing span;
//   - the approval card prints a SIGNED shift per row ("−2 dias úteis"), and
//     that number is the whole point of the diff.
//
// Counted arithmetically (whole weeks × 5, plus the ragged remainder, minus
// weekday holidays) so the cost is independent of the distance.

function dayDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Mon–Fri days in [start, end] inclusive, holidays not yet removed. */
function weekdaysInRange(start: string, end: string): number {
  const total = dayDiff(start, end) + 1;
  const whole = Math.floor(total / 7);
  let count = whole * 5;
  const startDow = new Date(`${start}T00:00:00Z`).getUTCDay();
  for (let i = whole * 7; i < total; i++) {
    const dow = (startDow + i) % 7;
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return count;
}

/**
 * Working days in [start, end], INCLUSIVE of both ends — the same counting
 * convention as addWorkdays, so `countWorkdays(s, addWorkdays(s, n)) === n`
 * for any workday `s`. Zero when `end` is before `start`.
 */
export function countWorkdays(start: string, end: string): number {
  if (end < start) return 0;
  let count = weekdaysInRange(start, end);
  for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year++) {
    for (const holiday of holidaysFor(year)) {
      // Only weekday holidays were counted above, so only those are subtracted:
      // a holiday landing on a Sunday must not be removed twice.
      if (holiday >= start && holiday <= end && !isWeekend(holiday)) count -= 1;
    }
  }
  return count;
}

/**
 * Signed working-day distance from `from` to `to`: negative when `to` is
 * earlier (work pulled in), positive when later (work pushed out), 0 when the
 * two dates are the same day. Half-open on the `from` side so that
 * `workdayDelta(d, workdayAfter(d)) === 1` regardless of weekends.
 */
export function workdayDelta(from: string, to: string): number {
  if (from === to) return 0;
  return to > from ? countWorkdays(shift(from, 1), to) : -countWorkdays(shift(to, 1), from);
}
