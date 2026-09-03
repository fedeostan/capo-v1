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
import {
  claimThenSend,
  decideDelivery,
  ENGAGED_OUTCOMES,
  noticeIsStale,
  type NoticeOutcome,
} from '@/lib/task-assigned-plan';
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
// ── THE QUEUE ROW IS THE LOCK ──────────────────────────────────────────────
// The free-form path writes nothing to `notification_log` (that table is the
// PAID ledger and nothing free belongs in it), so its only protection against
// two overlapping drains is the queue row itself. Rows are CLAIMED before the
// Graph call — one atomic `update … where notified_at is null returning id` —
// and only what came back is sent about. See claimThenSend in
// lib/task-assigned-plan.ts for the race this closes and why the coalescing
// window reads `sending` as "already messaged".
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
 * How recently this person must have been engaged before a new notice is
 * DEFERRED rather than sent.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * A manager assigning five tasks to Miguel one at a time on /tarefas fires five
 * drains inside a minute, and each message carries Miguel's WHOLE day — so he
 * would read five nearly identical messages, four of them noise. Deferring is
 * what turns that into one: the later notices stay queued, and the next
 * fifteen-minute cron sends ONE message with all of them marked.
 *
 * It works on sub-second gaps only because the claim stamps `outcome:
 * 'sending'` BEFORE the Graph call and ENGAGED_OUTCOMES counts that as
 * "already messaged". Reading only the finished outcomes — which the first
 * version did — left the guard blind in exactly the fast case it exists for.
 *
 * The deferral is not a silence. A deferred notice is still queued, still
 * inside its own Lisbon day, and the cron is the safety net the whole design
 * already leans on. The first assignment is still announced within seconds,
 * which is the promise the feature makes.
 */
const COALESCE_WINDOW_MS = 5 * 60_000;

interface NoticeRow {
  id: string;
  company_id: string;
  task_id: string;
  worker_id: string;
  queued_date: string | null;
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
  ids: readonly string[],
  outcome: NoticeOutcome,
  { decided = true }: { decided?: boolean } = {},
): Promise<void> {
  if (ids.length === 0) return;
  const patch = decided ? { notified_at: new Date().toISOString(), outcome } : { outcome };
  const { error } = await db.from('task_assignment_notices').update(patch).in('id', ids);
  if (error) logEvent('task_assigned.stamp_failed', { outcome, notices: ids.length, error: error.message });
}

/**
 * THE LOCK. Take these notices, or discover that another drain already has.
 *
 * `.is('notified_at', null)` inside the UPDATE is what makes this atomic:
 * Postgres applies the predicate at write time, so of two drains racing over
 * the same row exactly one matches it. `.select('id')` is not decoration — a
 * zero-row update is a fully successful statement in Postgres, so asking for
 * the rows back is the only way to learn which ones were actually taken. Same
 * device the Stripe webhook uses for its own zero-row case.
 *
 * Returns [] on ANY failure, which means "send nothing". A drain that cannot
 * prove it holds the row must not message anybody.
 */
