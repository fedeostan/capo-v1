import { readMetaErrorCode } from '@capo/core/channels/whatsapp';

// The pure half of "may this person's failed welcome be tried again?"
// (issue #121).
//
// Until 0041, the answer was structurally NO: notification_log_welcome_once
// carried no status predicate, so a welcome that failed — on the pilot tenant,
// because capo_welcome was not approved in pt_PT (Meta 132001) — held its
// once-ever claim exactly as a delivered one does. The ledger recorded a
// failure as a success, and three real crew members could never be welcomed.
//
// 0041 narrows the index to `where kind = 'welcome' and status <> 'failed'`,
// so a failed row releases the lock. This file is the policy that keeps the
// resulting retry from running away: a paid template send re-attempted every
// fifteen minutes forever against a number that will never work is the failure
// the old index prevented by accident, and it must stay prevented on purpose.
//
// Everything here is PURE: no Db, no clock, no network — `today` arrives as a
// string from lisbon_today(), the same clock everything else reads. That is
// what lets `pnpm whatsapp-check` assert every branch with no credentials,
// the same arrangement checkin-claim.ts and push-rules.ts have.
//
// The shape mirrors packages/core/src/channels/push-rules.ts deliberately:
// classify one answer, cap the attempts, believe a permanent verdict the first
// time. The difference in posture is the default — a push retries anything it
// cannot classify because a retry there is free, while an UNKNOWN welcome
// failure is PERMANENT because a retry here is a paid template. Fail closed.

/**
 * Three attempts, total, ever — the failed rows in notification_log ARE the
 * counter (each one is a distinct Lisbon day, because the 0016 daily unique
 * key refuses a second claim per person per day). PUSH_MAX_ATTEMPTS' number,
 * for push-rules' reason: enough for a config error to be noticed and fixed,
 * few enough that a wall is not billed indefinitely.
 */
export const WELCOME_MAX_ATTEMPTS = 3;

/** What one failed send's error means for ever trying again. */
export type WelcomeErrorClass =
  /** A config or transient failure that a later day can genuinely fix. */
  | 'retryable'
  /** Everything else. Believe it the first time — a retry is a paid send. */
  | 'permanent';

/**
 * The Meta error codes worth a second paid attempt. An ALLOWLIST, grown
 * deliberately — the safe failure of a missing entry is one person welcomed
 * late by hand, the failure of a wrong entry is a repeating bill.
 *
 *   132001 — "template name (capo_welcome) does not exist in <locale>". The
 *            code the pilot's three failures carry: a CONFIG error, wrong
 *            today and fixable tomorrow by approving the template. The whole
 *            reason #121's retry exists.
 *   130429 — rate limit hit. Transient by definition; the next day's single
 *            attempt is the correct response.
 *
 * Deliberately absent: 131026 (message undeliverable — the invalid-recipient
 * class; a number not on WhatsApp will not be on it tomorrow either) and
 * 131047 (outside the 24h window — the welcome's template path cannot get it,
 * so its presence on a failed row means something unmodelled happened).
 */
const RETRYABLE_META_CODES = new Set([132001, 130429]);

/**
 * Classify one `notification_log.error` string.
 *
 * The stored error is describeSendError()'s output — for a Meta refusal, a
 * WhatsAppSendError message of the shape
 * "WhatsApp send failed (404, code 132001): …" — and readMetaErrorCode is the
 * one shared reader of that shape (it is what /perfil/automacoes uses too).
 * A message it cannot read — a network failure, a code-less 5xx, an absent
 * error — is PERMANENT: an unknown failure must not earn a paid retry loop.
 */
export function classifyWelcomeError(error: string | null | undefined): WelcomeErrorClass {
  const code = readMetaErrorCode(error);
  if (code === null) return 'permanent';
  return RETRYABLE_META_CODES.has(code) ? 'retryable' : 'permanent';
}

/**
 * One person's `kind = 'welcome'` ledger rows, as loadPendingWelcomes reads
 * them. All three columns have existed since 0016, so naming them in a select
 * is safe — but a row is still read defensively: an ABSENT status must block
 * (the pre-#121 reading), never release.
 */
export interface WelcomeLedgerEntry {
  status?: string | null;
  error?: string | null;
  notification_date?: string | null;
}

export type WelcomeRetryVerdict =
  /** No ledger rows: never attempted. Pending, exactly as before #121. */
  | 'never_attempted'
  /** A non-failed row exists — sent, skipped, pending, or unreadable. Once
   *  ever means ever: this person is done, whatever else their history holds. */
  | 'blocked'
  /** Only failed rows, newest one retryable and not from today, under the
   *  cap. The sweep may claim this person again. */
  | 'retry'
  /** WELCOME_MAX_ATTEMPTS failed rows. Nobody bills a wall a fourth time. */
  | 'exhausted'
  /** The newest failure's error says a retry can never succeed. */
  | 'permanent'
  /** The newest failure is from today (or undatable). At most one paid
   *  attempt per Lisbon day — a still-broken config must cost one send a day,
   *  not one per fifteen-minute sweep. The 0016 daily unique key enforces the
   *  same bound in Postgres; this verdict is what keeps the sweep from
   *  attempting that doomed insert ninety-six times a day. */
  | 'cooldown';

/**
 * The retry decision for ONE person, from their welcome ledger rows and
 * today's Lisbon date (an ISO `yyyy-mm-dd`, straight from lisbon_today()).
 *
 * Order of the checks is the safety argument, most-conservative first:
 * any non-failed row blocks before anything is counted; the cap is consulted
 * before the newest row is even looked at; and the newest row must be BOTH
 * dated before today AND retryable before 'retry' can come back. A failed row
 * whose date is missing or unreadable reads as "from today" — the direction
 * that delays a paid send rather than repeating one. ISO dates compare
 * correctly as strings, which is what keeps this function free of any Date
 * parsing to get subtly wrong.
 */
export function decideWelcomeRetry(rows: readonly WelcomeLedgerEntry[], today: string): WelcomeRetryVerdict {
  if (rows.length === 0) return 'never_attempted';
  if (rows.some(r => r.status !== 'failed')) return 'blocked';
  if (rows.length >= WELCOME_MAX_ATTEMPTS) return 'exhausted';

  let newest: WelcomeLedgerEntry | undefined;
  for (const row of rows) {
    // A dateless row outranks every dated one, so it is the row the two
    // fail-closed checks below get to judge — and it fails both.
    if (!row.notification_date) {
      newest = row;
      break;
    }
    if (!newest?.notification_date || row.notification_date > newest.notification_date) newest = row;
  }

  if (!newest?.notification_date || newest.notification_date >= today) return 'cooldown';
  if (classifyWelcomeError(newest.error) === 'permanent') return 'permanent';
  return 'retry';
}
