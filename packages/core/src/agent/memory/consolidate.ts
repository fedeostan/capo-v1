import { generateObject } from 'ai';
import { z } from 'zod';
import type { Db } from '@capo/db/client';
import type { Locale } from '@capo/i18n/locale';
import { getModel } from '../models';
import { localeName } from '../prompts/language';
import { MEMORY_CONTENT_MAX_CHARS, selectPromptMemories, type MemoryRow } from './prompt-memories';

// ── THE NIGHT SHIFT (issue #48) ─────────────────────────────────────────────
//
// A second agent, with a different job, that re-reads the manager's own thread
// once a night and asks one question: is there anything here Capo should still
// know in three months?
//
// The technique has a name and a literature — "sleep-time compute" (Letta + UC
// Berkeley, arXiv:2504.13171): move the expensive reading OFF the path where a
// human is waiting, into a background pass that turns raw context into a
// smaller learned context. The paper's own caveat is the one to keep in mind —
// the benefit tracks how PREDICTABLE the later questions are from the context,
// and pre-computing answers nobody asks for is just a bill. Capo's case is the
// favourable one: a small, very predictable world (this manager's jobs, crew,
// materials, preferences) queried many times against the same background.
//
// ── WHAT THIS FILE IS NOT ALLOWED TO READ ──────────────────────────────────
// `messages` — the MANAGER's thread — and nothing else. Never `worker_messages`.
// That is not a preference, it is the same boundary AGENTS.md draws for the
// manager agent, extended to its longest-lived surface: a worker's typed words
// must never reach the manager's context, and a memory written from a worker's
// message would be that rule broken PERMANENTLY rather than for one turn. There
// is a published attack on exactly this (MINJA, arXiv:2503.03704) that plants
// instructions in an agent's memory using nothing but ordinary messages, with a
// reported success rate above 95% and no visible change in behaviour. The
// separate-tables design (0027) is what makes the rule structural here: this
// file has no query that could reach a worker's text.
//
// There is a SECOND route into this file that 0027 does not cover, and it is
// not a query at all. A manager tool can RETURN a worker's words: `crew_requests`
// exists so the manager can ask "what did they ask me for?" and read the crew's
// own sentences back. That answer rides home inside Capo's assistant message,
// and `persistAssistantMessage` stores the whole message, tool parts included.
// So a row in `messages` whose role is `assistant` and whose author is Capo can
// still contain, verbatim, something a crew member typed. Nothing about that is
// wrong for the live turn, which is the entire feature. It is wrong HERE,
// because what this file writes is permanent and unreviewed. `transcriptText`
// below is the answer: an allowlist of one part type, owned by this file, and
// gated by `pnpm memory-check` so widening it cannot be silent.
//
// ── FOUR THINGS THAT LOOK LIKE DETAILS AND ARE NOT ─────────────────────────
//  1. IT WRITES MEMORIES, NOT PROSE. The summarizer beside it writes a paragraph
//     that nothing can inspect line by line and the manager cannot delete a
//     sentence of. This writes rows, which /perfil/memoria lists and forgets one
//     at a time.
//  2. "NOTHING TONIGHT" IS AN EXPLICIT ANSWER, not an absence. Taken from Mem0
//     (arXiv:2504.19413), whose extractor must choose between ADD/UPDATE/DELETE
//     and NOOP: making "write nothing" something the reviewer actively selects
//     is the only architectural answer to over-extraction I found in the
//     literature, and most nights genuinely hold nothing durable.
//  3. IT IS SHOWN WHAT IT ALREADY KNOWS, so its instruction is "add what is
//     missing" rather than "write what you noticed". Cheap, and it is the main
//     lever against forty near-identical restatements of one fact.
//  4. IT NEVER WRITES A NAME (issue #62). Enforced in CODE below, not by the
//     prompt: a prompt rule is a request, and this one has to hold against a
//     model that has just read a conversation full of the manager's name.
//
// ── WHAT IT DELIBERATELY CANNOT DO ─────────────────────────────────────────
// It cannot DEACTIVATE a memory. Letting a model retire the manager's notes
// unattended at 03:00 is a bigger idea than it looks, and its first version
// should not run unwatched. Forgetting is the manager's, on /perfil/memoria; the
// READ-TIME cap in ./prompt-memories.ts is what stops the table mattering.
//
// It also cannot write a PERSONAL (per-profile) memory, and that is a finding
// rather than a choice: `conversations` is per COMPANY and `messages` carries no
// author, so at 03:00 there is no honest way to say whose preference something
// was. Personal memories come only from the two paths that know who is speaking
// — the `remember` tool during a live turn, and the manager's own screen.

