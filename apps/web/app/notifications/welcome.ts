import type { Db } from '@capo/db/client';
import type { WhatsAppRecipient } from '@capo/core/channels/whatsapp';
import { coerceLocale, type Locale } from '@capo/i18n/locale';
import { getCatalog } from '@capo/i18n/catalog';
import { hasWhatsAppConsent, recipientFor } from '../../lib/whatsapp';
import { decideWelcomeRetry, type WelcomeLedgerEntry } from '../../lib/welcome-retry';
import { clamp, nameList, partitionCrew, readLastInboundAt } from './briefing';

// ── THE WELCOME (issue #45) ─────────────────────────────────────────────────
//
// "We need a welcome to Capo as soon as a number is added to the system."
//
// One message, once per person, ever. It is the only message in the product
// whose job is to explain what the sender IS — everything else assumes the
// reader already knows.
//
// Deliberately here rather than in @capo/core, for the same reason the briefing
// renderers are: this needs the USER copy catalog, which must never enter the
// agent bundle. Deterministic, with no model call, for the same reason again.
//
// ── THE ORDER OF CONSENT AND WELCOME, WHICH IS FORCED AND NOT CHOSEN ────────
// The tempting design is to make the welcome the place where Capo ASKS to be
// allowed to message somebody. It is not available. A proactive WhatsApp
// message — one sent to a person who has not written to us in the last 24 hours
// — is legal only as an approved template AND only after an opt-in is on
// record. A message asking for the opt-in would itself be a proactive message
// sent without one, which is the precise thing that gets a business number
// banned, and Meta's own policy is explicit that the opt-in is gathered through
// the business's own channels.
//
// So consent comes FIRST, always, and it is collected off WhatsApp: the manager
// asks their crew on site and records it (through Capo's guarded `update_worker`
// tool, or /perfil for their own number). This message then CONFIRMS that
// agreement, says what will arrive, and states how to stop. That is what a
// compliant first template looks like, and it is why nothing in `welcome.ts`
// ever asks a yes/no question.
//
// The consequence to hold on to: a worker with no recorded consent is not
// "waiting for a welcome" — they are waiting for their manager. The sweep does
// not send to them, does not claim a row for them, and will pick them up on the
// first run after consent is recorded, however many weeks later that is.

/**
 * The `notification_log.kind` this send claims under.
 *
 * The third kind, beside 'daily_briefing' and 'task_checkin', and the ONLY one
 * that is once-per-person rather than once-per-person-per-day. That difference
 * is enforced in Postgres by 0033's partial unique index, never here — see
 * loadPendingWelcomes on why the read below is an optimisation and not the
 * lock.
 */
export const WELCOME_KIND = 'welcome';

export type WelcomeAudience = 'worker' | 'manager';

export interface WelcomeTarget {
  audience: WelcomeAudience;
  /** `workers.id` for a crew member, `profiles.id` for a manager. */
  id: string;
  name: string;
  recipient: WhatsAppRecipient;
  /**
   * Which language this person reads. A crew member who has never chosen one
   * inherits the company's (workers.language is nullable and the null means
   * exactly that); a manager always has their own.
   */
  locale: Locale;
  /**
   * When they last wrote to us (0030), or null. The only input to the
   * template-vs-free-form decision, and it fails closed toward the paid
   * template on anything unreadable — see withinFreeFormWindow.
   *
   * For a welcome this is almost always null by construction: the message
   * exists because nobody has heard from Capo yet. The non-null case is real
   * though — somebody added on Monday whose consent was recorded on Friday, who
   * messaged the business number in between — and it is FREE, so it is worth
   * the branch.
   */
  lastInboundAt: string | null;
}

export interface CompanyWelcomes {
  companyId: string;
  companyLocale: Locale;
  companyName: string;
  /** Everyone who may be welcomed right now, crew first, then managers. */
  pending: WelcomeTarget[];
  /** Crew dropped for want of a recorded opt-in. The dominant reason, by far. */
  excludedNoConsent: number;
  /** Crew with neither a phone nor a stored BSUID. */
  excludedUnreachable: number;
  /** Crew rows switched off. */
  excludedInactive: number;
  /** Managers dropped for want of an opt-in or an address. */
  excludedManagers: number;
  /** People already introduced. Not a problem — it is the steady state. */
  alreadyWelcomed: number;
  /**
   * People whose welcome has FAILED before and is not being retried on this
   * run: the last failure's error classifies as permanent, the attempt cap is
   * spent, or today's one attempt already happened (issue #121). Counted so a
   * crew that never hears from Capo is visible in this route's report rather
   * than only in the ledger.
   */
  excludedFailed: number;
}

