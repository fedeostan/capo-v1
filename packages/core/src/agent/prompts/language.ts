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
  );

  return lines.join('\n');
}
