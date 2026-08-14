import type { Locale } from '@capo/i18n/locale';

// THE DETERMINISTIC LAYER IN FRONT OF THE WORKER AGENT.
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
