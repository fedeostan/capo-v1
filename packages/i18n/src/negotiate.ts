import { DEFAULT_LOCALE, LOCALES, type Locale } from './locale';

// Accept-Language negotiation, for the pages that have no session to read a
// locale from: /login, /registar, /landing, /onboarding. Once a user is
// authenticated, profiles.language is authoritative and this is never consulted.
//
// Deliberately hand-rolled rather than reaching for a negotiation library: the
// entire problem is "pick one of three", and a dependency that ships its own
// CLDR tables would dwarf the code it replaces.

/** Base language subtag → our locale. 'pt-BR' still lands on pt-PT: the persona
 *  refuses to speak Brazilian Portuguese anyway, and pt-PT is far closer than
 *  English for a Brazilian visitor. */
const BASE_LANGUAGE: Record<string, Locale> = {
  pt: 'pt-PT',
  es: 'es-ES',
  en: 'en-US',
};

interface Ranked {
  tag: string;
  q: number;
}

function parseAcceptLanguage(header: string): Ranked[] {
  return header
    .split(',')
    .map(part => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.find(p => p.trim().startsWith('q='));
      // A malformed q= must not sort above an explicit one — NaN would make
      // every comparison false and silently freeze the input order.
      const parsed = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
      const q = Number.isFinite(parsed) ? parsed : 0;
      return { tag: tag.trim().toLowerCase(), q };
    })
    .filter(r => r.tag.length > 0 && r.q > 0)
    .sort((a, b) => b.q - a.q);
}

/**
 * Pick the best-supported locale from an Accept-Language header.
 * Exact matches ('pt-pt') win over base-language matches ('pt' → pt-PT), but
 * only within the same q-value bucket — a client that ranks `es` above `pt-PT`
 * gets Spanish, as it asked.
 */
export function negotiateLocale(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;

  const exact = new Map(LOCALES.map(l => [l.toLowerCase(), l]));

  for (const { tag } of parseAcceptLanguage(header)) {
    if (tag === '*') return DEFAULT_LOCALE;
    const direct = exact.get(tag);
    if (direct) return direct;
    const base = BASE_LANGUAGE[tag.split('-')[0]];
    if (base) return base;
  }

  return DEFAULT_LOCALE;
}