/** New memories one run may add. The growth bound at the WRITE side. */
export const MAX_NEW_MEMORIES_PER_RUN = 5;

/**
 * Messages one run may read.
 *
 * Also the drain rate for a backlog: the watermark advances to the last row
 * READ, so a company returning from a long silence is consolidated 200 messages
 * a night over successive nights rather than in one enormous, expensive call
 * that risks the function's duration ceiling.
 */
export const MAX_MESSAGES_PER_RUN = 200;

/**
 * Below this, the run does nothing AND DOES NOT ADVANCE THE WATERMARK.
 *
 * A quiet week is not worth a Sonnet call, and leaving the window unconsumed is
 * strictly better than dribbling it away: the messages accumulate and are
 * eventually consolidated together, with more context than any one night had.
 * This is the same catch-up property the watermark exists for, doing useful work
 * rather than merely recovering from failure.
 */
export const MIN_MESSAGES_TO_CONSOLIDATE = 6;

/** The `kind` values `memories` allows (0001). */
const MEMORY_KINDS = ['company', 'job', 'worker', 'preference', 'fact'] as const;

const consolidationSchema = z.object({
  // The NOOP branch, first in the object so the model commits to it before
  // writing anything. When true, `memories` is ignored entirely — belt and
  // braces against a model that sets the flag and then lists items anyway.
  nothing_worth_keeping: z
    .boolean()
    .describe(
      'True when this stretch of conversation holds nothing that should still be known in three months. This is the NORMAL answer for most days — choose it rather than reaching for something.',
    ),
  memories: z
    .array(
      z.object({
        kind: z.enum(MEMORY_KINDS),
        content: z.string().min(1).max(MEMORY_CONTENT_MAX_CHARS),
      }),
    )
    .max(MAX_NEW_MEMORIES_PER_RUN)
    .describe('Durable facts to add. Empty when nothing_worth_keeping is true.'),
});

export interface ConsolidationCandidate {
  kind: (typeof MEMORY_KINDS)[number];
  content: string;
}

export interface ConsolidationRejections {
  duplicate: number;
  name: number;
  invalid: number;
}

export interface FilteredCandidates {
  accepted: ConsolidationCandidate[];
  rejected: ConsolidationRejections;
}

/**
 * The ONLY thing the night agent is allowed to read out of a stored message:
 * the parts whose `type` is exactly `text`. That is an allowlist of one, and it
 * is a boundary rather than tidiness.
 *
 * WHAT IT KEEPS OUT, AND WHY IT MATTERS HERE MORE THAN ANYWHERE ELSE.
 * A row in `messages` is a whole AI SDK `UIMessage`, persisted wholesale by
 * `persistAssistantMessage`. Alongside Capo's spoken text that carries the tool
 * traffic of the turn: `tool-<name>` and `dynamic-tool` parts holding the exact
 * `input` the model sent and the exact `output` the tool returned, plus
 * `reasoning`, `file` and provider `data-*` parts. Tool output is database rows
 * verbatim, and some of those rows are prose a CREW MEMBER typed.
 * `crew_requests` is the worked example: it exists so the manager can ask "what
 * did they ask me for?" and get their own words back, which is the whole point
 * of the feature and must not change.
 *
 * A worker's words reaching the manager's live context for one turn is what
 * that feature is FOR. A worker's words reaching this file is a different
 * thing, because what this file produces is permanent: an accepted candidate
 * becomes a row in `memories`, is injected into every future system prompt for
 * that company, and is never re-checked by anything. AGENTS.md states the rule
 * this function makes true ("reads `messages` and nothing else, never
 * `worker_messages` ... a memory written from one would be that rule broken
 * PERMANENTLY rather than for one turn"), and the separate-tables design of
 * 0027 enforces it against the obvious route. A tool result is the route that
 * design does not cover, because it does not come from `worker_messages` at
 * read time at all: it arrives inside the manager's OWN assistant row.
 *
 * WHY THIS IS NOT `rowText`, WHICH ALREADY DOES THE SAME FILTERING.
 * It does today, and that is exactly the problem. `rowText` serves the live
 * window (`toThread`) and the duplicate-apology check in `turn-failure.ts`,
 * where widening it is a local, reasonable-looking change with no visible
 * memory consequence: rendering a tool result into an event line, or picking up
 * `reasoning` parts, would be a one-line edit in a file that says nothing about
 * permanence. Sharing one helper made this exclusion an ACCIDENT of another
 * function's job. Two functions is the correct amount of duplication here
 * because they answer two different questions: `rowText` asks "what was said in
 * this thread", and this asks "what may become permanent". Do not merge them
 * back together, and do not widen this one to add context for the night agent.
 * If a future reader genuinely needs tool output in the transcript, the thing
 * to change first is the promise in AGENTS.md, not this filter.
 *
 * `pnpm memory-check` drives this function with a row carrying crew prose in a
 * tool result and asserts none of it comes back out.
 */
