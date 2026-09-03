// The pure half of a crew request (issue #152): the urgency arithmetic and the
// filing hint, with nothing else in it.
//
// It was written in apps/web/lib/worker-request.ts, beside the two sentences
// the manager reads outside the app, because those sentences need the USER copy
// catalog and the catalog must never enter the agent bundle. That reason still
// holds for the renderers and they have not moved. It does NOT hold for the
// ARITHMETIC, which has no catalog, no clock, no Db and no locale — and the
// moment the manager's own agent needed to rank the same rows (the `crew_requests`
// tool), the choice was between importing this from apps/web, which the
// dependency direction forbids (i18n <- db <- core <- {web, operator}), and
// writing the ranking rule a second time.
//
// A second copy is the failure this codebase is written to avoid. Two rankings
// that disagree means Capo calls a request urgent in chat while the Home screen
// files it under "later", and the manager has no way to tell which is right —
// the same class of bug the `agenda` tool exists to make impossible for dates.
// So the arithmetic moved DOWN into the shared package and apps/web re-exports
// it, which also keeps `pnpm whatsapp-check`'s existing pins pointing at the one
// implementation there is.
//
// Everything here is PURE: `today` is injected, never read from a runtime clock.
// That is what lets the check assert it with no credentials.

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
