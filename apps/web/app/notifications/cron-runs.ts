import type { Db } from '@capo/db/client';
import type { JobKind } from '../../lib/schedule';
import { logEvent } from '../../lib/log';

// ── one row per company per job per day (issue #51, part B2) ────────────────
//
// THE QUESTION THIS ANSWERS: "the crew heard nothing this morning — was it
// broken, or was there nothing to say?" Before this, those two were
// indistinguishable from inside the product. A healthy day with an idle crew
// and a day the platform never knocked both looked like an empty table.
//
// notification_log cannot answer it, and that is not an oversight in this file
// but a fact about that table. It holds one row per CLAIM, and the people who
// explain a silent morning are precisely the people who were never claimed: a
// crew member with no recorded WhatsApp opt-in, a crew row switched off, a
// company with no manager account at all. None of them reach claimNotification,
// so no query over the send ledger can count them.
//
// So this row carries two things the ledger structurally cannot:
//   * DUE vs ACTUAL — 07:00 against 07:49, the single column that would have
//     answered 13 August without a hosting-company log;
//   * the exclusion counts, which are the whole of "who did not hear from us,
//     and why".

export interface CronRunRecord {
  companyId: string;
  jobKind: JobKind;
  /** lisbon_today() on this run — the same date notification_log claims against. */
  runDate: string;
  /** The Lisbon hour the schedule aimed at. */
  dueHour: number;
  /** The Lisbon hour the platform actually knocked in. */
  ranHour: number;
  /**
   * When this invocation STARTED, as an ISO instant — captured next to the
   * `lisbon_hour()` read that produced `ranHour`, never at write time.
   *
   * The pairing is load-bearing rather than tidy. The screen derives Lisbon's
   * UTC offset from the difference between these two and uses it to reconstruct
   * the due instant; taking one from the start of the run and the other from
   * the end would put a whole estate's send loop between them, and on a run
   * that crossed the hour boundary the derived offset would be off by one and
   * the reported lateness off by sixty minutes.
   *
   * It is also the honest answer to "when did the platform knock?" — a run that
   * takes four minutes to message forty people knocked once, at the start.
   */
  ranAt: string;
  messaged: number;
  skippedIdle: number;
  failed: number;
  excludedNoConsent: number;
  excludedUnreachable: number;
  excludedInactive: number;
  managersNoConsent: number;
  /** Briefing only — the check-in has no manager audience. */
  noManagerAccount: boolean;
}

/**
 * Write (or replace) the summary of one company's run.
 *
 * ── WHO CALLS THIS, AND WHEN ───────────────────────────────────────────────
 * The invocation that WON the claims, and only that one. Since the send window
 * widened to two Lisbon hours (part A) two or three invocations pass the gate
 * every day; notification_log's unique constraint makes the SENDS idempotent,
 * and riding the same `claims > 0` signal is what keeps this row from being
 * overwritten with zeros by a later run that correctly did nothing.
 *
 * The one exception is a company with nobody claimable at all — no crew with
 * consent, no manager with consent. There is no claim to ride, and "nothing
 * went out today" is exactly the fact that used to be invisible, so the caller
 * writes a zero row with `replace: false` and a later run leaves it alone.
 *
 * ── IT NEVER THROWS ────────────────────────────────────────────────────────
 * Same posture as recordThreadEvent. This is a visibility record; a failure to
 * write one must never cost a crew their morning message, and a deploy landing
 * before 0036 answers 42P01 for every company in the estate. Swallowed into a
 * log line, which keeps "the history is empty" falsifiable.
 */
export async function recordCronRun(
  db: Db,
  run: CronRunRecord,
  options: { replace: boolean },
): Promise<void> {
  const row = {
    company_id: run.companyId,
    job_kind: run.jobKind,
    run_date: run.runDate,
    due_hour: run.dueHour,
    ran_hour: run.ranHour,
    // In the payload, so an upsert that REPLACES an earlier zero-target row
    // moves both halves of the pair together. Left out, Postgres would keep the
    // first row's ran_at beside the second run's ran_hour and the offset
    // derived from them would be wrong.
    ran_at: run.ranAt,
    messaged: run.messaged,
    skipped_idle: run.skippedIdle,
    failed: run.failed,
    excluded_no_consent: run.excludedNoConsent,
    excluded_unreachable: run.excludedUnreachable,
    excluded_inactive: run.excludedInactive,
    managers_no_consent: run.managersNoConsent,
    no_manager_account: run.noManagerAccount,
    finished_at: new Date().toISOString(),
  };

  const { error } = await db.from('cron_runs').upsert(row, {
    onConflict: 'company_id,job_kind,run_date',
    // `ignoreDuplicates: true` is the "nothing was claimable" path: it records
    // the silence once and never overwrites a real run that already reported
    // real numbers. The claiming run passes false and wins.
    ignoreDuplicates: !options.replace,
  });
  if (error) {
    logEvent('cron_run.record_failed', {
      companyId: run.companyId,
      jobKind: run.jobKind,
      runDate: run.runDate,
      error: error.message,
      code: error.code,
    });
  }
}
