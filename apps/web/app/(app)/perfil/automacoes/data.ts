import type { AuthContext } from '@capo/db/session';
import { readMetaErrorCode } from '@capo/core/channels/whatsapp';
import {
  DEFAULT_SEND_HOURS,
  JOB_KINDS,
  isSendHour,
  type CompanySchedule,
  type JobKind,
} from '@/lib/schedule';
import { partitionCrew } from '@/app/notifications/briefing';
import { logEvent } from '@/lib/log';

// Everything Perfil → Mensagens automáticas reads, in one place.
//
// ── THE THREE SOURCES, AND WHY THEY ARE THREE ──────────────────────────────
//
//   company_schedules  what each send is aimed at        ordinary RLS
//   cron_runs          one row per company per job per   ordinary RLS
//                      day: due vs actual, and every
//                      count that explains an absence
//   notification_log   one row per RECIPIENT per send    NO tenant policy at
//                                                        all — read through a
//                                                        SECURITY DEFINER
//                                                        function, never
//                                                        directly
//
// The third is the one to be careful with. `notification_log` is RLS-enabled
// with DELIBERATELY ZERO POLICIES and is written by the cron on the service
// role; a plain `select` from a tenant client returns nothing to anybody, and
// that posture is untouched. `company_send_history` (0036) is the single window
// into it, and because SECURITY DEFINER bypasses RLS entirely, its
// auth.uid()/company check IS the tenant boundary — attacked directly by
// scripts/rls-isolation-matrix.mjs, positive control included.
//
// A fourth thing is deliberately NOT stored and is computed live: WHICH crew
// members are currently being skipped, and why. cron_runs keeps the COUNTS per
// day, which is what makes a historical day legible; naming the people would
// mean writing a list of names into a ledger row every morning for a question
// that is almost always about right now. So the names come from today's crew,
// and the screen says so.

export interface JobSchedule {
  jobKind: JobKind;
  schedule: CompanySchedule;
}

export interface CronRunRow {
  jobKind: string;
  runDate: string;
  dueHour: number;
  ranHour: number;
  ranAt: string;
  messaged: number;
  skippedIdle: number;
  failed: number;
  excludedNoConsent: number;
  excludedUnreachable: number;
  excludedInactive: number;
  managersNoConsent: number;
  noManagerAccount: boolean;
}

/** One recipient of one send, as the debug view renders it. */
export interface SendRow {
  id: string;
  jobKind: string;
  runDate: string;
  audience: 'worker' | 'manager';
  /** The crew member's or manager's name, resolved on the tenant client. */
  name: string | null;
  /**
   * What actually happened, most-advanced-fact-first. Meta's callbacks are not
   * ordered, so this reads the columns in the order of certainty rather than
   * deriving one from another: a `read_at` present with no `delivered_at` is a
   * real state and must render as "read", not as a contradiction.
   */
  outcome: 'sent' | 'delivered' | 'read' | 'failed' | 'skipped' | 'pending';
  /** Meta's numeric code, from the delivery callback or from our own send error. */
  errorCode: number | null;
  /** The raw text, shown next to the plain-language explanation. */
  errorText: string | null;
  createdAt: string;
}

/** A person who will hear nothing, and the reason. Computed from today's crew. */
export interface SkipReason {
  name: string;
  reason: 'noConsent' | 'unreachable' | 'inactive';
}

export interface AutomationsData {
  jobs: JobSchedule[];
  runs: CronRunRow[];
  sends: SendRow[];
  skips: SkipReason[];
  managerNoConsent: string[];
  noManagerAccount: boolean;
  /** True when the history could not be read at all — a deploy before 0036. */
  historyUnavailable: boolean;
}

/** How far back the screen looks. A fortnight is enough to see a pattern and
 *  short enough that the read stays a single fast query. */
export const HISTORY_DAYS = 14;

