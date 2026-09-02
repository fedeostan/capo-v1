// The voice pass — the deterministic half of "Capo does not write like a
// machine" (issue: human tone).
//
// Sits beside whatsapp-markdown.ts because it is the same kind of thing: a
// pure function at the channel edge that rewrites the model's prose on its way
// out. The argument for putting it here rather than in the prompt is that
// file's argument, unchanged — a prompt is unverifiable and one edit away from
// silently regressing; a pure function is asserted in
// scripts/whatsapp-check.mts on every PR, with no credentials and no network.
//
// The prompt half is NOT redundant and must be kept: it is what stops the
// model wasting tokens writing a bulleted list nobody will see. This file is
// what makes the guarantee. Same split as "a card travels alone".
//
// ── Why this REPAIRS instead of refusing ───────────────────────────────────
//
// The email product this is modelled on REJECTS a draft that breaks a rule and
// never substitutes the character, for two stated reasons: a silent
// substitution changes a human author's words, and a silent fix hides a prompt
// that has started drifting.
//
// The first reason does not apply here. Nothing on this path is human-authored:
// it is one agent turn's prose, and the two things on the WhatsApp path that
// ARE hand-written — an approval card's renderedText and the daily briefing —
// never reach this function at all (see whatsapp.ts). The copy we author is
// gated statically instead, by `pnpm voice-check`.
//
// The second reason is real and is answered rather than dismissed: every repair
// is RETURNED, and the sink logs it as a counted event. The fix is silent to
// the reader, never to the log. If a prompt change makes the model start
// emitting em dashes on a third of turns, that shows up as `voice.repaired`
// rising — which a rejection would also have shown, at the cost of a second
// paid model call and, on a live conversation, a person waiting.
//
// ── Order matters ──────────────────────────────────────────────────────────
//
// Run AFTER toWhatsAppMarkdown and BEFORE splitForWhatsApp.
//
// After the converter, because it normalises every markdown dialect the model
// might emit down to one canonical form (bullets are already `- `, bold is
// already a single `*`, code is already protected). Stripping emphasis from
// that canonical form is a handful of regexes; stripping it from raw markdown
// would be a second copy of the converter.
//
// Before the splitter, for the converter's own reason: splitting first could
// cut a `*` pair across a chunk boundary, leaving a marker this pass can no
// longer recognise as one.
//
// `f(f(x)) === f(x)` is a required property, asserted in the check script. It
// holds by construction: every rule removes a shape rather than adding one.

export type VoiceRule = 'em_dash' | 'flatten_formatting' | 'emoji_cap' | 'banned_closer';

/**
 * One thing that was wrong with a draft.
 *
 * `detail` is written as a full sentence addressed to the model, deliberately:
 * the same object then serves the log line, an operator-facing report, and a
 * retry prompt if one is ever added, without three copies of "what went wrong"
 * drifting apart.
 */
export interface VoiceRepair {
  rule: VoiceRule;
  detail: string;
}

export interface VoiceResult {
  text: string;
  repairs: VoiceRepair[];
}

// U+2012 figure dash, U+2013 en dash, U+2014 em dash, U+2015 horizontal bar.
// All four are the same tell: nobody produces one on a phone keyboard without
// a long press, which is exactly why the em dash is such a clean signal.
const DASHES = '‒–—―';
const DASH_CLASS = `[${DASHES}]`;