/**
 * Who in this company has never been introduced to Capo, and may be.
 *
 * ── THE READ BELOW IS AN OPTIMISATION, NOT THE LOCK ────────────────────────
 * `notification_log` is swept for this company's `kind = 'welcome'` rows so the
 * sweep does not attempt a doomed INSERT for every already-welcomed person on
 * every run, ninety-six times a day. It is NOT what makes the welcome
 * once-ever: two invocations could read this set at the same instant and both
 * find somebody missing from it. What actually refuses the second one is
 * 0033's partial unique index — narrowed by 0041 to `status <> 'failed'` —
 * through claimNotification's 23505 → null. Do not
 * "simplify" by trusting this read, and do not add app-level state beside it —
 * the ledger is the lock, exactly as it is for both daily sends.
 *
 * ── EXCEPT THE RETRY POLICY, WHICH LIVES ONLY HERE (issue #121) ────────────
 * Since 0041 a FAILED welcome releases its claim, so a person whose send Meta
 * refused can be tried again — the pilot tenant's three crew members, failed
 * on a template Meta did not yet know, were otherwise blocked forever. What
 * keeps that retry from becoming a repeating paid send is decideWelcomeRetry
 * (apps/web/lib/welcome-retry.ts): at most WELCOME_MAX_ATTEMPTS failed rows
 * per person, only while the NEWEST failure's error code classifies as
 * retryable, and never twice in one Lisbon day. The last rule is also enforced
 * by Postgres (0016's daily unique key refuses a second claim per person per
 * day, whatever this read decides), but the CAP and the error classification
 * are not in the schema at all — this filter is genuinely policy, not an
 * optimisation, and removing it would retry a permanently dead number once a
 * day forever.
 *
 * ── THE CONSENT GATE IS partitionCrew, SHARED WITH BOTH DAILY SENDS ────────
 * Crew go through the same function the 07:00 briefing and the late-afternoon
 * check-in reach their recipients through, so a worker this send may message is
 * by construction a worker those sends may message. Managers have no `workers`
 * row, so they take the same route /api/cron/reminders has always taken for
 * them: the identical `hasWhatsAppConsent` predicate, called directly on the
 * profile.
 */
export async function loadPendingWelcomes(
  db: Db,
  company: { id: string; name: string; language: string | null },
  /** Today's Lisbon date (`yyyy-mm-dd`), straight from lisbon_today() — the
   *  retry policy's one-attempt-per-day rule needs it, and taking it as an
   *  argument keeps this function on the one clock everything else reads. */
  today: string,
): Promise<CompanyWelcomes> {
  const companyLocale = coerceLocale(company.language);

  const [{ data: crew, error: crewError }, { data: managers, error: managersError }, { data: done, error: doneError }] =
    await Promise.all([
      // select('*') rather than a column list, for the reason AGENTS.md gives:
      // a deploy that lands before a migration that APPENDS a column would
      // otherwise fail the whole read instead of degrading. Here the degraded
      // reading of a missing consent column is "no consent on record", which is
      // the fail-closed direction and stops the send rather than mis-aiming it.
      db.from('workers').select('*').eq('company_id', company.id),
      db.from('profiles').select('*').eq('company_id', company.id).order('created_at'),
      // status/error/notification_date are 0016 columns — present on every
      // deploy this code can land on, so naming them is safe — and they are
      // what the retry policy reads: which rows block, whether the newest
      // failure is retryable, and whether today's one attempt already
      // happened.
      db
        .from('notification_log')
        .select('worker_id, profile_id, status, error, notification_date')
        .eq('company_id', company.id)
        .eq('kind', WELCOME_KIND),
    ]);
  if (crewError) throw new Error(`workers read failed: ${crewError.message}`);
  if (managersError) throw new Error(`profiles read failed: ${managersError.message}`);
  // Throws rather than falling back to an empty set. An empty set and a failed
  // read look identical downstream, and one of them means "nobody has been
  // welcomed yet" — which would re-introduce Capo to the entire crew.
  if (doneError) throw new Error(`notification_log read failed: ${doneError.message}`);

  // One person's whole welcome history, then ONE verdict over it. The map is
  // keyed on whichever of worker_id/profile_id the row carries (exactly one is
  // non-null — 0016's notification_log_one_target CHECK).
  const ledger = new Map<string, WelcomeLedgerEntry[]>();
  for (const row of done ?? []) {
    const person = row.worker_id ?? row.profile_id;
    if (!person) continue;
    const history = ledger.get(person);
    if (history) history.push(row);
    else ledger.set(person, [row]);
  }
  // May this person be (re)welcomed? 'never_attempted' is the ordinary case;
  // 'retry' is #121's failed-and-retryable one; everything else stays out of
  // `pending` and is counted below so it stays visible.
  const welcomable = (id: string) => {
    const verdict = decideWelcomeRetry(ledger.get(id) ?? [], today);
    return verdict === 'never_attempted' || verdict === 'retry';
  };
  // Counted over the LEDGER rather than over today's messageable people, so
  // the numbers keep their pre-#121 meaning: a person welcomed last year and
  // since deactivated still counts as introduced.
  let alreadyWelcomed = 0;
  let excludedFailed = 0;
  for (const history of ledger.values()) {
    const verdict = decideWelcomeRetry(history, today);
    if (verdict === 'blocked') alreadyWelcomed += 1;
    else if (verdict !== 'retry') excludedFailed += 1;
  }

  const { messageable, excludedNoConsent, excludedUnreachable, excludedInactive } = partitionCrew(crew ?? []);

  const pending: WelcomeTarget[] = [];
  for (const { worker, recipient } of messageable) {
    if (!welcomable(worker.id)) continue;
    pending.push({
      audience: 'worker',
      id: worker.id,
      name: worker.name,
      recipient,
      locale: worker.language ? coerceLocale(worker.language) : companyLocale,
      lastInboundAt: readLastInboundAt(worker),
    });
  }

  let excludedManagers = 0;
  for (const manager of managers ?? []) {
    const recipient = recipientFor(manager);
    // The manager's own opt-in. Being the account holder is not consent to be
    // messaged on WhatsApp, which is the same line /api/cron/reminders draws
    // for their daily briefing — and it is the reason a manager who has never
    // ticked the box on /perfil is never welcomed either.
    if (!recipient || !hasWhatsAppConsent(manager)) {
      excludedManagers += 1;
      continue;
    }
    if (!welcomable(manager.id)) continue;
    pending.push({
      audience: 'manager',
      id: manager.id,
      name: manager.full_name,
      recipient,
      locale: coerceLocale(manager.language),
      lastInboundAt: readLastInboundAt(manager),
    });
  }

  return {
    companyId: company.id,
    companyName: company.name,
    companyLocale,
    pending,
    excludedNoConsent,
    excludedUnreachable,
    excludedInactive,
    excludedManagers,
    alreadyWelcomed,
    excludedFailed,
  };
}

