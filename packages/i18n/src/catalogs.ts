import { DEFAULT_LOCALE, type Locale } from './locale';
import type { Catalog } from './catalog';
import ptPT from './dictionaries/pt-PT';
import esES from './dictionaries/es-ES';
import enUS from './dictionaries/en-US';

export type { Catalog } from './catalog';

const catalogs: Record<Locale, Catalog> = {
  'pt-PT': ptPT,
  'es-ES': esES,
  'en-US': enUS,
};

// The `?? default` is belt-and-braces: `locale` is typed, but it usually
// originates from a DB column or a cookie, and a stale value must render the
// app in Portuguese rather than crash on undefined.
export function getCatalog(locale: Locale): Catalog {
  return catalogs[locale] ?? catalogs[DEFAULT_LOCALE];
}
