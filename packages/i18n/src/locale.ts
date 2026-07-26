// The locale primitives, and nothing else. This module is imported by
// @capo/db (to type AuthContext), by @capo/core (to pick a persona), and by
// both server and client components — so it must stay free of React, of Next,
// and of the copy dictionaries. Importing ./catalog from here would drag every
// UI string into the agent bundle.
//
// Adding a locale is: one entry here, one persona in @capo/core, one prompt-
// blocks module, one card dictionary, one UI dictionary, and a widened check
// constraint in the DB. Every one of those is a Record<Locale, …>, so the
// compiler enumerates the work for you.

export const LOCALES = ['pt-PT', 'es-ES', 'en-US'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'pt-PT';

/** Narrow an untrusted string to a Locale, or null. Use when the caller wants
 *  to distinguish "absent/invalid" from "explicitly the default". */
export function asLocale(value: string | null | undefined): Locale | null {
  return (LOCALES as readonly string[]).includes(value ?? '') ? (value as Locale) : null;
}

/** Narrow an untrusted string to a Locale, falling back to the default. Use on
 *  DB reads: a row written before a locale was retired must never crash a render. */
export function coerceLocale(value: string | null | undefined): Locale {
  return asLocale(value) ?? DEFAULT_LOCALE;
}

// The two dials, deliberately separate:
//
//   user    — profiles.language. Who is being spoken to. Drives Capo's replies,
//             the deterministic approval cards, the transcription instruction,
//             the rolling summary, and the web UI.
//   company — companies.language. What gets STORED. Drives task titles, job
//             names and descriptions, memories and generated plans, so the
//             shared dashboard reads as exactly one language no matter which
//             manager dictated the row.
//
// They are usually equal. They differ when a company hires a manager who does
// not speak the company language — which is the whole reason the split exists.
export interface LocaleContext {
  user: Locale;
  company: Locale;
}