/**
 * A company name is manager-authored free text and is about to be substituted
 * into a Meta template parameter, where a newline is a 132000 that fails the
 * whole send. clamp() flattens whitespace as well as trimming.
 *
 * 60 characters, the same cap the chat-thread notes use for a person's name:
 * long enough for a real construction company, short enough that a pasted
 * paragraph cannot push the rest of the sentence past Meta's per-parameter
 * ceiling.
 */
const MAX_COMPANY_NAME = 60;

/**
 * ── FEDERICO: this is the product-voice dial for the first thing Capo ever
 * says to somebody. ──
 *
 * Returns the approved template's two body parameters: `[name, middle]`.
 *
 * The template's fixed wrapper — "Olá {{1}}, sou o Capo, o assistente de obra."
 * before, "Responde STOP para deixar de receber." after — is frozen at Meta's
 * approval and cannot be edited from this repository. Everything you can change
 * without a re-approval is in `welcomeWorker` / `welcomeManager` in
 * @capo/i18n, which is `middle` here. That split is the lesson of issue #49,
 * where a sentence in the frozen half went out to every worker every morning
 * for months with nothing in the code able to stop it.
 */
export function renderWelcome(target: WelcomeTarget, companyName: string): [name: string, middle: string] {
  const t = getCatalog(target.locale).reminders;
  const company = clamp(companyName, MAX_COMPANY_NAME);
  const middle = target.audience === 'worker' ? t.welcomeWorker(company) : t.welcomeManager(company);
  return [clamp(target.name, 40), middle];
}

/**
 * The SAME welcome, in the other envelope.
 *
 * Sent when the recipient wrote to us in the last 23 hours, which makes
 * ordinary text legal and free. It says exactly what the template says — the
 * greeting and the opt-out line are read from the same two catalog keys the
 * approved template body was BUILT from (scripts/whatsapp-templates.ts), so the
 * two envelopes cannot drift into introducing Capo differently depending on an
 * invisible property of the recipient.
 *
 * The only difference is shape: free-form text may have newlines, so it gets
 * three short paragraphs instead of one run-on line.
 */
export function renderWelcomeFreeForm(target: WelcomeTarget, companyName: string): string {
  const t = getCatalog(target.locale).reminders;
  const [name, middle] = renderWelcome(target, companyName);
  return [t.welcomeGreeting(name), middle, t.welcomeStop].join('\n\n');
}

/**
 * The manager's CHAT-THREAD note: who Capo just introduced itself to.
 *
 * The fourth system note, after the morning briefing, the check-in ask and a
 * crew member's answer to it (issue #47). It is here for the same reason those
 * three are: a manager should never find a conversation on their crew's phones
 * that Capo has no record of starting.
 *
 * CREW ONLY. A manager reads their own welcome on their own phone; a note
 * telling them Capo had said hello to them would be strange, and would arrive
 * in the same thread. `names` is already joined and capped by the caller, and
 * every name in it was typed by the MANAGER — never a word a crew member wrote.
 * See notifications/thread.ts for why that is a structural boundary.
 */
export function renderWelcomeEvent(notified: number, names: readonly string[], locale: Locale): string {
  return getCatalog(locale).reminders.welcomeEvent({ notified, names: nameList(names, locale) });
}
