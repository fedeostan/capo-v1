import { cookies } from 'next/headers';

// The address a signup is waiting on, carried from the action that learned it
// to the screen that has to talk about it.
//
// WHY A COOKIE AND NOT A QUERY PARAMETER: an email address is personal data,
// and a query parameter ends up in browser history, in the Referer header of
// every asset the page loads, and in any log that records request URLs. The
// cookie is httpOnly (nothing on the client reads it) and secure in
// production — both stricter than localeCookieOptions/themeCookieOptions,
// which carry a language and a colour scheme and are read from the client on
// purpose. Do not relax either flag to make a client component "convenient".
//
// It is a HINT, exactly like the locale cookie: it decides what a signed-out
// screen SAYS and which address a resend is offered for. It never grants
// anything — /auth/confirm still verifies a real token, and resend() is a
// no-op for an address with no pending signup.

export const PENDING_EMAIL_COOKIE = 'capo_pending_email';

/** Thirty minutes: long enough to open a phone's mail app and come back,
 *  short enough that a shared tablet does not still name somebody hours
 *  later. Expiry is not a failure — the screen simply stops naming the
 *  address and asks for it instead. */
export const PENDING_EMAIL_MAX_AGE = 60 * 30;

const pendingEmailCookieOptions = {
  maxAge: PENDING_EMAIL_MAX_AGE,
  path: '/',
  sameSite: 'lax',
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
} as const;

/** Narrow an untrusted string to something that can be shown as an email
 *  address, or null. Same posture as asTheme/asLocale: a forged or truncated
 *  cookie must degrade to "we don't know the address", never render junk back
 *  at the user. Deliberately loose — this decides what a sentence says, not
 *  what gets sent anywhere. */
export function asPendingEmail(value: string | null | undefined): string | null {
  const email = (value ?? '').trim();
  if (email.length === 0 || email.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export async function setPendingEmail(email: string): Promise<void> {
  (await cookies()).set(PENDING_EMAIL_COOKIE, email, pendingEmailCookieOptions);
}

export async function readPendingEmail(): Promise<string | null> {
  return asPendingEmail((await cookies()).get(PENDING_EMAIL_COOKIE)?.value);
}

/** Called once the address can no longer be waiting on a confirmation. */
export async function clearPendingEmail(): Promise<void> {
  (await cookies()).delete(PENDING_EMAIL_COOKIE);
}