// Assistant reflexes. Deliberately CONSERVATIVE, and the restraint is the
// point: "qualquer coisa, é só dizer" is how a Portuguese foreman actually ends
// a message, so it is NOT here. What is here is the corporate-support register
// that no site manager has ever used — the phrases Poke's own guidelines ban,
// plus their pt-PT and es-ES equivalents.
//
// Matched in every language regardless of the conversation's locale. A
// Portuguese phrase cannot appear in an English message, so threading a locale
// through this function would buy nothing and cost a parameter.
const BANNED_CLOSERS: RegExp[] = [
  // en-US
  /\blet me know if you need (anything else|any(thing)? (further|more)|assistance)\b[^\n]*/gi,
  /\bis there anything else i can (help|assist) you with\b[^\n]*/gi,
  /\bi (apologi[sz]e|am sorry) for the confusion\b[^\n]*/gi,
  /\bi'?m here to help\b[^\n]*/gi,
  /\b(feel free to|don'?t hesitate to) (ask|reach out)\b[^\n]*/gi,
  /\bhope this message finds you well\b[^\n]*/gi,
  // pt-PT
  /\bespero que esta mensagem (te|o) encontre bem\b[^\n]*/gi,
  /\bn[ãa]o hesites? em (perguntar|contactar)\b[^\n]*/gi,
  /\bestou (aqui )?para ajudar\b[^\n]*/gi,
  /\b(fico|estou) (sempre )?[àa] (tua )?disposi[çc][ãa]o\b[^\n]*/gi,
  /\bpe[çc]o desculpa pela confus[ãa]o\b[^\n]*/gi,
  /\bh[áa] mais alguma coisa em que (te )?possa ajudar\b[^\n]*/gi,
  // es-ES
  /\bespero que este mensaje te encuentre bien\b[^\n]*/gi,
  /\bno dudes en (preguntar|contactar)\b[^\n]*/gi,
  /\bestoy (aqu[íi] )?para ayudar\b[^\n]*/gi,
  /\bquedo a tu disposici[óo]n\b[^\n]*/gi,
  /\bpido disculpas por la confusi[óo]n\b[^\n]*/gi,
  /\bhay algo m[áa]s en lo que pueda ayudarte\b[^\n]*/gi,
];

// One emoji "cluster": a pictographic character plus any skin-tone modifier or
// variation selector, plus any zero-width-joined continuations (👨‍👩‍👧 is ONE
// emoji, not three). Flags are pairs of regional indicators and are matched
// separately. Getting this wrong does not under-count — it shreds a family
// emoji into fragments, which is worse than the problem.
const EMOJI = new RegExp(
  '(?:\\p{RI}\\p{RI})' +
    '|(?:\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)?' +
    '(?:\\u200D\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)?)*)',
  'gu',
);

/**
 * Long dashes out.
 *
 * Four shapes, and the distinction between them is what stops the fix reading
 * worse than the tell:
 *
 *   "10—12 dias"        → a range. Becomes a hyphen, which is what a person
 *                         types.
 *   "— pintar a sala"   → a line-leading dash is a BULLET, not punctuation.
 *                         The marker goes, the line stays.
 *   "Feito, — a sala"   → the clause is already punctuated. The dash goes and
 *                         nothing replaces it; a comma here would double up.
 *   "a demolição — que  → everything else. Becomes a comma, which is the one
 *    começa segunda"      replacement that is never wrong: the dominant LLM
 *                         shape is a parenthetical, and turning BOTH of its
 *                         dashes into full stops shreds the sentence, while
 *                         commas restore it exactly.
 */
function fixDashes(input: string): string {
  let out = input;
  // Ranges first: 10—12, 2013—2014. Before anything else, or the general rule
  // below would put a comma between two numbers.
  out = out.replace(new RegExp(`(\\d)\\s*${DASH_CLASS}\\s*(?=\\d)`, 'g'), '$1-');
  // A dash opening a line is a bullet marker.
  out = out.replace(new RegExp(`^[ \\t]*${DASH_CLASS}[ \\t]+`, 'gm'), '');
  // Already-punctuated left side: drop the dash, keep the punctuation.
  out = out.replace(new RegExp(`([,;:])\\s*${DASH_CLASS}\\s*`, 'g'), '$1 ');
  // Everything else becomes a comma, tucked against the word on its left.
  out = out.replace(new RegExp(`\\s*${DASH_CLASS}\\s*`, 'g'), ', ');
  // A dash that ended a line leaves a dangling comma behind it.
  out = out.replace(/,\s*$/gm, '');
  out = out.replace(/,\s*([.!?])/g, '$1');
  return out;
}

/**
 * Formatting markup out. WhatsApp-only: nobody sends a bulleted list or a bold
 * word to a person on WhatsApp, and the app chat renders markdown properly, so
 * there is nothing to strip there.
 *
 * Runs on the CANONICAL form toWhatsAppMarkdown produces, which is why this is
 * short. Code spans are deliberately left alone: they are vanishingly rare in
 * site talk and mangling one is worse than leaving it.
 */
function flattenFormatting(input: string): string {
  let out = input;
  // List markers: "- ", "* ", "• ", "1. ", "1) ".
  out = out.replace(/^[ \t]*(?:[-*•·][ \t]+|\d+[.)][ \t]+)/gm, '');
  // Block quotes.
  out = out.replace(/^[ \t]*>[ \t]?/gm, '');
  // Emphasis.
  //
  // ⚠ The word-boundary guards are load-bearing, not tidiness. Without them
  // `_` eats the inside of anything containing two underscores, and the two
  // things that contain two underscores are URLs and identifiers:
  //
  //   https://capo.pt/dia/a_b_c   →   https://capo.pt/dia/abc   (a dead link)
  //   manager_instruction         →   managerinstruction
  //
  // The first is the serious one, because #114's crew day page is a bearer
  // token in a URL: a mangled link does not fail loudly, it 404s for the one
  // person who needed it. `(?<!\w)` and `(?!\w)` mean a marker only counts
  // when it stands at the edge of a word, which is where emphasis actually
  // lives and where neither of those two shapes has one.
  //
  // This also leaves whatsapp-markdown.ts's documented non-goal exactly where
  // it was: `snake_case` still renders italic on WhatsApp. Rendering it italic
  // is a cosmetic defect; silently deleting characters out of the middle of it
  // is a wrong string.
  //
  // Runs of markers first, exactly as the converter orders its own passes:
  // `***` before `**` before a single `*`, or emphasis shreds into unbalanced
  // markers. In production toWhatsAppMarkdown has already collapsed these, so
  // this pass usually finds nothing. It is here so the function is CORRECT on
  // its own rather than only correct downstream of another one, which is what
  // exporting `applyVoice` separately already invites somebody to try.
  out = out.replace(/(?<!\w)\*{2,3}(?=\S)([^\n]*?\S)\*{2,3}(?!\w)/g, '$1');
  out = out.replace(/(?<!\w)_{2,3}(?=\S)([^\n]*?\S)_{2,3}(?!\w)/g, '$1');
  out = out.replace(/(?<!\w)\*(?=\S)([^\n*]*?\S)\*(?!\w)/g, '$1');
  out = out.replace(/(?<!\w)_(?=\S)([^\n_]*?\S)_(?!\w)/g, '$1');
  out = out.replace(/(?<!\w)~(?=\S)([^\n~]*?\S)~(?!\w)/g, '$1');
  return out;
}

