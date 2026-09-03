import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import type { WhatsAppRecipient } from '@capo/core/channels/whatsapp';
import { withinFreeFormWindow } from '@capo/core/channels/whatsapp';
import { partitionCrew, readLastInboundAt, type AddressableCrewRow } from '../app/notifications/briefing';

// The PURE half of "the manager wants to reach one crew member" (issue #123):
// which rung of the delivery ladder a given crew row lands on, and the message
// they read when it is the free one.
//
// Everything here is pure — no Db, no network, `now` injected — which is what
// lets `pnpm whatsapp-check` pin it with no credentials. That matters more here
// than in most places, because the ladder is the part where a wrong answer is
// SILENT: guessing "inside the window" earns Meta's 131047 and the crew member
// receives nothing at all.
//
// It lives in apps/web/lib rather than @capo/core for the same reason
// lib/worker-request.ts does: it needs the USER copy catalog, and pulling
// @capo/i18n/catalog into the agent package would drag every UI string into the
// agent bundle.

/**
 * The three rungs, in the order they are tried.
 *
 *   free_form  the crew member wrote to Capo within the last 23 hours, so
 *              Meta's customer-service window is open and an ordinary text
 *              message is legal, free, and carries the manager's words
 *              verbatim. This is the only rung that DELIVERS.
 *   template   the window is shut. Free-form is refused outright (131047) and
 *              the recipient gets nothing, so the only legal contact is a
 *              pre-approved template. `capo_message_waiting` is a WINDOW
 *              REOPENER: its frozen body asks them to reply and cannot carry a
 *              word the manager wrote. Costs money.
 *   blocked    there is no legal way to reach this person at all.
 *
 * The recipient rides the two sending rungs so the caller never has to rebuild
 * it, which is what keeps `recipientFor`'s phone-before-BSUID preference in one
 * copy (AGENTS.md: a second copy of an addressing rule eventually disagrees,
 * and the symptom is a send that quietly goes to a stale number).
 */
export type CrewMessageRoute =
  | { rung: 'free_form'; recipient: WhatsAppRecipient }
  | { rung: 'template'; recipient: WhatsAppRecipient }
  | { rung: 'blocked'; reason: CrewMessageBlock };

export type CrewMessageBlock = 'inactive' | 'unreachable' | 'no_consent';

/** What routeCrewMessage needs off a `workers` row. A superset of the crew
 *  partition's own input, plus the window proof. */
export type RoutableCrewRow = AddressableCrewRow & { last_inbound_at?: string | null };

/**
 * Which rung this crew member lands on, right now.
 *
 * ── THE CONSENT GATE IS partitionCrew's, NOT A SECOND COPY ─────────────────
 * The three questions (active? addressable? consenting?) are asked by the same
 * function the 07:00 briefing, the late-afternoon check-in and the welcome
 * sweep ask, over a one-element array. That is deliberate and it is the whole
 * reason this function reads oddly: `partitionCrew` is where 0025's rule lives
 * and AGENTS.md says every proactive send reaches its crew through it. Asking
 * `hasWhatsAppConsent` directly here would be the second copy, and the symptom
 * of two copies disagreeing is a person one send reaches and another silently
 * skips.
 *
 * A manager-initiated message is treated as PROACTIVE, and that is a decision
 * rather than an oversight. `hasWhatsAppConsent` is documented as governing
 * proactive sends only, because Capo answering someone's own message is a
 * response and not an unsolicited send. This is neither: the crew member did
 * not ask for it, the manager did. It is exactly the class of message an
 * opt-out is meant to stop, so it is gated on both rungs, free or paid.
 *
 * The counts are read in the order active → reachable → consenting so the
 * reason returned is the FIRST thing that failed. They partition the input, so
 * exactly one of the three is 1 when nothing is messageable.
 */
export function routeCrewMessage(worker: RoutableCrewRow, now: number): CrewMessageRoute {
  const partition = partitionCrew([worker]);
  const target = partition.messageable[0];
  if (!target) {
    if (partition.excludedInactive > 0) return { rung: 'blocked', reason: 'inactive' };
    if (partition.excludedUnreachable > 0) return { rung: 'blocked', reason: 'unreachable' };
    return { rung: 'blocked', reason: 'no_consent' };
  }

  // FAILS CLOSED TOWARD THE TEMPLATE. A null, an unparseable value, a column a
  // deploy has not seen yet, or a timestamp in the future all read as "no proof
  // of an open window" and take the paid rung. Being wrong that way costs one
  // template; being wrong the other way costs the message entirely.
  return withinFreeFormWindow(readLastInboundAt(worker), now)
    ? { rung: 'free_form', recipient: target.recipient }
    : { rung: 'template', recipient: target.recipient };
}

/**
 * The whole free-form message the crew member reads.
 *
 * ATTRIBUTED BEFORE THE WORDS START, which is the one thing this renderer is
 * for. A bare line arriving from Capo's number reads as Capo issuing an
 * instruction, and somebody on a roof has no way to tell an order from a
 * robot's suggestion. The first line names the company, the manager's words are
 * quoted, and the last line invites a reply, which is also the mechanism that
 * keeps the next message free.
 *
 * `locale` is the crew member's own dial (`workers.language ?? companies.language`),
 * never the manager's. `company` is `companies.name` and `text` is what the
 * manager typed.
 */
export function renderCrewMessage(args: { company: string; text: string }, locale: Locale): string {
  return getCatalog(locale).crewMessage.whatsapp(args);
}

/**
 * The two body parameters of `capo_message_waiting`, in template order.
 *
 * {{1}} is the crew member's name and {{2}} is WHO IS ASKING, which by the
 * template's own definition is the company name the manager typed. The
 * manager's words are deliberately absent: a template body is frozen at Meta's
 * approval and this one says a message is waiting, so putting the message into
 * {{2}} would produce a sentence that reads as nonsense ("Ola Miguel. traz mais
 * tinta tem um recado para ti").
 *
 * Flattening is `toTemplateParam`'s job at the send, not this function's: a
 * parameter carrying a newline is refused wholesale with Meta's 132000.
 */
export function messageWaitingParams(args: { workerName: string; company: string }): string[] {
  return [args.workerName, args.company];
}

/** The template that reopens a shut window. Approved in three locales in
 *  WhatsApp Manager, or every send to that language fails with 132001. */
export const MESSAGE_WAITING_TEMPLATE = 'capo_message_waiting';

/**
 * `notification_log.kind` for the paid nudge.
 *
 * A NEW KIND rather than reuse, and the reason is that table's unique key:
 * `(kind, audience, worker_id, profile_id, notification_date)`. Under its own
 * kind the nudge claims a slot that neither daily send is using, so it can go
 * out on a morning the briefing already went out; and it is capped at ONE PER
 * PERSON PER DAY, which is the double-billing guard. Reusing 'daily_briefing'
 * here would silently cancel the crew's morning message.
 *
 * `kind` carries no CHECK constraint in 0016, so this needs no migration.
 */
export const MESSAGE_WAITING_KIND = 'manager_message';
