import type { Locale } from '@capo/i18n/locale';
import ptPT from './capo.pt-PT';
import esES from './capo.es-ES';
import enUS from './capo.en-US';
import workerPtPT from './worker.pt-PT';
import workerEsES from './worker.es-ES';
import workerEnUS from './worker.en-US';

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

// The CREW voice, for the restricted worker agent. A second registry rather
// than a variant of the one above, and the same Record<Locale, string>
// discipline for the same reason — a new locale must break the build here too,
// or a Spanish-speaking bricklayer silently gets Portuguese.
//
// This is a registry, not manager logic: the two personas never mix, because
// buildSystemPrompt reads `personas` and buildWorkerSystemPrompt reads
// `workerPersonas`, and neither knows the other exists.
export const workerPersonas: Record<Locale, string> = {
  'pt-PT': workerPtPT,
  'es-ES': workerEsES,
  'en-US': workerEnUS,
};
