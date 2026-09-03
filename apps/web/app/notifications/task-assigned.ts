import { getDb } from '@capo/db/client';
import type { Db } from '@capo/db/client';
import {
  sendWhatsAppTemplate,
  sendWhatsAppText,
  toTemplateParam,
  withinFreeFormWindow,
} from '@capo/core/channels/whatsapp';
import { getCatalog } from '@capo/i18n/catalog';
import { dayLinkUrl, mintDayLinks } from '@/lib/day-link';
import { logEvent } from '@/lib/log';
import {
  renderAssignmentMessage,
  renderAssignmentTemplateParam,
} from '@/lib/task-assigned-message';
import { taskAssignedTemplateApproved } from '@/lib/task-assigned-template';
import { withinAssignmentHours } from '@/lib/task-assigned-window';
import { sendConfigFor, whatsappSendEnv, type WhatsAppEnv } from '@/lib/whatsapp';
import {
  billableCompanies,
  claimNotification,
  describeSendError,
  readLisbonClock,
  resolveNotification,
} from '@/lib/cron';
import { briefableToday, loadCompanyBriefing } from './briefing';

// ── "the crew member hears about it now, not tomorrow at 07:00" (issue W7) ──
//
// FEDERICO'S RULE, in his own words: "When we assign a new task to a worker we
// need to send it immediately, only in working hours. If the task is for
// another day we don't send anything; only if the task starts this same day."
//
// Before this, the only moment Capo told a crew member anything was 07:00. A
// task given to Miguel at nine in the morning reached him the following
// morning — if it was still active by then — and nothing anywhere told the
// manager that the person had not been told. This drains the queue that
// 0048_task_assignment_notices.sql fills.
//
// ── THE TRIGGER QUEUES, THIS DECIDES ───────────────────────────────────────
// The database trigger is the door nobody can forget (there are seven ways a
// task gains an assignee). It deliberately knows nothing about calendars: it
// writes a cheap row saying "somebody was put on this task". EVERY judgement
// about whether that is worth a message is made here, against `task_board` —
// the one definition of what is on today (AGENTS.md). A second copy of that
// rule inside a trigger would be a second opinion, and the symptom would be
// Capo messaging somebody about work the board says is next week.
//
// ── WHAT THIS COSTS, AND WHAT IT DOES NOT ──────────────────────────────────
// INSIDE the crew member's own 24-hour window this is ordinary free-form text:
// immediate, and FREE. It carries the whole day, rendered by exactly the
// functions the 07:00 briefing uses, with the new task marked — because a
// person told only "you have a new task" then has to ask what else they were
// supposed to be doing.
//
// OUTSIDE it, free-form is refused outright (131047) and the only legal contact
// is the pre-approved template `capo_task_assigned`. That one is PAID, so it is
// claimed in `notification_log` — one per crew member per day by that table's
// unique key, which is the whole reason a second assignment the same afternoon
// deliberately sends nothing. It is also gated on
// TASK_ASSIGNED_APPROVED_LANGUAGES, which is EMPTY until Meta approves the
// submission: until then an out-of-window crew member gets nothing extra and
// still gets the task in tomorrow's 07:00 briefing, which is the product this
// feature improves on rather than replaces.
//
// ── FAILURE POSTURE ────────────────────────────────────────────────────────
// Nothing here throws, at any level. This runs inside `after()` on a manager's
// own request on three of its five call sites, so a failure to ANNOUNCE an
// assignment must never cost the manager the assignment itself — the task row
// is already written and the board already shows it by the time this runs.
// Every failure is swallowed into a greppable `task_assigned.*` line. The cost
// of that posture, stated rather than hidden: a revoked grant or an unapplied
// migration presents as a channel that quietly stops announcing. Grep
// `task_assigned.read_failed` and `task_assigned.send_failed` before concluding
// that a quiet queue means a quiet week.

