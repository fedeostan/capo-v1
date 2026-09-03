import { getDb } from '@capo/db/client';
import { createUserClient } from '@capo/db/user-client';
import type { Locale } from '@capo/i18n/locale';
import { renderConfirmEmail } from './emails/confirm';
import { renderResetEmail } from './emails/reset';
import { logEvent } from './log';
import { siteUrl } from './site-url';

// Capo sends its own account emails (W1).
//
// ── WHAT CHANGED AND WHY ───────────────────────────────────────────────────
// Signup confirmation, resend and password reset used to be Supabase's job:
// the app called auth.signUp / auth.resend / resetPasswordForEmail and GoTrue
// mailed a Go template pasted into its dashboard. Two problems, one of them a
// live bug:
//
//   1. The mail was slow, tightly rate-limited and looked like nothing else in
//      the product.
//   2. The dashboard's DEFAULT template routes the click through Supabase's own
//      /auth/v1/verify, which consumes the token, confirms the account, and
//      then forwards to /auth/confirm WITHOUT a token_hash. Our route saw a
//      link with nothing to verify and answered "O link expirou ou ja foi
//      usado" to somebody whose account had just been confirmed successfully.
//      The templates that fix it were written in issue #113 and never pasted.
//
// Building the link OURSELVES makes problem 2 structurally impossible: the
// address in the email is the one /auth/confirm verifies, and no third party
// gets to rewrite it in between.
//
// ── THE SEAM ───────────────────────────────────────────────────────────────
// GoTrue still MINTS the token: auth.admin.generateLink() creates or finds the
// user and hands back `properties.hashed_token` without sending anything. We
// build the link from that and hand the message to Resend. So Supabase remains
// the only authority on identity; all that moved is the envelope.
//
// Use `properties.hashed_token`, never `properties.action_link` — action_link
// is the /auth/v1/verify URL, which is precisely the shape that caused the bug.
//
// SERVER ONLY. It reads the service-role key and the Resend key, so it must
// never be imported from a client component. There is no `server-only` package
// in this workspace (nothing else uses one); the guard is that every caller is
// a 'use server' action, exactly as it is for the other getDb() callers.

const FROM = 'Capo <ola@construcapo.com>';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * At most this many account emails to one address per window, counted across
 * ALL THREE kinds together. Alternating doors must not buy a fourth message:
 * /registar and /recuperar are unauthenticated forms that cause mail to be
 * delivered to an arbitrary address, so without this they are a mail-bombing
 * primitive aimed at a stranger and a reputation problem aimed at our own
 * sending domain. GoTrue used to impose its own limit and took it with it.
 */
export const AUTH_EMAIL_MAX_PER_WINDOW = 3;
export const AUTH_EMAIL_WINDOW_MS = 60 * 60 * 1000;

export type AuthEmailKind = 'confirm' | 'resend' | 'recovery';

/**
 * `confirm` is the only kind that carries a password, and a union rather than
 * an optional field is what stops a future caller forgetting it: GoTrue's
 * signup generateLink REQUIRES one, so "confirm without a password" must not
 * be expressible. Same instinct as ToolContext.confirmPosture being required.
 */
export type SendAuthEmailInput =
  | { kind: 'confirm'; email: string; password: string; locale: Locale }
  | { kind: 'resend'; email: string; locale: Locale }
  | { kind: 'recovery'; email: string; locale: Locale };

/**
 * What the caller is allowed to know.
 *
 * Everything except `signups-disabled` MUST lead to the same screen. The three
 * flows are carefully written not to be account-enumeration oracles, and a
 * caller that could tell "sent" from "skipped" would turn each of them back
 * into one: "skipped" is exactly the answer for an address that already has a
 * confirmed account, or has no account at all.
 */
export type AuthEmailResult = 'sent' | 'throttled' | 'skipped' | 'signups-disabled';

/** Where each kind's link lands once the token verifies. */
const NEXT: Record<AuthEmailKind, string> = {
  confirm: '/onboarding',
  resend: '/onboarding',
  recovery: '/nova-password',
};

/**
 * The OTP type in the link, which is what /auth/confirm passes to verifyOtp.
 *
 * `resend` is a magic link and not a second signup token, because at that point
 * there is no password to hand generateLink: the person signed up minutes ago
 * and we never kept it. Verified empirically against the live project before
 * this was written: generateLink('magiclink') succeeds for an UNCONFIRMED user,
 * and verifying that token sets email_confirmed_at, which is the whole job.
 */
const OTP_TYPE: Record<AuthEmailKind, 'signup' | 'magiclink' | 'recovery'> = {
  confirm: 'signup',
  resend: 'magiclink',
  recovery: 'recovery',
};

