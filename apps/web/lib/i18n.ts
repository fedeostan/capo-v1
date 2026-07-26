import { cookies, headers } from 'next/headers';
import { requireAuth, type AuthContext } from '@capo/db/session';
import { getCatalog, type Catalog } from '@capo/i18n/catalog';
import { asLocale, type Locale } from '@capo/i18n/locale';
import { negotiateLocale } from '@capo/i18n/negotiate';

// Locale resolution for the web app.
//
// TWO sources, and the precedence matters:
//   - authenticated pages read profiles.language (via AuthContext). This is
//     always authoritative.
//   - public pages (login, registar, landing, …) have no session and no profile
//     to read, so they fall back to a cookie, then Accept-Language.
//
// The cookie is a HINT, never a source of truth: it exists so a signed-out
// visitor and the <html lang> attribute get the right language without a DB
// read. Nothing that renders tenant data ever trusts it.

export { LOCALE_COOKIE } from './i18n-shared';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from './i18n-shared';

/** Cookie options for the locale hint. Not httpOnly on purpose: LocaleCookieSync
 *  writes it from the client after a chat-driven language change, which a
 *  streaming response cannot do server-side. */
export const localeCookieOptions = {
  maxAge: LOCALE_COOKIE_MAX_AGE,
  path: '/',
  sameSite: 'lax',
} as const;

/**
 * Locale for pages with no session. Cookie → Accept-Language → default.
 *
 * NOTE: calling cookies()/headers() opts the caller into dynamic rendering.
 */
export async function publicLocale(): Promise<Locale> {
  const fromCookie = asLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  if (fromCookie) return fromCookie;
  return negotiateLocale((await headers()).get('accept-language'));
}

/** Catalog for pages with no session. */
export async function publicCatalog(): Promise<{ locale: Locale; t: Catalog }> {
  const locale = await publicLocale();
  return { locale, t: getCatalog(locale) };
}

/**
 * requireAuth() plus this user's catalog — the standard opening line of every
 * page under (app). Redirects exactly like requireAuth, so never wrap in
 * try/catch (redirect() works by throwing).
 */
export async function requireAuthT(): Promise<{ ctx: AuthContext; locale: Locale; t: Catalog }> {
  const ctx = await requireAuth();
  return { ctx, locale: ctx.locale, t: getCatalog(ctx.locale) };
}

/**
 * Page <title> for authenticated screens.
 *
 * Deliberately resolved from the COOKIE, not the DB: generateMetadata runs as a
 * separate render pass, and doing a full requireAuth() there would double the
 * session queries on every page load just to translate a tab title. The cost is
 * that immediately after a chat-driven language change the tab title can lag by
 * one navigation, until LocaleCookieSync catches up.
 */
export async function metadataTitle(pick: (t: Catalog) => string): Promise<string> {
  const t = getCatalog(await publicLocale());
  return `${pick(t)} — ${t.meta.titleSuffix}`;
}