export function transcriptText(content: unknown): string {
  const parts = (content as { parts?: Array<{ type?: unknown; text?: unknown }> } | null)?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(part => part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0)
    .map(part => part.text as string)
    .join('\n');
}

/**
 * Fold a string down to the form two "same" memories share.
 *
 * Accents are stripped as well as case, because the three languages this
 * product speaks disagree about them constantly and "Cliente prefere manhãs"
 * and "cliente prefere manhas" are the same fact written twice.
 */
export function normalizeMemory(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Does this candidate name somebody whose name is a database row?
 *
 * ── WHY THIS IS CODE AND NOT A PROMPT LINE (issue #62) ─────────────────────
 * A manager renamed himself on /perfil and Capo kept addressing him by the old
 * surname for weeks, because the old name was frozen inside a summary that
 * nothing ever re-checks. A MEMORY is the same trap with a longer fuse: it is
 * re-read into every turn indefinitely, and unlike the summary it is never even
 * merged forward, so nothing launders it out. The summarizer was told not to
 * write the name; that instruction is fine there because a summary is prose a
 * human reads. Here the stakes are higher and the enforcement is a filter.
 *
 * ── WHOSE NAMES, AND WHY NOT EVERYBODY'S ───────────────────────────────────
 * Profiles and the company only. Deliberately NOT workers: "Zé is slow on
 * tiling" is a legitimate, valuable memory and `kind: 'worker'` exists for
 * exactly it — the crew's names are all over the product by design. Managers and
 * the company are different: both are already LIVE FACTS in the system prompt
 * (loadManagerName / loadCompanySnapshot), read fresh every turn, so a memory
 * naming them can only ever agree redundantly or disagree wrongly.
 *
 * Profile names are also matched TOKEN by token, for tokens of four characters
 * or more, because a rename usually changes the surname alone. The asymmetry is
 * on purpose: over-rejecting costs one memory that could have been written
 * differently, under-rejecting costs a wrong name in every prompt for months.
 * Short tokens are skipped so a two-letter particle ("de", "da") does not reject
 * everything.
 */
export function mentionsForbiddenName(content: string, forbiddenNames: string[]): boolean {
  const haystack = ` ${normalizeMemory(content)} `;
  for (const name of forbiddenNames) {
    const normalized = normalizeMemory(name);
    if (normalized.length === 0) continue;
    if (haystack.includes(` ${normalized} `)) return true;
    for (const token of normalized.split(' ')) {
      if (token.length >= 4 && haystack.includes(` ${token} `)) return true;
    }
  }
  return false;
}

/**
 * The deterministic gate between the model's output and the database.
 *
 * PURE, and exported for `pnpm memory-check`. This is the highest-risk function
 * in the feature: everything it lets through is injected into every future
 * system prompt for this company, so a defect here is not a wrong answer once,
 * it is a wrong answer for ever, at a cost, silently.
 *
 * Order matters only for the rejection COUNTS, which are a log line. A candidate
 * that is both a duplicate and a name is counted once, as a duplicate.
 */
export function filterCandidates(
  candidates: ConsolidationCandidate[],
  existing: MemoryRow[],
  forbiddenNames: string[],
): FilteredCandidates {
  const seen = new Set(existing.map(row => normalizeMemory(row.content)));
  const accepted: ConsolidationCandidate[] = [];
  const rejected: ConsolidationRejections = { duplicate: 0, name: 0, invalid: 0 };

  for (const candidate of candidates) {
    if (accepted.length >= MAX_NEW_MEMORIES_PER_RUN) break;

    const content = candidate.content.trim();
    // The schema already bounds these, but the schema is the MODEL's contract
    // and this is the DATABASE's: `memories_content_length` (0037) is a CHECK,
    // and a rejected insert here would be an exception on a background job
    // rather than a retryable tool error.
    if (content.length === 0 || content.length > MEMORY_CONTENT_MAX_CHARS) {
      rejected.invalid += 1;
      continue;
    }

    const normalized = normalizeMemory(content);
    // `seen` grows as we go, so two near-identical candidates inside ONE run
    // collide with each other and not merely with history.
    if (normalized.length === 0 || seen.has(normalized)) {
      rejected.duplicate += 1;
      continue;
    }
    if (mentionsForbiddenName(content, forbiddenNames)) {
      rejected.name += 1;
      continue;
    }

    seen.add(normalized);
    accepted.push({ kind: candidate.kind, content });
  }

  return { accepted, rejected };
}

export interface ConsolidationInput {
  /**
   * The SERVICE ROLE client. There is no `auth.uid()` on this path, so RLS
   * backstops nothing and `conversationId` — resolved from `companyId` by the
   * caller — is the entire tenant boundary for the read below. Do not add a
   * caller that supplies a conversation id from anywhere else.
   */
  db: Db;
  companyId: string;
  conversationId: string;
  /** The watermark: consolidate strictly after this instant. Null = the lot. */
  since: string | null;
  /**
   * `companies.language`, not `profiles.language`. Memories are STORED data and
   * the company dial is what governs stored data (AGENTS.md's three dials) —
   * the same rule that puts task titles and job names in it.
   */
  companyLocale: Locale;
  /** Company name + every profile full_name. See `mentionsForbiddenName`. */
  forbiddenNames: string[];
  /**
   * Every company-scoped memory already held — the caller's WHOLE read (up to
   * MEMORY_READ_LIMIT), NOT the capped prompt window.
   *
   * The two are used differently on purpose. DEDUPLICATION runs against all of
   * them, because a fact that has fallen out of the 40-row window is still
   * stored and re-writing it would create a duplicate that then displaces the
   * original — growth with nothing gained. What is SHOWN to the model is the
   * capped subset, because that is what it would cost tokens to send and the
   * window is where a repetition would actually be visible.
   */
  existing: MemoryRow[];
}

export interface ConsolidationOutcome {
  status: 'done' | 'empty';
  messagesRead: number;
  written: number;
  /** created_at of the last message consumed, or null when nothing was. */
  coversUntilAt: string | null;
  rejected: ConsolidationRejections;
}

/**
 * One company's night.
 *
 * THROWS on a genuine failure (an unreadable thread, a model error, a failed
 * insert) so the caller can record the run as failed and, crucially, NOT advance
 * the watermark. Swallowing here would silently mark a window consumed that was
 * never read — the one failure mode in this feature that loses information
 * rather than merely delaying it.
 */
export async function consolidateCompanyMemory(input: ConsolidationInput): Promise<ConsolidationOutcome> {
  const empty = (messagesRead: number): ConsolidationOutcome => ({
    status: 'empty',
    messagesRead,
    written: 0,
    coversUntilAt: null,
    rejected: { duplicate: 0, name: 0, invalid: 0 },
  });

  let query = input.db
    .from('messages')
    .select('*')
    .eq('conversation_id', input.conversationId)
    .order('created_at', { ascending: true })
    .limit(MAX_MESSAGES_PER_RUN);
  if (input.since) query = query.gt('created_at', input.since);

  const { data: rows, error } = await query;
  if (error) throw new Error(`consolidation: could not read thread: ${error.message}`);

  // role='event' rows are EXCLUDED from the transcript entirely, and that is a
  // cost decision as much as a quality one. Since #47 the system writes several
  // a day — what the briefing said, who the check-in asked, who answered — all
  // of it generated from our own copy and from data that is already in `tasks`
  // and `notification_log`. Consolidating them would mean paying a model to
  // consider writing down facts the database already holds, which the
  // orchestration policy tells the live agent never to do.
  const spoken = (rows ?? []).filter(row => row.role === 'user' || row.role === 'assistant');
  if (spoken.length < MIN_MESSAGES_TO_CONSOLIDATE) return empty(spoken.length);

  const transcript = spoken
    .map(row => {
      const day = row.created_at.slice(0, 10);
      const speaker = row.role === 'user' ? 'Manager' : 'Capo';
      return `[${day}] ${speaker}: ${transcriptText(row.content) || '(no text)'}`;
    })
    .join('\n');

  // Shown to the model: the same capped window the live agent carries, so "do
  // not repeat these" describes what it would actually be repeating.
  const shown = selectPromptMemories(input.existing, null).carried;
  const known =
    shown.length > 0
      ? shown.map(row => `- [${row.kind}] ${row.content}`).join('\n')
      : '(nothing stored yet)';

  const { object } = await generateObject({
    model: getModel('consolidation', {
      db: input.db,
      companyId: input.companyId,
      surface: 'consolidation',
      // 'system': company-wide work nobody personally asked for in the moment.
      // There is no profile to bill — `messages` carries no author — and
      // inventing one would be exactly the fabricated attribution `UsageActor`'s
      // discriminated union exists to make inexpressible.
      actor: { kind: 'system' },
    }),
    schema: consolidationSchema,
    // Scaffolding in English (model-facing), output language named explicitly —
    // the same shape as the summarizer beside it.
    system: [
      'You review one day or more of conversation between a small construction company manager and his AI foreman (Capo), and decide what — if anything — is worth remembering permanently.',
      `Write every memory in ${localeName(input.companyLocale)}.`,
      '',
      'KEEP only durable facts: standing preferences about how this manager works, client and supplier facts, recurring constraints, commitments that outlive the conversation.',
      'NEVER keep: anything already recorded as a task, a job, a worker, a date or a status — that lives in the database and is read fresh every turn, so a memory of it can only go stale. Nor greetings, chit-chat, one-off requests, or a restatement of something already in the list of what is known.',
      'NEVER write a person\'s name or the company\'s name. Say "the manager", "the company", or the role. Names are live data that change, and a name frozen here is read back for months after it stops being true.',
      '',
      `Add at most ${MAX_NEW_MEMORIES_PER_RUN} memories, each one self-contained and at most ${MEMORY_CONTENT_MAX_CHARS} characters.`,
      'Most reviews should find NOTHING. Set nothing_worth_keeping and return an empty list rather than reaching for something to say — a memory that was not worth writing costs money on every future message and crowds out one that was.',
    ].join('\n'),
    prompt: [
      `Already known (do not repeat or rephrase any of these):\n${known}`,
      `Conversation:\n${transcript}`,
      'What, if anything, should be remembered permanently?',
    ].join('\n\n'),
  });

  const coversUntilAt = spoken[spoken.length - 1].created_at;

  const candidates = object.nothing_worth_keeping ? [] : object.memories;
  const { accepted, rejected } = filterCandidates(candidates, input.existing, input.forbiddenNames);

  if (accepted.length === 0) {
    return { status: 'empty', messagesRead: spoken.length, written: 0, coversUntilAt, rejected };
  }

  // `profile_id: null` is stated rather than omitted: this pass writes
  // COMPANY-scoped memories only, always, and the explicit null is where that
  // rule is visible at the write site.
  const { error: writeError } = await input.db.from('memories').insert(
    accepted.map(candidate => ({
      company_id: input.companyId,
      profile_id: null,
      kind: candidate.kind,
      content: candidate.content,
    })),
  );
  if (writeError) throw new Error(`consolidation: could not store memories: ${writeError.message}`);

  return { status: 'done', messagesRead: spoken.length, written: accepted.length, coversUntilAt, rejected };
}
