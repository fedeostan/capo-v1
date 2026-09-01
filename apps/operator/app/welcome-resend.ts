import { readMetaErrorCode, toTemplateParam, type WhatsAppRecipient } from '@capo/core/channels/whatsapp';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

// The pure half of the operator's "resend a failed welcome" button (issue
// #123, part A). Everything here is policy and rendering — no Db, no clock,
// no network — so it can be read top to bottom as the safety argument, and a
// future check script can drive it with no credentials.
//
// ── WHY A DISTINCT notification_log KIND ────────────────────────────────────
// notification_log's unique key (kind, audience, worker_id, profile_id,
// notification_date) is the only thing preventing a double-billed send, and
// AGENTS.md forbids widening it. A resend row under a kind of its OWN
// therefore: (a) never collides with the failed original — the evidence row is
// kept, untouched; (b) never trips 0033/0041's welcome-once index, which is
// scoped `where kind = 'welcome'`; and (c) still gets one-per-person-per-DAY
// idempotency for free from the daily key, which is exactly the double-click
// protection an operator button needs. The kind is also the attribution the
// issue demands: a row under this kind cannot be mistaken for a sweep send.
//
// `kind` is unconstrained text on notification_log — 0016 CHECKs `audience`
// and `status` only, and no later migration (through 0041) adds a CHECK on
// kind — so introducing this value needs NO migration. The tenant-facing
// send-history screen renders unknown kinds by their raw value and attaches
// sends to cron_runs rows (which never carry this kind), so a resend row is
// invisible there rather than mislabelled — the same treatment 'welcome' rows
// already get.
export const OPERATOR_RESEND_WELCOME_KIND = 'operator_resend_welcome';

// ── HAND-COPIED CONSTANTS AND RULES ─────────────────────────────────────────
// The three items below are duplicated from apps/web, because apps must not
// import each other's modules (the workspace graph is i18n ← db ← core ←
// {web, operator}; the briefing/welcome renderers live in apps/web only
// because @capo/core must never carry the user copy catalog — apps/operator
// may). Change one and change the other, exactly like checkWorkerMenuScope in
// scripts/rls-isolation-matrix.mjs:
//
//   WELCOME_MAX_ATTEMPTS + WELCOME_RETRYABLE_META_CODES
//     ← apps/web/lib/welcome-retry.ts (issue #121)
//   clamp ← apps/web/app/notifications/briefing.ts
//   recipientFor / describeRecipient ← apps/web/lib/whatsapp.ts

/** ← apps/web/lib/welcome-retry.ts — the sweep's own cap. */
const WELCOME_MAX_ATTEMPTS = 3;

/**
 * ← apps/web/lib/welcome-retry.ts — the codes the sweep will retry on its own
 * (132001 template-not-approved, 130429 rate limit). Used INVERTED here: while
 * the newest failure is one of these and the cap is not spent, the sweep is
 * still on the case and the operator button refuses, or two welcomes go out.
 */
const WELCOME_RETRYABLE_META_CODES = new Set([132001, 130429]);

