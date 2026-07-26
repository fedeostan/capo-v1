// Constants shared by server and client code.
//
// Split out of lib/i18n.ts because that module imports next/headers and
// @capo/db/session, neither of which can be pulled into a client bundle — and a
// client component importing LOCALE_COOKIE from there would drag both in.

export const LOCALE_COOKIE = 'capo_lang';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
