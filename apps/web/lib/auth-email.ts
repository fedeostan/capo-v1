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

/**
 * At most this many account emails IN TOTAL per window, across every address.
 *
 * The per-address counter above bounds what one victim receives; it does not
 * bound what our sending domain does. GoTrue's limits were project-wide as well
 * as per-address, and only the per-address half came across, so /registar was
 * left able to mail an unlimited number of DISTINCT strangers. It also does not
 * bound one victim reliably: `victim+1@`, `victim+2@` are distinct addresses to
 * us and distinct users to GoTrue, but the same inbox to Gmail.
 *
 * 60/hour is set well above any believable real day (this is a product with
 * tens of managers, and a normal signup costs one message) and well below the
 * volume that gets a domain listed. It is a blast radius, not a capacity plan:
 * if it is ever hit legitimately, that is the signal, and the number should
 * move deliberately rather than quietly.
 */
export const AUTH_EMAIL_MAX_GLOBAL_PER_WINDOW = 60;

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
 * What the caller is allowed to know: nothing that distinguishes one address
 * from another.
 *
 * EVERY value leads to the same screen. The three flows are carefully written
 * not to be account-enumeration oracles, and a caller that could tell "sent"
 * from "skipped" would turn each of them back into one: "skipped" is exactly
 * the answer for an address that already has a confirmed account, and for one
 * that has no account at all.
 *
 * There used to be a fourth value, `signups-disabled`, which /registar turned
 * into `?erro=fechado`. It was removed rather than kept: on the Resend path
 * accounts are created through the admin API, which IGNORES the dashboard's
 * "Allow new users to sign up" toggle, so the value could only ever come from
 * the legacy fallback below. Copy describing a switch that no longer binds is
 * worse than no copy, because the next person to read the action concludes the
 * control works. If Capo ever needs to close signups again it needs its own
 * flag, checked before this function is called.
 */
export type AuthEmailResult = 'sent' | 'throttled' | 'skipped';

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
 * What the throttle knows right now.
 *
 * Three states, not two, and the third is the point. A read that FAILS is not
 * the same as a read that says zero, and neither is the same as a table that
 * does not exist yet.
 */
type ThrottleState =
  | { status: 'ok'; perAddress: number; global: number }
  | { status: 'unavailable' }
  | { status: 'error'; reason: string };

// PostgREST answers a missing table with PGRST205 (not in the schema cache);
// Postgres itself answers 42P01. Both mean "0045 has not been applied here".
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);

/**
 * Count this window's sends, per address and in total.
 *
 * ── THE ONE CASE THAT MAY STILL SEND ───────────────────────────────────────
 * A MISSING TABLE, and only that. This code ships before migration 0045 is
 * applied, so between the deploy and the migration the table legitimately does
 * not exist, and refusing then would mean not one manager could confirm an
 * email or reset a password. That window is known, bounded and watched.
 *
 * ── EVERYTHING ELSE FAILS CLOSED ───────────────────────────────────────────
 * A revoked grant, a network failure, a broken service-role key: the table
 * exists and we cannot read it, so we do not know what has already gone out.
 * Sending anyway would mean the throttle silently stops existing at exactly the
 * moment something is wrong, which is when it matters. The caller answers
 * 'throttled' and the screen is unchanged, so a person retrying a minute later
 * gets through once the read recovers.
 *
 * ⚠ A NULL COUNT IS A FAILURE, NOT A ZERO, and PostgREST will not tell you so.
 * A `head: true` count against a table that does not exist answers `204` with
 * `count: null` and NO error, which is bit-for-bit what "the table is there and
 * nothing matched" would look like if null were read as zero. Verified against
 * the live project: a real table answers `200` with `count: 0` (a number) when
 * nothing matches, and `count: null` only when the count did not happen. So the
 * null IS the missing-table signal, and collapsing it with `?? 0` is how the
 * throttle would go on reporting healthy after being switched off.
 *
 * Grep `auth_email.throttle_unavailable` (sending, table absent) and
 * `auth_email.throttle_failed` (refusing, read broken).
 */