/** ← apps/web/app/notifications/briefing.ts — flatten whitespace, cap, ellipsis. */
function clamp(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * ← apps/web/lib/whatsapp.ts — phone first, BSUID fallback, null when neither.
 * The '+' strip is phone-only by construction: a BSUID never reaches it.
 */
export function recipientFor(row: {
  phone?: string | null;
  whatsapp_user_id?: string | null;
}): WhatsAppRecipient | null {
  if (row.phone) return { kind: 'phone', waId: row.phone.replace(/^\+/, '') };
  if (row.whatsapp_user_id) return { kind: 'bsuid', userId: row.whatsapp_user_id };
  return null;
}

/** ← apps/web/lib/whatsapp.ts — log/screen-safe label, never a full identifier. */
export function describeRecipient(recipient: WhatsAppRecipient): string {
  return recipient.kind === 'phone'
    ? `phone:…${recipient.waId.slice(-4)}`
    : `bsuid:…${recipient.userId.slice(-4)}`;
}

// ── WHAT A RESEND SENDS ─────────────────────────────────────────────────────
// The same capo_welcome template the sweep sends, with the same two body
// parameters, built from the same catalog keys renderWelcome uses
// (apps/web/app/notifications/welcome.ts): {{1}} the person's name clamped to
// 40, {{2}} the audience sentence around the company name clamped to 60.
//
// ALWAYS the paid template, never the free-form branch the sweep also has. One
// path only: the population this button exists for — people whose welcome
// FAILED — has, almost by definition, never written to Capo, so the free-form
// window is closed for them anyway; and a second rendering path here would be
// a second copy of renderWelcomeFreeForm to keep in sync for a case that
// costs cents when it occurs.

const MAX_COMPANY_NAME = 60;

export interface WelcomeSendPlan {
  templateName: 'capo_welcome';
  /** Meta's underscore locale for this person ('pt_PT'…). */
  languageCode: string;
  /** [{{1}}, {{2}}], exactly as handed to sendWhatsAppTemplate. */
  bodyParams: [string, string];
  /**
   * The whole message as the approved template renders it — the frozen
   * wrapper is `welcomeGreeting({{1}}) {{2}} welcomeStop`
   * (scripts/whatsapp-templates.ts), reconstructed here so the operator
   * confirms actual words, not parameter fragments.
   */
  renderedPreview: string;
}

export function planWelcomeResend(args: {
  audience: 'worker' | 'manager';
  personName: string;
  companyName: string;
  locale: Locale;
}): WelcomeSendPlan {
  const t = getCatalog(args.locale).reminders;
  const company = clamp(args.companyName, MAX_COMPANY_NAME);
  const name = clamp(args.personName, 40);
  const middle = args.audience === 'worker' ? t.welcomeWorker(company) : t.welcomeManager(company);
  // toTemplateParam is what sendWhatsAppTemplate applies on the wire; applying
  // it here too makes the preview byte-identical to what Meta receives.
  const bodyParams: [string, string] = [toTemplateParam(name), toTemplateParam(middle)];
  return {
    templateName: 'capo_welcome',
    languageCode: t.templateLanguage,
    bodyParams,
    renderedPreview: `${t.welcomeGreeting(bodyParams[0])} ${bodyParams[1]} ${t.welcomeStop}`,
  };
}

// ── MAY THIS PERSON BE RESENT A WELCOME? ────────────────────────────────────
// The verdict exists to close the one hole a distinct kind opens: rows under
// it are invisible to the sweep's `kind = 'welcome'` read, so nothing in the
// sweep knows a resend happened. If the operator resent somebody the sweep was
// still going to retry (#121: newest failure retryable, under the cap), the
// person would be welcomed twice on two different days. So the button refuses
// exactly while the sweep is still on the case, and allows only the people the
// sweep has abandoned — which is the population the button exists for.

/** One ledger row, as loadWelcomeResendContext reads it. Absent fields block. */
export interface ResendLedgerRow {
  kind?: string | null;
  status?: string | null;
  error?: string | null;
  notification_date?: string | null;
}

export type ResendVerdict =
  /** A welcome (or an earlier operator resend) was DELIVERED. Once ever means ever. */
  | { allowed: false; reason: 'already_welcomed' }
  /** A 'skipped' welcome row — 0033's backfill marked this person as already
   *  knowing Capo when the feature shipped. Not a failure to repair. */
  | { allowed: false; reason: 'marked_known' }
  /** No welcome rows at all: the sweep welcomes them on its next quarter-hour
   *  run (Lisbon 09–19). An operator send now would race it. */
  | { allowed: false; reason: 'never_attempted' }
  /** Newest failure is retryable and the cap is not spent — the sweep is
   *  still retrying on its own (#121), one attempt a day. Resending now risks
   *  a second welcome tomorrow. */
  | { allowed: false; reason: 'sweep_will_retry' }
  /** A row whose status this code does not recognise. Fail closed. */
  | { allowed: false; reason: 'unreadable' }
  /** All attempts failed and the sweep is done with them. */
  | { allowed: true; reason: 'sweep_exhausted' | 'sweep_gave_up' }
  /** A welcome claim stuck at 'pending' — the cron died mid-send, and 0041's
   *  index (status <> 'failed') holds that claim forever, so the sweep can
   *  never try again. The original MAY have reached Meta before the crash:
   *  the preview must say a duplicate is possible and let a human decide. */
  | { allowed: true; reason: 'stuck_claim' };

const KNOWN_STATUSES = new Set(['sent', 'failed', 'skipped', 'pending']);

export function decideOperatorResend(rows: readonly ResendLedgerRow[]): ResendVerdict {
  const welcome = rows.filter(r => r.kind === 'welcome');
  const resends = rows.filter(r => r.kind === OPERATOR_RESEND_WELCOME_KIND);

  // A delivered introduction — by either path — blocks forever. The operator
  // path honours once-ever exactly as the sweep's index does.
  if (welcome.some(r => r.status === 'sent') || resends.some(r => r.status === 'sent')) {
    return { allowed: false, reason: 'already_welcomed' };
  }
  if (welcome.some(r => r.status === 'skipped')) return { allowed: false, reason: 'marked_known' };
  if (rows.some(r => !r.status || !KNOWN_STATUSES.has(r.status))) {
    return { allowed: false, reason: 'unreadable' };
  }
  if (welcome.length === 0) return { allowed: false, reason: 'never_attempted' };
  if (welcome.some(r => r.status === 'pending')) return { allowed: true, reason: 'stuck_claim' };

  // All welcome rows are 'failed' from here down — the same precondition the
  // sweep's decideWelcomeRetry reaches, judged from the other side: not "may
  // the sweep retry?" but "has the sweep stopped?".
  if (welcome.length >= WELCOME_MAX_ATTEMPTS) return { allowed: true, reason: 'sweep_exhausted' };

  // Newest failure, the sweep's way (welcome-retry.ts): a dateless row
  // outranks every dated one, so both sides judge the same row.
  let newest: ResendLedgerRow | undefined;
  for (const row of welcome) {
    if (!row.notification_date) {
      newest = row;
      break;
    }
    if (!newest?.notification_date || row.notification_date > newest.notification_date) newest = row;
  }

  const code = readMetaErrorCode(newest?.error);
  if (code !== null && WELCOME_RETRYABLE_META_CODES.has(code)) {
    return { allowed: false, reason: 'sweep_will_retry' };
  }
  // Unreadable or permanent code: the sweep classifies this exact case as
  // permanent and will never touch it again (welcome-retry.ts fails closed
  // toward NOT spending money) — which is precisely when a human override,
  // behind a preview, is the only path left.
  return { allowed: true, reason: 'sweep_gave_up' };
}
