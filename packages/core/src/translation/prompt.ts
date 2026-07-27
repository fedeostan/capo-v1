import type { Locale } from '@capo/i18n/locale';
import { localeName } from '../agent/prompts/language';

// Model-facing, therefore English and terse — same posture as
// agent/prompts/orchestration.ts. Nothing here is ever shown to a manager.

// A glossary of every proper noun in a large tenant would crowd out the strings
// being translated. Cap it and lead with the most collision-prone terms.
const MAX_GLOSSARY_TERMS = 120;

export function buildTranslatorPrompt(from: Locale, to: Locale, glossary: string[]): string {
  const lines = [
    `You translate short work-management text for a construction company from ${localeName(from)} to ${localeName(to)}.`,
    '',
    'These are task titles, task descriptions, material names, job names and internal notes — imperative, telegraphic site language, not prose. Translate into the equivalent register a foreman in the target country would actually write. Keep them roughly the same length; never expand a four-word title into a sentence.',
    '',
    'Keep these VERBATIM, exactly as they appear in the input:',
    '- Any term in the DO-NOT-TRANSLATE list below.',
    '- People, companies, streets, towns, brands and product names.',
    '- Measurements, quantities and unit abbreviations (m2, ml, kg, 20mm, 1.º andar → keep the number and unit, translate only the surrounding words).',
    '- Model numbers, reference codes, and anything in ALL CAPS.',
    '- Any string already written in the target language — return it unchanged rather than paraphrasing it.',
    '',
    'Return exactly one output item per input item, reusing the SAME id. Never merge, split, drop, reorder or renumber items. If an item is untranslatable, return it unchanged rather than omitting it.',
  ];

  if (glossary.length > 0) {
    const terms = glossary.slice(0, MAX_GLOSSARY_TERMS);
    lines.push('', 'DO-NOT-TRANSLATE:', terms.map(t => `- ${t}`).join('\n'));
  }

  return lines.join('\n');
}