/** The Resend key, under either name. Read lazily: never at module scope. */
function resendKey(): string | undefined {
  // RESEND_API_KEY is the name the app reads. RESEND_SMTP_KEY is the same key
  // under the older name it has locally, from when it was pasted into
  // Supabase's SMTP settings instead.
  return process.env.RESEND_API_KEY || process.env.RESEND_SMTP_KEY || undefined;
}

/**
 * How many account emails this address has had inside the window.
 *
 * FAILS OPEN, and that is deliberate. This ships before migration 0045 is
 * applied, so the table legitimately does not exist yet (42P01) — and a read
 * that failed CLOSED would mean not one manager could confirm an email or reset
 * a password between the deploy and the migration. The failure it guards is
 * abuse; the failure it would cause is total. Same posture as
 * readCompanySchedules, which degrades to the defaults rather than throwing.
 *
 * Grep `auth_email.throttle_unavailable` before concluding the throttle works.
 *
 * ⚠ A NULL COUNT IS A FAILURE, NOT A ZERO, and PostgREST will not tell you so.
 * A `head: true` count against a table that does not exist answers `204` with
 * `count: null` and NO error, which is bit-for-bit what "the table is there and
 * nothing matched" would look like if null were read as zero. Verified against
 * the live project: a real table answers `200` with `count: 0` (a number) when
 * nothing matches, and `count: null` only when the count did not happen. So the
 * null is the whole signal, and collapsing it with `?? 0` is how the throttle
 * would go on reporting healthy after being silently switched off.
 */
async function recentSendCount(emailLower: string): Promise<number> {
  const since = new Date(Date.now() - AUTH_EMAIL_WINDOW_MS).toISOString();
  try {
    const { count, error } = await getDb()
      .from('auth_email_sends')
      .select('id', { count: 'exact', head: true })
      .eq('email_lower', emailLower)
      .gte('sent_at', since);
    if (error) {
      logEvent('auth_email.throttle_unavailable', { reason: error.code ?? error.message });
      return 0;
    }
    if (count === null) {
      logEvent('auth_email.throttle_unavailable', { reason: 'no_count' });
      return 0;
    }
    return count;
  } catch (err) {
    logEvent('auth_email.throttle_unavailable', {
      reason: err instanceof Error ? err.message : 'unknown',
    });
    return 0;
  }
}

/**
 * Record a send. AFTER Resend accepted it, never before: a row written first
 * would let a Resend outage spend somebody's allowance on messages that never
 * arrived, and the person who cannot get into their account is precisely the
 * person who will try again.
 *
 * Swallows its own failure. A lost bookkeeping row must never cost somebody
 * the email they are waiting for.
 */
