import type { Db } from '@capo/db/client';
import { appendEventMessage, ensureConversation } from '@capo/core/conversation';
import { coerceLocale, type Locale } from '@capo/i18n/locale';
import { logEvent } from '../../lib/log';

// ── THE ONE SEAM FOR "CAPO SEES WHAT THE MANAGER SEES" (issue #47) ──────────
//
// The complaint: Capo had no visibility of the messages the SYSTEM sends on its
// own — the 07:00 briefing, the late-afternoon check-in, the crew's answers to
// it. The manager saw them; Capo did not. So the manager could ask "what did
// you send my crew this morning?" and get an answer built from a board read,
// while the crew's phones held something Capo had never been told about. Two
// parties, two beliefs, and no way for the manager to tell which was right.
//
// The 07:00 briefing route had solved this for itself, inline, by calling
// ensureConversation + appendEventMessage directly. That was a HABIT, not a
// rule: the check-in route shipped months later, wrote nothing, and nothing
// anywhere noticed. This file turns the habit into a seam, so "a system-authored
// message that a manager or their crew receives is recorded in the thread Capo
// reads" is one function every such path calls.
//
// ── WHAT MAY GO IN, AND WHAT MAY NEVER ─────────────────────────────────────
// A `role='event'` row is read by TWO things that matter:
//
//   1. toThread() presents it to the model as <system-event> on every later
//      turn (packages/core/src/agent/memory/conversation.ts).
//   2. The summarizer folds it into `conversation_summaries`, which is then
//      merged forward into every later summary indefinitely.
//
// So an event row is permanent, model-visible input. Therefore:
//
//   ✅ SYSTEM-AUTHORED text — our own copy from @capo/i18n, wrapped around
//      company-owned data (task titles, obra names, crew names, counts) and
//      around STRUCTURED facts (which button a worker tapped, how many tasks
//      were in the snapshot). All of it is written by us or by the manager.
//
//   ❌ WORKER-AUTHORED TEXT. Not quoted, not summarised, not "just the gist".
//      Crew prose lives in `worker_messages` and `task_reviews.note` and stays
//      there. The reason is structural rather than tidy: `messages` is the
//      table `loadWindow` → `toThread` → `thread.recentUserTexts` reads, and
//      that is the evidence pool `runGuarded` matches a model's quote against
//      before executing a manager-level write directly. A worker whose words
//      landed in `messages` would not be persuading the manager's agent of
//      anything — they would be AUTHORING the evidence its authorization check
//      reads (AGENTS.md, "Worker text NEVER reaches the MANAGER's agent
//      context"; migration 0027).
//
//      Two things hold that line here. First, nothing in this file or its
//      callers ever passes crew prose in: every string comes from a catalog
//      renderer whose inputs are counts, enums and manager-authored names.
//      Second, `recentUserTexts` filters on `role === 'user'` and an event row
//      is `role === 'event'`, so even the text we DO write can never become
//      guard evidence — asserted by `pnpm guard-check`.
//
// ── FAILURE POSTURE ────────────────────────────────────────────────────────
// This never throws. A failure to RECORD is a visibility problem; a failure to
// SEND is a crew standing around a site with nothing to do. Same posture as
// loadCompanySnapshot and recordUsage: swallow into one log line, let the send
// finish. The cost of that is real and stated rather than hidden — a revoked
// grant or a broken conversations insert presents as a thread that quietly
// stops filling up, so grep `thread.event_failed` before concluding a quiet
// thread means a quiet day.
//
// ── IDEMPOTENCY IS THE CALLER'S JOB ────────────────────────────────────────
// There is no unique constraint on `messages` and there cannot be a useful one:
// two identical event lines on two different days are both correct. Since the
// send window widened to two Lisbon hours (#51), TWO cron invocations pass the
// hour gate every day, so a caller that writes unconditionally puts two copies
// of every morning note in front of the manager AND in front of the model.
// `notification_log`'s unique constraint is the idempotency lock both daily
// sends already rest on, so both cron callers gate this write on having WON at
// least one claim in that run. See the comments at each call site.

/** Which system path wrote the line. Log-only — never rendered to anybody. */
export type ThreadEventSource =
  /** The 07:00 briefing: what the day holds, and who was messaged about it. */
  | 'briefing'
  /** The late-afternoon check-in: who was asked whether they had finished. */
  | 'checkin_ask'
  /** A crew member's answer to that check-in — the BUTTON, never any text. */
  | 'checkin_answer'
  /**
   * The welcome (issue #45): Capo introducing itself to somebody whose number
   * has just entered the system. Crew only — the manager reads their own
   * welcome on their own phone, and a note about it would land in this very
   * thread.
   *
   * The fourth source, so the list AGENTS.md calls exhaustive is now four. It
   * belongs here for the reason the other three do: this is a message the crew
   * receives, and a manager must never find a conversation on a crew phone
   * that Capo has no record of starting.
   */
  | 'welcome';

/**
 * Append one system-authored line to a company's perpetual chat thread.
 *
 * `text` must already be rendered, in the reading manager's language, and must
 * contain no worker-authored prose — see the header. Returns whether the row
 * landed, for the caller's own logging; no caller may branch on it in a way
 * that changes what a person receives.
 */
export async function recordThreadEvent(
  db: Db,
  args: { companyId: string; source: ThreadEventSource; text: string },
): Promise<boolean> {
  try {
    const conversationId = await ensureConversation(db, args.companyId);
    await appendEventMessage(db, conversationId, args.text);
    return true;
  } catch (err) {
    logEvent('thread.event_failed', {
      companyId: args.companyId,
      source: args.source,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Which language a thread note is written in.
 *
 * The thread is per COMPANY and shared, so its notes can only be in one
 * language. The first manager's `profiles.language` is a better guess than
 * `companies.language`, which is the dial for what Capo STORES (task titles,
 * obra names) rather than for who is reading. Pure, so both call shapes below
 * share exactly one rule.
 */
export function threadLocale(managers: { language: string | null }[] | null, fallback: Locale): Locale {
  const first = managers?.[0]?.language;
  return first ? coerceLocale(first) : fallback;
}

/**
 * The same choice, for callers that do not already hold the company's profiles.
 *
 * Ordered by `created_at` so "the first manager" is a stable person rather than
 * whatever Postgres returned first — a thread whose notes changed language from
 * one day to the next would read as a bug in Capo.
 *
 * Fails soft to `fallback` on any read error, for the same reason
 * recordThreadEvent swallows: a note in the wrong language is a small problem,
 * and no note at all is the problem this issue is about.
 */
export async function readThreadLocale(db: Db, companyId: string, fallback: Locale): Promise<Locale> {
  const { data } = await db
    .from('profiles')
    .select('language')
    .eq('company_id', companyId)
    .order('created_at')
    .limit(1);
  return threadLocale(data ?? null, fallback);
}
