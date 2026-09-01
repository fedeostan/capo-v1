import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

// The pure half of a crew request (issue #152) — the urgency arithmetic, and
// the two rendered sentences the manager reads outside the app.
//
// Everything here is PURE: no Db, no clock, no network, `today` injected. That
// is what lets `pnpm whatsapp-check` assert it with no credentials, which is
// the only automated coverage this path will ever get — and the arithmetic is
// the load-bearing part of the whole feature, because it is what replaces "the
// model decides how urgent this sounds".
//
// It lives in apps/web/lib rather than @capo/core for the same reason
// notifications/briefing.ts does: it needs the USER copy catalog, and pulling
// @capo/i18n/catalog into the agent package would drag every UI string into the
// agent bundle.

/** The coarse filing hint, keyed by worker_requests.category's CHECK in 0043. */
export type RequestCategory = 'material' | 'tool' | 'machine' | 'delivery' | 'other';

const CATEGORIES: readonly string[] = ['material', 'tool', 'machine', 'delivery', 'other'];

/** An unknown value reads as absent — a row written by a newer deploy must not
 *  render `undefined` on an older bundle. Same posture as the inbox's unknown
 *  `kind`. */
export function coerceCategory(value: string | null | undefined): RequestCategory | null {
  return value && CATEGORIES.includes(value) ? (value as RequestCategory) : null;
}

/**
 * How urgent a request is — derived from the DATE and from nothing else.
 *
 * Facu's ranking, in his words: out of material FOR TODAY is critical, out of
 * material FOR TOMORROW is critical, needed NEXT WEEK can be chill. So the
 * buckets are the ones a person on a building site actually uses, and the
 * ordering below is exactly that sentence.
 *
 * `undated` is a FIRST-CLASS answer and never a guess. Capo asks once; if the
 * crew member still does not say, the request is filed with no date and shown
 * with no date. Guessing high cries wolf until the manager stops looking;
 * guessing low buries the one that mattered.
 */
export type RequestUrgency = 'overdue' | 'today' | 'tomorrow' | 'later' | 'undated';

/**
 * Plain subtraction, on ISO dates, in the Lisbon day the whole product agrees
 * on — `today` comes from `lisbon_today()`, never from a runtime clock. One
 * clock, so a request that says "hoje" here says "hoje" on the board too.
 *
 * Both dates are parsed as UTC midnight so the difference is whole days with no
 * DST edge: 2026-03-29 minus 2026-03-28 is one day even though that Lisbon day
 * is 23 hours long.
 *
 * Anything unparseable reads as `undated`, which is the honest failure: it says
 * "we do not know when this is for" rather than inventing a rank for it.
 */
export function describeUrgency(neededBy: string | null | undefined, today: string | null): RequestUrgency {
  if (!neededBy || !today) return 'undated';
  const at = Date.parse(`${neededBy}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(at) || Number.isNaN(now)) return 'undated';
  const days = Math.round((at - now) / 86_400_000);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return 'later';
}

/**
 * Sort key: the most urgent first, undated last.
 *
 * Undated goes LAST rather than first on purpose. A request with no date is not
 * a request with no importance — but it is the one the manager can least act on
 * from a summary, and putting it above a blocker for this morning would be the
 * "guessing high" failure by another route.
 */
const URGENCY_RANK: Record<RequestUrgency, number> = {
  overdue: 0,
  today: 1,
  tomorrow: 2,
  later: 3,
  undated: 4,
};

export function urgencyRank(urgency: RequestUrgency): number {
  return URGENCY_RANK[urgency];
}

/** True for the requests worth a card on Home, as opposed to a row in the
 *  inbox. Everything that is not comfortably in the future. */
export function isPressing(urgency: RequestUrgency): boolean {
  return urgency === 'overdue' || urgency === 'today' || urgency === 'tomorrow';
}

/** The reader's own rendering of a needed-by date. UTC, because the stored
 *  value is a bare calendar day and re-interpreting it in a timezone would slide
 *  it by one. */
export function formatNeededBy(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(getCatalog(locale).meta.dateLocale, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${iso}T00:00:00Z`));
}

/** "para amanhã" / "para 3 de set." / "sem data" — one sentence fragment, in
 *  the reader's own language, from the urgency and the date. */
export function whenLabel(urgency: RequestUrgency, neededBy: string | null, locale: Locale): string {
  return getCatalog(locale).requests.when({
    kind: urgency,
    dateLabel: neededBy ? formatNeededBy(neededBy, locale) : null,
  });
}

/** What the manager needs to be told about one request, in either envelope. */
export interface RenderableRequest {
  /** workers.name — typed by the MANAGER, so it is company-owned text. */
  workerName: string;
  /** The crew member's OWN WORDS. Quoted on the WhatsApp line; NEVER passed to
   *  the thread renderer below. */
  text: string;
  neededBy: string | null;
  /** The task they named, if they named one. Company-owned text. */
  taskTitle: string | null;
}

/**
 * The free-form WhatsApp line to the manager.
 *
 * ⚠ THIS ENVELOPE CARRIES THE QUOTE AND THE THREAD NOTE BELOW DOES NOT, and
 * that asymmetry is the whole point rather than an oversight. A WhatsApp
 * message is delivered to a person's phone and read once; a `role='event'` row
 * in `messages` is permanent, model-visible input that `thread.recentUserTexts`
 * reads — and those last three user rows are the evidence pool the write guard
 * matches a manager's quote against (migration 0027, AGENTS.md). Worker prose
 * may go to the manager; it may not go into that table.
 *
 * The quote is attributed and visually separated so the manager reads it as one
 * crew member's word, never as Capo speaking.
 */
export function renderRequestMessage(request: RenderableRequest, today: string | null, locale: Locale): string {
  const t = getCatalog(locale).requests;
  return t.whatsapp({
    name: request.workerName,
    when: whenLabel(describeUrgency(request.neededBy, today), request.neededBy, locale),
    quote: request.text,
    task: request.taskTitle,
  });
}

/**
 * The manager's CHAT-THREAD note (issue #47's seam, `recordThreadEvent`).
 *
 * It takes a NAME, a WHEN and a TASK TITLE, and there is deliberately no
 * parameter it could put the crew member's own words in. Same shape and same
 * reason as `renderCheckinAnswerEvent`, whose comment says a `note` parameter
 * would be the moment that boundary was lost — this one cannot grow that
 * parameter without also changing `RenderableRequest`'s use here, which is why
 * the argument is destructured down to three fields at the call.
 */
export function renderRequestEvent(
  args: { workerName: string; neededBy: string | null; taskTitle: string | null },
  today: string | null,
  locale: Locale,
): string {
  const t = getCatalog(locale).requests;
  return t.event({
    name: args.workerName,
    when: whenLabel(describeUrgency(args.neededBy, today), args.neededBy, locale),
    task: args.taskTitle,
  });
}
