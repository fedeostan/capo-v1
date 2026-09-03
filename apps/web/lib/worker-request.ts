import {
  coerceCategory,
  describeUrgency,
  isPressing,
  urgencyRank,
  type RequestCategory,
  type RequestUrgency,
} from '@capo/core/capabilities/request-urgency';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

// The pure half of a crew request (issue #152) — the two rendered sentences the
// manager reads outside the app, over the shared urgency arithmetic re-exported
// below.
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
//
// The ARITHMETIC no longer lives here, and the reason is worth reading before
// moving it back. It has no catalog, so the paragraph above never applied to
// it, and the manager's own agent now ranks the same rows through the
// `crew_requests` tool — which sits in @capo/core and cannot import from
// apps/web (i18n <- db <- core <- {web, operator}). Copying the ranking rule
// into the agent would let Capo call a request urgent in chat while Home files
// it under "later", with the manager unable to tell which is right. So it moved
// DOWN, into @capo/core/capabilities/request-urgency, and is re-exported here
// unchanged: every existing importer, `pnpm whatsapp-check` included, keeps
// pointing at the one implementation there is.

export { coerceCategory, describeUrgency, isPressing, urgencyRank };
export type { RequestCategory, RequestUrgency };

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
