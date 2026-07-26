import type { Locale } from '@capo/i18n/locale';
import ptPT from './capo.pt-PT';
import esES from './capo.es-ES';
import enUS from './capo.en-US';

// Static imports, not dynamic import(): three strings of ~1.5 KB each. A lazy
// loader would add bundler complexity and a promise to buildSystemPrompt in
// exchange for saving nothing.
//
// Record<Locale, string> is the point of this file: add a locale to
// @capo/i18n and this stops compiling until the persona exists, so a locale can
// never ship with Capo silently falling back to Portuguese.
export const personas: Record<Locale, string> = {
  'pt-PT': ptPT,
  'es-ES': esES,
  'en-US': enUS,
};