/** `notification_log.kind` for the PAID out-of-window template, and nothing else. */
export const TASK_ASSIGNED_KIND = 'task_assigned';

/**
 * How many queued notices one drain looks at, across every company.
 *
 * A wall-clock control, not a cost control: `apply_plan` can queue thirty
 * notices in one approved card, and the sends are serial Graph API round trips
 * inside somebody's `after()`. Whatever is left over is picked up by the
 * fifteen-minute cron.
 */
const MAX_NOTICES_PER_DRAIN = 200;

/** How many people one company may be messaged about in a single drain. Same
 *  reasoning as the welcome sweep's MAX_PER_COMPANY_PER_RUN. */
const MAX_WORKERS_PER_COMPANY_PER_DRAIN = 20;

/**
 * How recently this person must have been sent an assignment note before a new
 * one is DEFERRED rather than sent.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * A manager assigning five tasks to Miguel one at a time on /tarefas fires five
 * drains inside a minute, and each message carries Miguel's WHOLE day — so he
 * would read five nearly identical messages, four of them noise. Deferring is
 * what turns that into one: the later notices stay queued, and the next
 * fifteen-minute cron sends ONE message with all of them marked.
 *
 * The deferral is not a silence. A deferred notice is still queued, still
 * inside its own Lisbon day, and the cron is the safety net the whole design
 * already leans on — the same relationship /api/cron/push has with its
 * immediate producers. The first assignment is still announced within seconds,
 * which is the promise the feature makes.
 */
const COALESCE_WINDOW_MS = 5 * 60_000;

/**
 * What the drain decided about one notice. Recorded on the row, and the only
 * place these strings are defined — 0048 deliberately puts no CHECK on the
 * column so that a new outcome can never fail a write at the moment somebody
 * is waiting for their message.
 */
type NoticeOutcome =
  /** Sent as free text, inside the crew member's own 24-hour window. */
  | 'sent_free_form'
  /** Sent as the paid template, outside it. */
  | 'sent_template'
  /** The task does not start today, or is no longer in a briefable status. */
  | 'not_today'
  /** No consent, not reachable, or not an active crew row. */
  | 'not_messageable'
  /** Outside the window, and `capo_task_assigned` is not approved for their locale. */
  | 'template_unapproved'
  /** Outside the window, and this person already had their one template today. */
  | 'already_claimed_today'
  /** Meta refused the send. */
  | 'send_failed'
  /** The company is no longer paying, so no proactive send may cost money on it. */
  | 'not_billable'
  /** Queued outside working hours. NOT decided: `notified_at` stays null. */
  | 'outside_hours';

interface NoticeRow {
  id: string;
  company_id: string;
  task_id: string;
  worker_id: string;
}

/**
 * Stamp a batch of notices.
 *
 * `decided: false` writes the diagnostic outcome and LEAVES `notified_at` null,
 * so a later drain picks the notice up again. That is the out-of-hours case and
 * the only one: everything else is a final answer, because a queue whose rows
 * are never consumed is a queue that grows for ever and re-messages people.
 *
 * Swallows its own failure. A lost stamp costs a repeated message tomorrow, a
 * thrown one costs the manager their action.
 */
async function stampNotices(
  db: Db,
  ids: string[],
  outcome: NoticeOutcome,
  { decided = true }: { decided?: boolean } = {},
): Promise<void> {
  if (ids.length === 0) return;
  const patch = decided ? { notified_at: new Date().toISOString(), outcome } : { outcome };
  const { error } = await db.from('task_assignment_notices').update(patch).in('id', ids);
  if (error) logEvent('task_assigned.stamp_failed', { outcome, notices: ids.length, error: error.message });
}

/** Group rows by a key, preserving insertion (i.e. queue) order. */
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) out.set(key(row), [...(out.get(key(row)) ?? []), row]);
  return out;
}

interface CompanyRef {
  id: string;
  name: string;
  language: string | null;
}

