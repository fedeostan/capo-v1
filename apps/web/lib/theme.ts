import { cookies } from 'next/headers';

// Appearance resolution for the web app.
//
// Unlike the two language dials, this is a DEVICE preference, not an account
// one: it lives in a cookie and nowhere else. No profiles column, no
// AuthContext field, no migration. A manager who wants dark on the van tablet
// and light on the office laptop gets exactly that, and the whole feature
// stays off the request's DB path.
//
// The default is LIGHT, deliberately, and NOT prefers-color-scheme: the
// product is designed light-first and "System" is an opt-IN third choice
// rather than the fallback. globals.css encodes the same three states in CSS —
// change one and you must change the other.
//
// NOTE: this module imports next/headers, exactly like lib/i18n.ts, so it can
// never be pulled into a client bundle. If a client component ever needs
// THEME_COOKIE, split the constants into lib/theme-shared.ts the way
// lib/i18n-shared.ts was split off — do not import this file from the client.

export const THEME_COOKIE = 'capo_theme';
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = 'light';

/** Cookie options for the appearance preference. Mirrors localeCookieOptions:
 *  not httpOnly, so a future instant client-side toggle can write it without a
 *  server round trip. Nothing security-relevant is derived from it. */
export const themeCookieOptions = {
  maxAge: THEME_COOKIE_MAX_AGE,
  path: '/',
  sameSite: 'lax',
} as const;

/** Narrow an untrusted string to a Theme, or null. Same posture as asLocale:
 *  a forged form value must degrade to the default, not render a bogus class. */
export function asTheme(value: string | null | undefined): Theme | null {
  return (THEMES as readonly string[]).includes(value ?? '') ? (value as Theme) : null;
}

/**
 * The theme for this request. Absent or garbage cookie → light.
 *
 * NOTE: calling cookies() opts the caller into dynamic rendering — free in the
 * root layout, which is already dynamic via publicLocale().
 */
export async function resolveTheme(): Promise<Theme> {
  return asTheme((await cookies()).get(THEME_COOKIE)?.value) ?? DEFAULT_THEME;
}