async function recordSend(emailLower: string, kind: AuthEmailKind): Promise<void> {
  try {
    const { error } = await getDb()
      .from('auth_email_sends')
      .insert({ email_lower: emailLower, kind });
    if (error) logEvent('auth_email.record_failed', { kind, reason: error.code ?? error.message });
  } catch (err) {
    logEvent('auth_email.record_failed', {
      kind,
      reason: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/**
 * Ask GoTrue for a token and build the link the email will carry.
 *
 * Returns null whenever nothing should be sent, and deliberately does not say
 * why to the caller: the two commonest reasons are "this address already has a
 * confirmed account" (email_exists) and "there is no such account"
 * (user_not_found), which are the two facts the whole flow exists not to leak.
 * The reason is logged server-side, where leaking it costs nothing.
 */
async function buildLink(input: SendAuthEmailInput, emailLower: string): Promise<string | null> {
  const redirectTo = `${siteUrl()}/auth/confirm?next=${NEXT[input.kind]}`;
  const admin = getDb();

  const generated =
    input.kind === 'confirm'
      ? await admin.auth.admin.generateLink({
          type: 'signup',
          email: emailLower,
          password: input.password,
          options: { redirectTo },
        })
      : await admin.auth.admin.generateLink({
          type: input.kind === 'resend' ? 'magiclink' : 'recovery',
          email: emailLower,
          options: { redirectTo },
        });

  if (generated.error) {
    logEvent('auth_email.link_failed', {
      kind: input.kind,
      reason: generated.error.code ?? generated.error.message,
    });
    return null;
  }

  const hashedToken = generated.data.properties?.hashed_token;
  if (!hashedToken) {
    logEvent('auth_email.link_failed', { kind: input.kind, reason: 'no_hashed_token' });
    return null;
  }

  // The shape /auth/confirm verifies, and the whole point of the exercise.
  return (
    `${siteUrl()}/auth/confirm` +
    `?token_hash=${encodeURIComponent(hashedToken)}` +
    `&type=${OTP_TYPE[input.kind]}` +
    `&next=${encodeURIComponent(NEXT[input.kind])}`
  );
}

/** Hand the finished message to Resend. Returns the message id, or null. */
async function deliver(
  key: string,
  to: string,
  kind: AuthEmailKind,
  message: { subject: string; html: string; text: string },
): Promise<string | null> {
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        // Never logged, never returned, never put in an error message.
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });

    if (!response.ok) {
      // Resend's error body names the problem (unverified domain, bad key,
      // invalid recipient) and contains no secret of ours.
      const detail = await response.text().catch(() => '');
      logEvent('auth_email.send_failed', {
        kind,
        status: response.status,
        detail: detail.slice(0, 300),
      });
      return null;
    }

    const body = (await response.json().catch(() => null)) as { id?: string } | null;
    return body?.id ?? null;
  } catch (err) {
    logEvent('auth_email.send_failed', {
      kind,
      reason: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
}

/**
 * Send one account email.
 *
 * Never throws. Every failure is logged and answered with a result the caller
 * turns into the same screen it would have shown anyway, because on all three
 * of these flows the screen must not depend on what we found out about the
 * address.
 */
export async function sendAuthEmail(input: SendAuthEmailInput): Promise<AuthEmailResult> {
  const emailLower = input.email.trim().toLowerCase();

  const key = resendKey();
  if (!key) return sendThroughLegacyMailer(input, emailLower);

  if ((await recentSendCount(emailLower)) >= AUTH_EMAIL_MAX_PER_WINDOW) {
    logEvent('auth_email.throttled', { kind: input.kind });
    return 'throttled';
  }

  const link = await buildLink(input, emailLower);
  if (!link) return 'skipped';

  const message =
    input.kind === 'recovery'
      ? renderResetEmail({ locale: input.locale, link })
      : renderConfirmEmail({ locale: input.locale, link });

  const messageId = await deliver(key, emailLower, input.kind, message);
  if (!messageId) return 'skipped';

  await recordSend(emailLower, input.kind);
  logEvent('auth_email.sent', { kind: input.kind, locale: input.locale, messageId });
  return 'sent';
}

// ───────────────────────────────────────────────────────────────────────────
// LEGACY MAILER FALLBACK — DELETE THIS FUNCTION once RESEND_API_KEY is set on
// the Vercel project.
//
// RESEND_API_KEY could not be added to Vercel when this shipped (the product
// owner adds it by hand after merge), and a deploy that reached production
// first with no key would have meant NO account emails at all: no signups, no
// password resets. So with neither key name set this falls back to exactly the
// calls the app made before W1, with the same emailRedirectTo, and Supabase's
// built-in mailer sends the old template again.
//
// That template produces the /auth/v1/verify link whose click used to end at
// "O link expirou ou ja foi usado". It no longer does: /auth/confirm now also
// accepts the `?code=` that Supabase forwards, so the fallback path's link
// still lands the person on `next`. The two halves of this change belong
// together for that reason.
//
// This is the ONLY place in apps/ allowed to call auth.signUp, auth.resend or
// resetPasswordForEmail. Everything else goes through sendAuthEmail.
// ───────────────────────────────────────────────────────────────────────────
async function sendThroughLegacyMailer(
  input: SendAuthEmailInput,
  emailLower: string,
): Promise<AuthEmailResult> {
  logEvent('auth_email.legacy_mailer', { kind: input.kind });

  // The RLS-scoped client, exactly as before: these three calls are the ones
  // the anonymous visitor was always allowed to make on their own behalf.
  const supabase = await createUserClient();
  const emailRedirectTo = `${siteUrl()}/auth/confirm?next=${NEXT[input.kind]}`;

  if (input.kind === 'confirm') {
    const { error } = await supabase.auth.signUp({
      email: emailLower,
      password: input.password,
      options: { emailRedirectTo },
    });
    if (!error) return 'sent';
    // Signups turned off at the dashboard: the one case worth its own message,
    // because it is a config state rather than a fact about this address.
    if (/sign\s*ups?/i.test(error.message) && /not allowed|disabled/i.test(error.message)) {
      return 'signups-disabled';
    }
    console.error('signUp failed:', error.message);
    return 'skipped';
  }

  if (input.kind === 'resend') {
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: emailLower,
      options: { emailRedirectTo },
    });
    if (error) console.error('resend signup confirmation failed:', error.message);
    return error ? 'skipped' : 'sent';
  }

  const { error } = await supabase.auth.resetPasswordForEmail(emailLower, {
    redirectTo: emailRedirectTo,
  });
  if (error) console.error('resetPasswordForEmail failed:', error.message);
  return error ? 'skipped' : 'sent';
}