/**
 * Drain one company's queued notices. Never throws.
 *
 * Reads `task_board` for the queued tasks (the one definition of today) and the
 * company's whole day and crew through `loadCompanyBriefing` — which is also
 * where consent and reachability are decided, by `partitionCrew`, the single
 * gate every proactive send in the product passes through (0025, AGENTS.md).
 * A crew member missing from its `workers` list is missing for one of exactly
 * three reasons, all of which mean "do not message them".
 */
async function drainCompany(args: {
  db: Db;
  env: WhatsAppEnv;
  company: CompanyRef;
  notices: NoticeRow[];
  today: string;
  now: number;
}): Promise<void> {
  const { db, env, company, notices, today, now } = args;

  const taskIds = [...new Set(notices.map(n => n.task_id))];
  // select('*') rather than a column list, the standing rule: naming a column a
  // pending migration adds turns a deploy that lands first into a 42703. An
  // absent column reads as undefined, which every test below treats as "not
  // today" — the direction that sends nothing rather than the wrong thing.
  const { data: boardRows, error: boardError } = await db
    .from('task_board')
    .select('*')
    .eq('company_id', company.id)
    .in('id', taskIds);
  if (boardError) {
    logEvent('task_assigned.board_read_failed', { companyId: company.id, error: boardError.message });
    return;
  }

  // ── "does it start TODAY?" ────────────────────────────────────────────────
  // Two questions, both answered by the view and neither re-derived here.
  // `briefableToday` is the same allowlist the 07:00 briefing and the
  // late-afternoon check-in use. `window_start === today` is the extra one this
  // feature needs and the daily sends never ask: `active_today` is true on
  // EVERY day of a multi-day task, so without it a task that started last
  // Monday and merely got reassigned would announce itself as new work today
  // — which it is, to the new person, but the trigger already covers that case
  // by only queueing on a genuine change.
  const startingToday = new Set(
    briefableToday(boardRows ?? [])
      .filter(row => (row as { window_start?: unknown }).window_start === today)
      .map(row => row.id as string),
  );

  const stale = notices.filter(n => !startingToday.has(n.task_id));
  await stampNotices(db, stale.map(n => n.id), 'not_today');
  const live = notices.filter(n => startingToday.has(n.task_id));
  if (live.length === 0) return;

  let briefing;
  try {
    briefing = await loadCompanyBriefing(db, company.id, company.language);
  } catch (err) {
    logEvent('task_assigned.briefing_failed', { companyId: company.id, error: describeSendError(err) });
    return;
  }
  const messageable = new Map(briefing.workers.map(w => [w.workerId, w]));

  const byWorker = groupBy(live, n => n.worker_id);
  const workerIds = [...byWorker.keys()];

  // ── the coalescing guard ─────────────────────────────────────────────────
  // Who did we already message about an assignment in the last few minutes?
  // Read rather than remembered, because the five drains that produce this
  // situation are five separate requests with nothing in common but the
  // database.
  const cutoff = new Date(now - COALESCE_WINDOW_MS).toISOString();
  const { data: recent } = await db
    .from('task_assignment_notices')
    .select('worker_id')
    .eq('company_id', company.id)
    .eq('outcome', 'sent_free_form')
    .in('worker_id', workerIds)
    .gt('notified_at', cutoff);
  const recentlyMessaged = new Set((recent ?? []).map(r => r.worker_id));

  let handled = 0;
  for (const workerId of workerIds) {
    if (handled >= MAX_WORKERS_PER_COMPANY_PER_DRAIN) break;
    const batch = byWorker.get(workerId) ?? [];
    const ids = batch.map(n => n.id);

    const worker = messageable.get(workerId);
    if (!worker) {
      // No consent, no phone and no BSUID, or an inactive crew row. Decided,
      // not deferred: none of those change in the next fifteen minutes, and a
      // notice that retries for ever is a queue that grows for ever.
      await stampNotices(db, ids, 'not_messageable');
      continue;
    }

    if (recentlyMessaged.has(workerId)) {
      // LEFT QUEUED on purpose — the only branch besides out-of-hours that
      // does not stamp. The cron picks it up and folds it into one message.
      logEvent('task_assigned.deferred', { companyId: company.id, notices: ids.length });
      continue;
    }

    handled += 1;
    const newTaskIds = new Set(batch.map(n => n.task_id));
    const newTasks = worker.tasks.filter(task => newTaskIds.has(task.id));
    const config = sendConfigFor(env, worker.recipient);

    // The money question, and it fails CLOSED: withinFreeFormWindow returns
    // true only on POSITIVE PROOF of an inbound message in the last 23 hours.
    // A null, a future timestamp or an absent column all read as "outside".
    if (withinFreeFormWindow(worker.lastInboundAt, now)) {
      // The crew day page's link, on the same terms the 07:00 briefing gets it:
      // idempotent per day, and it never throws — a failed mint costs the line,
      // never the message.
      const links = await mintDayLinks(db, { companyId: company.id, workerIds: [workerId], today });
      const token = links.get(workerId);
      try {
        await sendWhatsAppText(
          renderAssignmentMessage(worker, newTaskIds, {
            dayLinkUrl: token ? dayLinkUrl(token) : undefined,
          }),
          config,
        );
        await stampNotices(db, ids, 'sent_free_form');
        logEvent('task_assigned.sent', {
          companyId: company.id,
          path: 'free_form',
          tasks: newTasks.length,
        });
      } catch (err) {
        // Decided rather than retried. A send Meta refused will be refused
        // again in fifteen minutes, and tomorrow's 07:00 briefing carries the
        // task anyway — retrying would spend the day writing the same log line.
        await stampNotices(db, ids, 'send_failed');
        logEvent('task_assigned.send_failed', {
          companyId: company.id,
          path: 'free_form',
          error: describeSendError(err),
        });
      }
      continue;
    }

    // ── the PAID branch ──────────────────────────────────────────────────────
    const templateLanguage = getCatalog(worker.locale).reminders.templateLanguage;
    if (!taskAssignedTemplateApproved(templateLanguage)) {
      await stampNotices(db, ids, 'template_unapproved');
      logEvent('task_assigned.template_unapproved', { companyId: company.id, templateLanguage });
      continue;
    }

    // THE LOCK, and the cost control. notification_log's unique key is
    // (kind, audience, worker_id, profile_id, notification_date), so this
    // claims one `task_assigned` template per crew member per day. A second
    // assignment the same afternoon therefore sends NOTHING by construction —
    // deliberate, not a bug: the first template already asked them to reply,
    // and a reply opens the free window every later assignment rides for free.
    const claimed = await claimNotification(db, {
      kind: TASK_ASSIGNED_KIND,
      company_id: company.id,
      audience: 'worker',
      worker_id: workerId,
      notification_date: today,
      task_ids: [...newTaskIds],
    });
    if (!claimed) {
      await stampNotices(db, ids, 'already_claimed_today');
      logEvent('task_assigned.already_claimed', { companyId: company.id });
      continue;
    }

    try {
      const { providerMessageId } = await sendWhatsAppTemplate(
        {
          name: 'capo_task_assigned',
          languageCode: templateLanguage,
          bodyParams: [
            worker.name,
            toTemplateParam(renderAssignmentTemplateParam(newTasks, worker.locale)),
          ],
        },
        config,
      );
      await resolveNotification(db, claimed.id, 'sent', { provider_message_id: providerMessageId });
      await stampNotices(db, ids, 'sent_template');
      logEvent('task_assigned.sent', { companyId: company.id, path: 'template', tasks: newTasks.length });
    } catch (err) {
      await resolveNotification(db, claimed.id, 'failed', { error: describeSendError(err) });
      await stampNotices(db, ids, 'send_failed');
      logEvent('task_assigned.send_failed', {
        companyId: company.id,
        path: 'template',
        error: describeSendError(err),
      });
    }
  }
}

