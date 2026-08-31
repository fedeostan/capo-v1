import type { Locale, LocaleContext } from '@capo/i18n/locale';

// The generated language directive: the ONE place the two-dial rule is stated
// to the model. Generated rather than written into each persona because the
// rule depends on a pair of runtime values, and because stating it once means
// it cannot drift between the three persona files.

const NAMES: Record<Locale, string> = {
  'pt-PT': 'European Portuguese (pt-PT) — never Brazilian Portuguese',
  'es-ES': 'Peninsular Spanish (es-ES) — never Latin-American Spanish',
  'en-US': 'American English (en-US)',
};

// The same three languages named WITHOUT the dialect caveat. The caveat in
// NAMES is an instruction to the model ("never Brazilian Portuguese"); it is
// correct there and nonsense in a sentence the model is being told to say out
// loud to the manager, which is the only place this map is used.
const PLAIN_NAMES: Record<Locale, string> = {
  'pt-PT': 'Portuguese',
  'es-ES': 'Spanish',
  'en-US': 'English',
};

/** Human-readable name of a locale, for prompts that need to name a language. */
export function localeName(locale: Locale): string {
  return NAMES[locale];
}

export function buildLanguageDirective(locales: LocaleContext): string {
  const lines = [
    '# Language policy',
    `- SPEAK to the manager only in ${NAMES[locales.user]}. Every word you write to him is in that language.`,
    `- STORE domain text — task titles, job names and descriptions, memories, generated plan titles — in ${NAMES[locales.company]}. The dashboard is shared by the whole company and must read as one language.`,
  ];

  if (locales.user !== locales.company) {
    lines.push(
      `- These two DIFFER right now. You talk in ${NAMES[locales.user]} but you WRITE STORED TEXT in ${NAMES[locales.company]}: translate the manager's wording when you fill a title, name, or content field, and translate it back when you read those rows out to him.`,
      // Issue #55: the manager reported "tasks are created in Portuguese" while
      // reading English. Nothing was broken — the two dials had drifted apart —
      // but nothing anywhere told him that, so he had to infer a setting he did
      // not know existed from the output of it. The screens now carry a notice
      // (apps/web .../language-drift.tsx); this is the same fact said at the
      // moment it happens, by the only participant who is present for it.
      //
      // ONCE, and only on a write. Said on every turn it becomes noise the
      // manager reads past, which costs the signal exactly when it matters —
      // and the split is a legitimate configuration, not a fault to nag about.
      // This is a nudge, not a boundary: the model may over- or under-say it,
      // and the deterministic screen notice is what guarantees the message
      // lands at all.
      `- He may not KNOW they differ — they are two separate settings and he may only ever have moved one. So the FIRST time in a conversation that you store new text or raise a card that will store it, end that reply with ONE plain sentence: name the text you saved, and say that the company's stored language is ${PLAIN_NAMES[locales.company]} while you are talking to him in ${PLAIN_NAMES[locales.user]}. Say it once and then stop: no repeat on later writes in the same conversation, nothing when you are merely reading rows back to him, and never a lecture about the setting. If he asks about it, tell him he can put both on the same language on the Perfil (profile) screen under Language, and that doing it there also offers to translate what is already stored.`,
    );
  }

  lines.push(
    // Deliberately placed BEFORE the manager_instruction carve-out so that the
    // carve-out stays the last and most emphatic thing said about translating.
    // Do not reorder these two.
    '- If the manager wants the STORED data itself in another language ("traduz tudo para inglês", "pon todo en español", "put everything in Spanish"), call `translate_company_data`. It counts what would change and raises an approval card; it writes nothing on its own. `set_language` only changes what YOU speak — it never touches stored rows.',
    // This is the highest-consequence line in the whole prompt. The guard
    // (capabilities/guard.ts) authorizes a direct write by substring-matching
    // the model's quote against what the manager actually typed. A translated
    // quote matches nothing, so every direct write silently degrades into an
    // approval card — no error, just unexplainable friction for the manager.
    //
    // Edit by APPENDING only, never by rewording what is already here.
    '- `manager_instruction` is the ONE EXCEPTION, and it is absolute: it is the manager\'s own words, copied character-for-character in whatever language he used. NEVER translate, normalize, correct, or paraphrase it. A translated quote fails the authorization check and silently downgrades a direct command into an approval card. This holds most of all when the conversation is ABOUT translation.',
    '- The knowledge base is Portuguese, and its full-text ranking only works in Portuguese. ALWAYS write the `search_knowledge` query in Portuguese no matter what language the conversation is in, then translate the excerpt when you cite it.',
    `- Approval cards are rendered deterministically by the system in ${NAMES[locales.user]}. Never restate a card in your own words.`,
    // Appended, per the rule above. This is the language-facing half of "a card
    // travels alone" (agent/prompts/orchestration.ts): a card turn is silent in
    // EVERY language, so a model that stops writing the announcement in English
    // but keeps writing it in Portuguese is still wrong.
    //
    // ⚠ It also overrides the language-drift nudge above for card turns. That
    // nudge asks for one sentence at the end of a reply that raises a card —
    // which planAssistantMessages and the web chat now discard along with
    // everything else the model wrote in that turn. The nudge was never the
    // guarantee (see its own comment: the deterministic notice on the Perfil and
    // language screens is), so it degrades to "said on the next write that is
    // not a card" rather than to silence about the drift.
    '- A card is the entire message: when a tool returns `status: "proposed"`, write no text at all in that turn, in any language.',
  );

  return lines.join('\n');
}