async function claimNotices(db: Db, ids: readonly string[]): Promise<string[]> {
  const { data, error } = await db
    .from('task_assignment_notices')
    .update({ notified_at: new Date().toISOString(), outcome: 'sending' })
    .in('id', ids as string[])
    .is('notified_at', null)
    .select('id');
  if (error) {
    logEvent('task_assigned.claim_failed', { notices: ids.length, error: error.message });
    return [];
  }
  return (data ?? []).map(row => row.id);
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
  // Monday would announce itself as new work today.
  const startingToday = new Set(
    briefableToday(boardRows ?? [])
      .filter(row => (row as { window_start?: unknown }).window_start === today)
      .map(row => row.id as string),
  );

  const stale = notices.filter(n => !startingToday.has(n.task_id));
  if (stale.length > 0) {
    await stampNotices(db, stale.map(n => n.id), 'not_today');
    logEvent('task_assigned.not_today', { companyId: company.id, notices: stale.length });
  }
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
  // Who has a drain already committed to messaging in the last few minutes?
  // Read rather than remembered, because the drains that produce this situation
  // are separate requests with nothing in common but the database. `sending`
  // counts — see ENGAGED_OUTCOMES.
  const cutoff = new Date(now - COALESCE_WINDOW_MS).toISOString();
  const { data: recent } = await db
    .from('task_assignment_notices')
    .select('worker_id, outcome')
    .eq('company_id', company.id)
    .in('worker_id', workerIds)
    .in('outcome', [...ENGAGED_OUTCOMES])
    .gt('notified_at', cutoff);
  const recentlyEngaged = new Set((recent ?? []).map(r => r.worker_id));

  let handled = 0;
  for (const workerId of workerIds) {
    if (handled >= MAX_WORKERS_PER_COMPANY_PER_DRAIN) break;
    const batch = byWorker.get(workerId) ?? [];
    const ids = batch.map(n => n.id);

    try {
      const worker = messageable.get(workerId);
      const newTaskIds = new Set(batch.map(n => n.task_id));
      // The tasks that are still THIS person's, on the live board, right now.
      // A task reassigned away between the queue and the drain is gone from
      // here — which is the whole reason decideDelivery counts them.
      const newTasks = (worker?.tasks ?? []).filter(task => newTaskIds.has(task.id));

      const decision = decideDelivery({
        messageable: Boolean(worker),
        newTaskCount: newTasks.length,
        recentlyEngaged: recentlyEngaged.has(workerId),
      });

      if (decision.kind === 'defer') {
        // LEFT QUEUED on purpose — one of only two branches that does not
        // stamp. The cron picks it up and folds it into one message.
        logEvent('task_assigned.deferred', { companyId: company.id, notices: ids.length });
        continue;
      }
      if (decision.kind === 'skip') {
        await stampNotices(db, ids, decision.outcome);
        logEvent(`task_assigned.${decision.outcome}`, { companyId: company.id, notices: ids.length });
        continue;
      }

      handled += 1;
      // `worker` is non-null here: decideDelivery answers 'skip' otherwise.
      const target = worker!;
      const config = sendConfigFor(env, target.recipient);

      // The money question, and it fails CLOSED: withinFreeFormWindow returns
      // true only on POSITIVE PROOF of an inbound message in the last 23 hours.
      // A null, a future timestamp or an absent column all read as "outside".
      if (withinFreeFormWindow(target.lastInboundAt, now)) {
        const { sent, won } = await claimThenSend({
          ids,
          claim: claimed => claimNotices(db, claimed),
          send: async wonIds => {
            // Only the tasks this drain actually WON are marked, so two drains
            // that split a batch never both claim the same task is new.
            const wonTaskIds = new Set(
              batch.filter(n => wonIds.includes(n.id)).map(n => n.task_id),
            );
            // The crew day page's link, on the same terms the 07:00 briefing
            // gets it: idempotent per day, and it never throws — a failed mint
            // costs the line, never the message.
            const links = await mintDayLinks(db, {
              companyId: company.id,
              workerIds: [workerId],
              today,
            });
            const token = links.get(workerId);
            await sendWhatsAppText(
              renderAssignmentMessage(target, wonTaskIds, {
                dayLinkUrl: token ? dayLinkUrl(token) : undefined,
              }),
              config,
            );
          },
        });
        if (!sent) {
          // Another drain holds these rows and is messaging this person right
          // now. Nothing to stamp — they own the rows.
          logEvent('task_assigned.claim_lost', { companyId: company.id, notices: ids.length });
          continue;
        }
        await stampNotices(db, won, 'sent_free_form');
        logEvent('task_assigned.sent', { companyId: company.id, path: 'free_form', tasks: won.length });
        continue;
      }

      // ── the PAID branch ────────────────────────────────────────────────────
      const templateLanguage = getCatalog(target.locale).reminders.templateLanguage;
      if (!taskAssignedTemplateApproved(templateLanguage)) {
        await stampNotices(db, ids, 'template_unapproved');
        logEvent('task_assigned.template_unapproved', { companyId: company.id, templateLanguage });
        continue;
      }

      // Claimed FIRST, exactly as the free branch is, so two drains cannot both
      // reach the notification_log claim and have one of them burn this
      // person's single daily template on a duplicate.
      const claimResult = await claimThenSend({
        ids,
        claim: claimed => claimNotices(db, claimed),
        send: async wonIds => {
          const wonTasks = newTasks.filter(task =>
            batch.some(n => wonIds.includes(n.id) && n.task_id === task.id),
          );
          // THE COST CONTROL. notification_log's unique key is
          // (kind, audience, worker_id, profile_id, notification_date), so this
          // claims one `task_assigned` template per crew member per day. A
          // second assignment the same afternoon therefore sends NOTHING by
          // construction — deliberate: the first template already asked them to
          // reply, and a reply opens the free window every later assignment
          // rides for free.
          const claimed = await claimNotification(db, {
            kind: TASK_ASSIGNED_KIND,
            company_id: company.id,
            audience: 'worker',
            worker_id: workerId,
            notification_date: today,
            task_ids: wonTasks.map(t => t.id),
          });
          if (!claimed) return 'already_claimed_today' as const;

          try {
            const { providerMessageId } = await sendWhatsAppTemplate(
              {
                name: 'capo_task_assigned',
                languageCode: templateLanguage,
                bodyParams: [
                  target.name,
                  toTemplateParam(renderAssignmentTemplateParam(wonTasks, target.locale)),
                ],
              },
              config,
            );
            await resolveNotification(db, claimed.id, 'sent', {
              provider_message_id: providerMessageId,
            });
            return 'sent_template' as const;
          } catch (err) {
            await resolveNotification(db, claimed.id, 'failed', { error: describeSendError(err) });
            logEvent('task_assigned.send_failed', {
              companyId: company.id,
              path: 'template',
              error: describeSendError(err),
            });
            return 'send_failed' as const;
          }
        },
      });
      if (!claimResult.sent) {
        logEvent('task_assigned.claim_lost', { companyId: company.id, notices: ids.length });
        continue;
      }
      await stampNotices(db, claimResult.won, claimResult.result!);
      if (claimResult.result === 'sent_template') {
        logEvent('task_assigned.sent', { companyId: company.id, path: 'template', tasks: claimResult.won.length });
      } else {
        logEvent(`task_assigned.${claimResult.result}`, { companyId: company.id });
      }
    } catch (err) {
      // ONE crew member's failure must never cost the rest of this company
      // theirs. The rows stay claimed (`sending`) rather than being released:
      // a person who might already have been messaged must not be messaged
      // again by the next tick, and the outcome on the row says what happened.
      logEvent('task_assigned.worker_failed', {
        companyId: company.id,
        error: describeSendError(err),
      });
    }
  }
}