export async function loadAutomations(ctx: AuthContext): Promise<AutomationsData> {
  const { db, companyId } = ctx;

  const to = await lisbonToday(db);
  const from = shiftDate(to, -(HISTORY_DAYS - 1));

  const [schedules, runs, history, crew, managers] = await Promise.all([
    db.from('company_schedules').select('job_kind, send_hour, enabled').eq('company_id', companyId),
    db
      .from('cron_runs')
      .select('*')
      .eq('company_id', companyId)
      .gte('run_date', from)
      .order('run_date', { ascending: false }),
    // The one SECURITY DEFINER read. It raises rather than returning nothing
    // for a caller with no company — see the migration on the null-guard trap —
    // so an error here is either that (impossible on this page, which is behind
    // requireAuth) or a deploy before 0036.
    db.rpc('company_send_history', { p_from: from, p_to: to }),
    // select('*') for the deploy-ordering reason in AGENTS.md — this read has
    // to survive both 0025's consent columns and anything appended later.
    db.from('workers').select('*').eq('company_id', companyId),
    db.from('profiles').select('*').eq('company_id', companyId),
  ]);

  const chosen = new Map<string, { sendHour: number; enabled: boolean }>();
  for (const row of schedules.data ?? []) {
    if (!isSendHour(row.send_hour)) continue;
    chosen.set(row.job_kind, { sendHour: row.send_hour, enabled: row.enabled });
  }
  const jobs: JobSchedule[] = JOB_KINDS.map(jobKind => {
    const stored = chosen.get(jobKind);
    return {
      jobKind,
      schedule: stored
        ? { ...stored, chosen: true }
        : { sendHour: DEFAULT_SEND_HOURS[jobKind], enabled: true, chosen: false },
    };
  });

  if (history.error) {
    logEvent('automations.history_unavailable', {
      companyId,
      error: history.error.message,
      code: history.error.code,
    });
  }

  // Names, from the tenant's own RLS-scoped reads. Deliberately NOT returned by
  // company_send_history: that function's job is to widen a deny-all table by
  // the smallest surface that answers the question, and a join it does not need
  // is surface it should not have.
  const workerNames = new Map((crew.data ?? []).map(w => [w.id, w.name]));
  const managerNames = new Map((managers.data ?? []).map(p => [p.id, p.full_name]));

  const sends: SendRow[] = (history.data ?? []).map(row => ({
    id: row.id,
    jobKind: row.kind,
    runDate: row.notification_date,
    audience: row.audience === 'manager' ? 'manager' : 'worker',
    name:
      row.audience === 'manager'
        ? (row.profile_id ? (managerNames.get(row.profile_id) ?? null) : null)
        : (row.worker_id ? (workerNames.get(row.worker_id) ?? null) : null),
    outcome: readOutcome(row),
    // The delivery callback's code wins over our own send-time message: it is
    // the later verdict, and a message can be accepted and then fail.
    errorCode: row.delivery_error_code ?? readMetaErrorCode(row.error),
    errorText: row.delivery_error ?? row.error ?? null,
    createdAt: row.created_at,
  }));

  // ── who is being skipped, right now ─────────────────────────────────────
  // The SAME function both crons run, called on the same table, so this screen
  // cannot disagree with them about who is messageable. A second copy of the
  // consent rule is the one thing 0025 and AGENTS.md both forbid.
  const rows = crew.data ?? [];
  const partition = partitionCrew(rows);
  const messageableIds = new Set(partition.messageable.map(({ worker }) => worker.id));
  const skips: SkipReason[] = rows
    .filter(w => !messageableIds.has(w.id))
    .map(w => ({
      name: w.name,
      reason: w.active !== true ? ('inactive' as const) : recipientless(w) ? ('unreachable' as const) : ('noConsent' as const),
    }));

  const managerRows = managers.data ?? [];
  return {
    jobs,
    runs: (runs.data ?? []).map(row => ({
      jobKind: row.job_kind,
      runDate: row.run_date,
      dueHour: row.due_hour,
      ranHour: row.ran_hour,
      ranAt: row.ran_at,
      messaged: row.messaged,
      skippedIdle: row.skipped_idle,
      failed: row.failed,
      excludedNoConsent: row.excluded_no_consent,
      excludedUnreachable: row.excluded_unreachable,
      excludedInactive: row.excluded_inactive,
      managersNoConsent: row.managers_no_consent,
      noManagerAccount: row.no_manager_account,
    })),
    sends,
    skips,
    managerNoConsent: managerRows.filter(p => !consenting(p)).map(p => p.full_name),
    // The finding that had no shape anywhere before #51: a company with crew
    // and no manager account can never receive its own daily summary, and from
    // inside the product that was indistinguishable from having received one.
    noManagerAccount: managerRows.length === 0,
    historyUnavailable: history.error != null,
  };
}

/**
 * Which fact about this send is the most advanced one we know.
 *
 * Read in order of certainty rather than derived: Meta's callbacks are NOT
 * ordered, so a `read` really can land before its `delivered`, and a row with
 * `read_at` and no `delivered_at` is a true state rather than a contradiction.
 * Inventing the missing one would put a timestamp in front of a manager that
 * nobody ever reported.
 */
function readOutcome(row: {
  status: string;
  read_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
}): SendRow['outcome'] {
  if (row.failed_at || row.status === 'failed') return 'failed';
  if (row.read_at) return 'read';
  if (row.delivered_at) return 'delivered';
  if (row.status === 'skipped') return 'skipped';
  if (row.status === 'sent') return 'sent';
  // 'pending' means the claim was written and the send never resolved — the
  // function died mid-flight. Rare, and worth showing rather than rounding to
  // one of the others.
  return 'pending';
}

/** Mirrors recipientFor's question without importing the whole send stack. */
function recipientless(worker: { phone?: string | null; whatsapp_user_id?: string | null }): boolean {
  return !worker.phone && !worker.whatsapp_user_id;
}

/** hasWhatsAppConsent's rule, latest-wins, failing CLOSED on anything unreadable
 *  — the same direction 0025 requires everywhere else. */
function consenting(row: { whatsapp_opt_in_at?: string | null; whatsapp_opt_out_at?: string | null }): boolean {
  const inAt = Date.parse(row.whatsapp_opt_in_at ?? '');
  if (!Number.isFinite(inAt)) return false;
  const outAt = Date.parse(row.whatsapp_opt_out_at ?? '');
  if (!Number.isFinite(outAt)) return true;
  return inAt > outAt;
}

/**
 * ONE CLOCK. The history is keyed on `notification_date`, which the cron takes
 * from lisbon_today(), so the screen's idea of "today" has to come from the
 * same place — a browser clock in another timezone would silently drop or add
 * a day at the edges of the range.
 */
async function lisbonToday(db: AuthContext['db']): Promise<string> {
  const { data, error } = await db.rpc('lisbon_today');
  if (error || !data) {
    // Degrading to the server's own date rather than failing the page: the only
    // cost is a range boundary an hour out at midnight, and the alternative is
    // a blank screen because a clock read failed.
    return new Date().toISOString().slice(0, 10);
  }
  return data;
}

function shiftDate(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