/** Keep the first emoji, drop the rest. */
function capEmoji(input: string): { text: string; removed: number } {
  let seen = 0;
  let removed = 0;
  const text = input.replace(EMOJI, match => {
    seen += 1;
    if (seen === 1) return match;
    removed += 1;
    return '';
  });
  return { text, removed };
}

function stripBannedClosers(input: string): { text: string; hits: string[] } {
  const hits: string[] = [];
  let out = input;
  for (const pattern of BANNED_CLOSERS) {
    out = out.replace(pattern, match => {
      hits.push(match.trim());
      return '';
    });
  }
  return { text: out, hits };
}

/** Collapse the whitespace every removal above leaves behind. */
function tidy(input: string): string {
  return input
    .replace(/[ \t]+/g, ' ')
    // Removing a mid-sentence emoji or a trailing reflex leaves behind the space
    // that stood in front of it: "faz-se 💪." becomes "faz-se .". A gap before a
    // full stop is its own tell, and a more obvious one than what was removed.
    .replace(/ +([.,!?;:…])/g, '$1')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The channel-agnostic rules: the tells that are tells everywhere. Exported on
 * its own so the in-app chat can adopt them later without splitting this file
 * — there, formatting is rendered properly and must NOT be flattened.
 */
export function applyVoice(input: string): VoiceResult {
  const repairs: VoiceRepair[] = [];

  const closers = stripBannedClosers(input);
  if (closers.hits.length > 0) {
    repairs.push({
      rule: 'banned_closer',
      detail: `contains an assistant reflex (${closers.hits.join('; ')}). End on the last useful word instead; do not offer further help, do not apologise for confusion.`,
    });
  }

  let text = closers.text;

  if (new RegExp(DASH_CLASS).test(text)) {
    repairs.push({
      rule: 'em_dash',
      detail:
        'contains a long dash, the single clearest tell that a machine wrote the message: on a phone keyboard it needs a long press, so almost nobody types one. Use a comma, a full stop or a colon. A hyphen in a compound word or a range is fine.',
    });
    text = fixDashes(text);
  }

  const emoji = capEmoji(text);
  if (emoji.removed > 0) {
    repairs.push({
      rule: 'emoji_cap',
      detail: `uses ${emoji.removed + 1} emoji. At most one per message, and none at all is usually better.`,
    });
    text = emoji.text;
  }

  return { text: tidy(text), repairs };
}

/**
 * The full WhatsApp pass: the channel-agnostic rules plus flattening, because
 * markup on WhatsApp is itself a tell.
 *
 * NOT applied to an approval card's renderedText and NOT applied to the daily
 * briefing. Both are hand-authored records rather than model prose, and in
 * whatsapp.ts they travel down a branch this function is not on — so that is a
 * structural fact about the code, not a rule somebody has to remember.
 */
export function applyWhatsAppVoice(input: string): VoiceResult {
  const flat = flattenFormatting(input);
  const repairs: VoiceRepair[] = [];
  if (flat !== input) {
    repairs.push({
      rule: 'flatten_formatting',
      detail:
        'uses formatting markup (bold, italics, a bullet or numbered list, a heading or a quote). Nobody sends a formatted document to somebody on WhatsApp. Write plain sentences, one per line where a list is needed.',
    });
  }
  const rest = applyVoice(flat);
  return { text: rest.text, repairs: [...repairs, ...rest.repairs] };
}
