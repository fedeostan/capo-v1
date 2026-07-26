import type { Locale } from '@capo/i18n/locale';
import type { PromptBlocks } from './prompt-blocks';
import ptPT from './prompt-blocks.pt-PT';
import esES from './prompt-blocks.es-ES';
import enUS from './prompt-blocks.en-US';

export type { PromptBlocks } from './prompt-blocks';

// Record<Locale, …>: adding a locale to @capo/i18n breaks this file until the
// blocks exist. That is the intended failure — a half-translated prompt is
// worse than a compile error.
export const promptBlocks: Record<Locale, PromptBlocks> = {
  'pt-PT': ptPT,
  'es-ES': esES,
  'en-US': enUS,
};