/**
 * Drain the assignment queue: everything, or one company's share of it.
 *
 * Called from five places — the chat route, the WhatsApp manager turn, an
 * approved proposal, the two /tarefas actions — always inside `after()` and
 * always as one line, plus the fifteen-minute cron that is the safety net for
 * all of them. Opens its own SERVICE-ROLE client, exactly as `dispatchPushes`
 * does, so a call site never has to know that the queue is deny-all.
 *
 * NEVER THROWS.
 */
export async function drainAssignmentNotices(
  opts: { companyId?: string; limit?: number } = {},
): Promise<void> {
  try {
    const db = getDb();

    let query = db
      .from('task_assignment_notices')
      .select('id, company_id, task_id, worker_id')
      .is('notified_at', null)
      // Oldest first: after an outage the backlog drains in the order things
      // actually happened.
      .order('queued_at', { ascending: true })
      .limit(opts.limit ?? MAX_NOTICES_PER_DRAIN);
    if (opts.companyId) query = query.eq('company_id', opts.companyId);

    const { data: notices, error } = await query;
    if (error) {
      // Includes 42P01 on a deploy that landed ahead of 0048 — in which case
      // the trigger does not exist either, so there is nothing to drain.
      logEvent('task_assigned.read_failed', { error: error.message });
      return;
    }
    if (!notices || notices.length === 0) return;

    // ── the clock, and the quiet hours ───────────────────────────────────────
    // One clock, from the database, like every other date decision in the
    // product. Read AFTER the queue so an idle drain — which is almost every
    // drain — costs one indexed miss and nothing else.
    const clock = await readLisbonClock(db, 'task-assigned');
    if (!clock) {
      logEvent('task_assigned.clock_failed', {});
      return;
    }
    if (!withinAssignmentHours(clock.hour)) {
      // NOT decided: notified_at stays null so the next in-hours drain looks
      // again. By then the task will usually no longer start today, and it is
      // dropped as `not_today` — which is the right answer, because tomorrow's
      // 07:00 briefing carries it.
      await stampNotices(db, notices.map(n => n.id), 'outside_hours', { decided: false });
      logEvent('task_assigned.outside_hours', { lisbonHour: clock.hour, notices: notices.length });
      return;
    }

    const env = whatsappSendEnv();
    if (!env) {
      // An unconfigured deploy is "WhatsApp is off", never an error — every
      // preview deployment is in this state. Left queued, like out-of-hours.
      logEvent('task_assigned.not_configured', { notices: notices.length });
      return;
    }

    let companies;
    try {
      companies = await billableCompanies(db);
    } catch (err) {
      logEvent('task_assigned.company_read_failed', { error: describeSendError(err) });
      return;
    }
    const billable = new Map(companies.map(c => [c.id, c]));

    // ONE `now` for the whole drain, for the same reason /api/cron/welcome
    // freezes it: two people with identical inbound times must not be
    // classified differently by a clock that moved between them.
    const now = Date.now();

    for (const [companyId, rows] of groupBy(notices, n => n.company_id)) {
      const company = billable.get(companyId);
      if (!company) {
        // Not a paying tenant, so no proactive send may cost money on them.
        // Decided: their subscription will not come back inside this queue's
        // useful lifetime, and the task is still on their own board.
        await stampNotices(db, rows.map(r => r.id), 'not_billable');
        continue;
      }
      try {
        await drainCompany({ db, env, company, notices: rows, today: clock.today, now });
      } catch (err) {
        // A broken company must not stop the rest of the estate.
        logEvent('task_assigned.company_failed', { companyId, error: describeSendError(err) });
      }
    }
  } catch (err) {
    logEvent('task_assigned.drain_failed', { error: describeSendError(err) });
  }
}
