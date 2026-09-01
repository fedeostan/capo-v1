import type { Locale } from '@capo/i18n/locale';

// THE DETERMINISTIC LAYER IN FRONT OF THE WORKER AGENT.
//
// (Four tables since issue #120; the report table is also the one exception to
// the whole-message rule, and the only one the MANAGER path consults — see its
// own comment at the bottom.)
//
// Three keyword tables, one rule, and the rule is the point: a whole-message,
// case-insensitive, EXACT match, never a substring. "es que falta material" is
// a sentence, not a request to switch to Spanish; "stop, o Zé não vem hoje" is
// a sentence, not a withdrawal of consent; "ajuda-me a perceber isto" is a
// question for the agent, not a request for the menu. A substring match would
// read all three wrongly, silently, in the direction that costs somebody their
// message.
//
// ── WHY THEY LIVE HERE AND NOT IN THE ROUTE ─────────────────────────────────
// They were inline in apps/web/app/api/whatsapp/route.ts until issue #49 added
// the third table. Three sets that MUST stay pairwise disjoint cannot be
// checked by reading, and a Next route cannot be imported by a check script
// without dragging `next/server` in with it. Here they are pure — no Next, no
// Db, no network — so `pnpm whatsapp-check` asserts the disjointness on every
// pull request, along with the one property that matters most:
//
//     A BARE "ES" STILL RESOLVES TO SPANISH WITH ZERO MODEL CALLS.
//
// Moving the tables changed no ORDER. The order — check-in tap, menu tap,
// STOP/START, language, menu keyword, then the agent — still lives in
// handleWorkerReply, where it is visible next to the branches it governs, and
// it is that order (not this file) that keeps the agent last.

/**
 * Reply one of these, alone, and your briefing language changes.
 *
 * This lookup STAYS IN FRONT OF THE WORKER AGENT and must keep resolving "ES"
 * with zero model calls. It is free, instant, and the command surface every
 * briefing has trained the crew on; routing it through a model would be a
 * regression in cost and latency for the one thing that already works. The
 * agent has `set_my_language` for the sentence a lookup cannot answer
 * ("podes falar comigo em espanhol?").
 */
export const LANGUAGE_KEYWORDS: Record<string, Locale> = {
  pt: 'pt-PT',
  'pt-pt': 'pt-PT',
  portugues: 'pt-PT',
  português: 'pt-PT',
  es: 'es-ES',
  'es-es': 'es-ES',
  espanol: 'es-ES',
  español: 'es-ES',
  en: 'en-US',
  'en-us': 'en-US',
  english: 'en-US',
  ingles: 'en-US',
  inglês: 'en-US',
};

export function languageCommand(text: string | undefined): Locale | null {
  if (!text) return null;
  return LANGUAGE_KEYWORDS[text.trim().toLowerCase()] ?? null;
}

/**
 * Unsubscribe keywords, matched with the SAME whole-message discipline.
 *
 * Meta's business-messaging policy requires honouring opt-outs, and after 0025
 * this is the mechanism. `start` is the counterpart, so a worker who leaves can
 * come back without going through their manager.
 *
 * Deliberately no Portuguese "pare"/"parar" beyond the two below: the more
 * ordinary the word, the likelier a real sentence collides with it.
 */
export const OPT_OUT_KEYWORDS = new Set(['stop', 'parar', 'baja', 'sair', 'cancelar', 'unsubscribe']);
export const OPT_IN_KEYWORDS = new Set(['start', 'comecar', 'começar', 'alta', 'subscribe']);

export type ConsentCommand = 'opt_out' | 'opt_in';

export function consentCommand(text: string | undefined): ConsentCommand | null {
  if (!text) return null;
  const word = text.trim().toLowerCase();
  if (OPT_OUT_KEYWORDS.has(word)) return 'opt_out';
  if (OPT_IN_KEYWORDS.has(word)) return 'opt_in';
  return null;
}

/**
 * Whole-message keywords that summon the GUIDED MENU (issue #49).
 *
 * The third table, and the reason the other two moved out of the route. Same
 * discipline as both of them: exact, whole-message, case-insensitive.
 *
 * Deliberately DISJOINT from the two above, and asserted so on every pull
 * request. A collision would silently change which branch a word lands in, and
 * the branch that must never move is `es` — a bare "ES" has to keep resolving
 * to Spanish with zero model calls (AGENTS.md).
 *
 * `?` is in here because it is what somebody types when they do not know what
 * to type, and it is the one "word" that could never be a sentence.
 */
export const MENU_KEYWORDS = new Set([
  'menu',
  'menú',
  'ajuda',
  'ayuda',
  'help',
  'tarefas',
  'tareas',
  'tasks',
  'duvida',
  'dúvida',
  'duda',
  '?',
]);

export function menuCommand(text: string | undefined): boolean {
  if (!text) return false;
  return MENU_KEYWORDS.has(text.trim().toLowerCase());
}

/**
 * "Report a problem" keywords (issue #120), for BOTH sender kinds — the fourth
 * table, and the first one the manager path consults too.
 *
 * The reason it is deterministic is precise and stated in the issue: when
 * somebody reports that Capo is behaving badly, the last thing that should
 * decide whether the report is filed is Capo behaving well. A model that is
 * down, out of credit (31 Aug, issue #126) or wrong must not be able to lose
 * the message that says so.
 *
 * ── THE ONE DELIBERATE BREAK WITH THE WHOLE-MESSAGE RULE ────────────────────
 * The three tables above match the WHOLE message or nothing. This one also
 * accepts the keyword as the FIRST WORD with the report in the same message —
 * "bug o menu não abre" files immediately, because making a person send two
 * messages to say one thing loses reports. The cost is a real and accepted
 * false positive: a message that merely STARTS with one of these words
 * ("problema resolvido, obrigado") is filed as a report instead of reaching
 * the agent. That is visible, not silent — the sender is told it was
 * registered as a problem report and can rephrase — and the words were chosen
 * to make it rare. Mid-sentence occurrences never match: the keyword must be
 * the first word.
 *
 * Disjointness with the three tables above is asserted by `pnpm
 * whatsapp-check` like every other pair. `es`/`ajuda`/`stop` must keep landing
 * exactly where they land today.
 */
export const REPORT_KEYWORDS = new Set(['bug', 'problema', 'erro', 'problem', 'error', 'fallo']);

export type ReportCommand = { kind: 'arm' } | { kind: 'inline'; text: string };

/**
 * A bare keyword ("bug", "Problema:") arms the two-message flow; a keyword
 * followed by words in the same message files those words immediately.
 * Anything else — including the keyword anywhere but first — is null.
 *
 * Trailing punctuation on the keyword itself is stripped ("bug:", "erro —")
 * because it is how people address a labelled remark; nothing is stripped from
 * the report text, which is stored verbatim.
 */
export function reportCommand(text: string | undefined): ReportCommand | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const firstSpace = trimmed.search(/\s/);
  const head = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace))
    .toLowerCase()
    .replace(/[:,.;!—–-]+$/u, '');
  if (!REPORT_KEYWORDS.has(head)) return null;

  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
  return rest ? { kind: 'inline', text: rest } : { kind: 'arm' };
}