/**
 * Drain the assignment queue: everything, or one company's share of it.
 *
 * Called from six places — the chat route, the WhatsApp manager turn, both card
 * approvals (web and WhatsApp), and the two /tarefas actions — always inside
 * `after()` and always as one line, plus the fifteen-minute cron that is the
 * safety net for all of them. Opens its own SERVICE-ROLE client, exactly as
 * `dispatchPushes` does, so a call site never has to know that the queue is
 * deny-all.
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
      // `queued_date` is read because a notice that survived the night must
      // never be sent — see noticeIsStale.
      .select('id, company_id, task_id, worker_id, queued_date')
      .is('notified_at', null)
      // Oldest first: after an outage the backlog drains in the order things
      // actually happened. Consequence, bounded and self-healing: one company
      // queueing more than MAX_NOTICES_PER_DRAIN in a tick delays everybody
      // else's by fifteen minutes.
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

    // ── yesterday's leftovers, before anything else ──────────────────────────
    // A notice queued last night survived because the out-of-hours branch
    // deliberately does not consume rows. It must not be SENT today: the 07:00
    // briefing has already carried the task, and "your boss just gave you a new
    // task" an hour later is both untrue and a duplicate. Stamped as a final
    // answer so it leaves the queue.
    const stale = notices.filter(n => noticeIsStale(n.queued_date, clock.today));
    if (stale.length > 0) {
      await stampNotices(db, stale.map(n => n.id), 'stale');
      logEvent('task_assigned.stale', { notices: stale.length, today: clock.today });
    }
    const fresh = notices.filter(n => !noticeIsStale(n.queued_date, clock.today));
    if (fresh.length === 0) return;

    if (!withinAssignmentHours(clock.hour)) {
      // NOT decided: notified_at stays null so the next in-hours drain looks
      // again. If that drain is on the following day, the stale test above
      // consumes the row and sends nothing.
      await stampNotices(db, fresh.map(n => n.id), 'outside_hours', { decided: false });
      logEvent('task_assigned.outside_hours', { lisbonHour: clock.hour, notices: fresh.length });
      return;
    }

    const env = whatsappSendEnv();
    if (!env) {
      // An unconfigured deploy is "WhatsApp is off", never an error — every
      // preview deployment is in this state. Left queued, like out-of-hours.
      logEvent('task_assigned.not_configured', { notices: fresh.length });
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

    for (const [companyId, rows] of groupBy(fresh, n => n.company_id)) {
      const company = billable.get(companyId);
      if (!company) {
        // Not a paying tenant, so no proactive send may cost money on them.
        // Decided: their subscription will not come back inside this queue's
        // useful lifetime, and the task is still on their own board.
        await stampNotices(db, rows.map(r => r.id), 'not_billable');
        logEvent('task_assigned.not_billable', { companyId, notices: rows.length });
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