async function readThrottle(emailLower: string): Promise<ThrottleState> {
  const since = new Date(Date.now() - AUTH_EMAIL_WINDOW_MS).toISOString();
  try {
    const db = getDb();
    const [mine, all] = await Promise.all([
      db
        .from('auth_email_sends')
        .select('id', { count: 'exact', head: true })
        .eq('email_lower', emailLower)
        .gte('sent_at', since),
      db
        .from('auth_email_sends')
        .select('id', { count: 'exact', head: true })
        .gte('sent_at', since),
    ]);

    for (const r of [mine, all]) {
      if (r.error) {
        if (MISSING_TABLE_CODES.has(r.error.code ?? '')) return { status: 'unavailable' };
        return { status: 'error', reason: r.error.code || r.error.message || 'unreadable' };
      }
    }
    // The head-count trap: no error, no number. Table is not there.
    if (mine.count === null || all.count === null) return { status: 'unavailable' };

    return { status: 'ok', perAddress: mine.count, global: all.count };
  } catch (err) {
    // getDb() throws when the service-role key is missing. That is a broken
    // deployment, not an absent migration, so it refuses.
    return { status: 'error', reason: err instanceof Error ? err.message : 'unknown' };
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
    if (error) logEvent('auth_email.record_failed', { kind, reason: error.code || error.message || 'unknown' });
  } catch (err) {
    logEvent('auth_email.record_failed', {
      kind,
      reason: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/**
 * Is there already a CONFIRMED account on this address?
 *
 * Asked on the `resend` path only, and it closes a capability that this feature
 * accidentally created. The resend button mints a MAGIC LINK, and a magic link
 * signs its holder in; GoTrue will happily mint one for a confirmed account.
 * The old `auth.resend({type:'signup'})` errored in that case and sent nothing,
 * so this was new. The reachable sequence was: submit /registar with somebody
 * else's address (the pending-email cookie is set on every path, deliberately),
 * land on /confirmar-email, tap "Reenviar", and a working one-click login link
 * arrives in a stranger's inbox, unrequested. It only ever reaches the account
 * owner, so it is not takeover, but Capo has no magic-link login product and
 * that is exactly the shape of a phishing lure.
 *
 * A resend is by definition for an account that exists and has NOT been
 * confirmed, so refusing every other state costs a real user nothing.
 *
 * ── 'missing' REFUSES TOO, AND THAT IS NOT BELT-AND-BRACES ─────────────────
 * `generateLink('magiclink')` on an address with NO account does not fail: it
 * CREATES the user and mints a sign-in link, which is magic-link signup
 * behaviour. (Confirmed live: an early version of this guard let exactly that
 * through.) Without this branch the resend button would mail a working sign-in
 * link to an address that never signed up, and leave a junk `auth.users` row
 * behind each time. `recovery` does not share the hazard: GoTrue answers it
 * `user_not_found`. Only 'unconfirmed' may proceed.
 *
 * ── WHY A RAW ADMIN CALL ───────────────────────────────────────────────────
 * supabase-js has no lookup by email: `admin.listUsers()` takes page params
 * only, and paging the whole project to find one address is O(users) on a path
 * an anonymous visitor can trigger. GoTrue's admin endpoint does support a
 * `filter`, so this asks it directly, the same endpoint the SDK itself calls.
 *
 * ⚠ `filter` is a SUBSTRING search, not an equality test: `a@b.com` matches
 * `xa@b.com` too. The exact comparison below is what makes the answer mean what
 * it says, and removing it would let a lookalike address decide somebody else's
 * outcome.
 *
 * FAILS CLOSED. If we cannot find out, we do not send: the harm being prevented
 * is mailing a sign-in link to a confirmed account, and the cost of a false
 * refusal is one unconfirmed person retrying a resend.
 */
type ResendEligibility = 'unconfirmed' | 'confirmed' | 'missing' | 'unknown';

async function resendEligibility(emailLower: string): Promise<ResendEligibility> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return 'unknown';

  try {
    const response = await fetch(
      `${url}/auth/v1/admin/users?filter=${encodeURIComponent(emailLower)}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!response.ok) return 'unknown';

    const body = (await response.json().catch(() => null)) as {
      users?: { email?: string | null; email_confirmed_at?: string | null }[];
    } | null;
    if (!body?.users) return 'unknown';

    const match = body.users.find((u) => (u.email ?? '').toLowerCase() === emailLower);
    if (!match) return 'missing';
    return match.email_confirmed_at ? 'confirmed' : 'unconfirmed';
  } catch {
    return 'unknown';
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
      reason: generated.error.code || generated.error.message || 'unknown',
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

  const throttle = await readThrottle(emailLower);
  if (throttle.status === 'error') {
    // The table is there and unreadable. Refuse rather than send blind.
    logEvent('auth_email.throttle_failed', { kind: input.kind, reason: throttle.reason });
    return 'throttled';
  }
  if (throttle.status === 'unavailable') {
    // 0045 not applied here. The one case that may still send.
    logEvent('auth_email.throttle_unavailable', { kind: input.kind, reason: 'no_table' });
  } else {
    if (throttle.perAddress >= AUTH_EMAIL_MAX_PER_WINDOW) {
      logEvent('auth_email.throttled', { kind: input.kind, scope: 'address' });
      return 'throttled';
    }
    if (throttle.global >= AUTH_EMAIL_MAX_GLOBAL_PER_WINDOW) {
      logEvent('auth_email.throttled', { kind: input.kind, scope: 'global' });
      return 'throttled';
    }
  }

  // A resend is for an existing, UNCONFIRMED account and nothing else. Every
  // other state (confirmed, no account, or a lookup we could not complete)
  // sends nothing. See resendEligibility for why 'missing' is not optional.
  if (input.kind === 'resend') {
    const state = await resendEligibility(emailLower);
    if (state !== 'unconfirmed') {
      logEvent('auth_email.already_confirmed', { kind: input.kind, state });
      return 'skipped';
    }
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
    // Signups turned off at the dashboard. Only this path can still see it (the
    // admin API ignores the toggle), so it is recorded as its own log line and
    // then answered like every other non-send: the screen must not change.
    if (/sign\s*ups?/i.test(error.message) && /not allowed|disabled/i.test(error.message)) {
      logEvent('auth_email.signups_disabled', { kind: input.kind });
      return 'skipped';
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
