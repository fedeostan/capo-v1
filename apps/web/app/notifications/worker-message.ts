import type { Db } from '@capo/db/client';
import type { WorkerMessageResult, WorkerMessenger } from '@capo/core/capabilities/types';
import {
  isOutsideWindowError,
  sendWhatsAppTemplate,
  sendWhatsAppText,
  type WhatsAppSendConfig,
} from '@capo/core/channels/whatsapp';
import { getCatalog } from '@capo/i18n/catalog';
import { coerceLocale, type Locale } from '@capo/i18n/locale';
import { claimNotification, describeSendError, resolveNotification } from '@/lib/cron';
import { logEvent } from '@/lib/log';
import { sendConfigFor, type WhatsAppEnv } from '@/lib/whatsapp';
import {
  MESSAGE_WAITING_KIND,
  MESSAGE_WAITING_TEMPLATE,
  messageWaitingParams,
  renderCrewMessage,
  routeCrewMessage,
} from '@/lib/worker-message';

// Getting ONE crew member the manager's words (issue #123). This is the half of
// `message_worker` that talks to Meta; the tool itself is in @capo/core and
// knows none of it.
//
// ── THE LADDER, AND WHAT EACH RUNG ACTUALLY ACHIEVES ───────────────────────
//
//   1. INSIDE their own 24-hour window (they wrote to Capo in the last 23
//      hours) an ordinary free-form message goes out. Free, immediate, and it
//      carries the manager's words verbatim. This is the ONLY rung that
//      delivers, and it is the common one in the case this feature was built
//      for: a crew member who has just asked for something is by definition
//      inside their window.
//
//   2. OUTSIDE it, free-form is refused wholesale by Meta with 131047 and the
//      recipient receives NOTHING. The only legal contact is a pre-approved
//      template, and `capo_message_waiting` is a WINDOW REOPENER rather than an
//      envelope: its body was frozen at Meta's approval and says that somebody
//      has a message waiting, asking them to reply. THE MANAGER'S WORDS DO NOT
//      TRAVEL WITH IT. Their reply reopens the window, and the manager can then
//      say it for real, free.
//
//   3. If that template send fails, nothing has reached them and this returns
//      `not_delivered`. It does NOT hold the message for the morning briefing,
//      and that is a limit rather than a decision: holding it needs a durable
//      queue (a text column plus a delivered marker, keyed on the worker) and
//      no existing table in this schema can carry one. Writing one is a
//      migration, which this change deliberately does not make. Until it
//      exists, the honest answer is the one Capo gives: nothing was delivered,
//      here is why, and here is what you can do instead.
//
// ── WHAT IS AND IS NOT LOGGED ──────────────────────────────────────────────
//
// The FREE rung writes nothing to `notification_log`. That table is the PAID
// TEMPLATE ledger and its unique key is the only thing preventing a
// double-billed send; putting a free message in it would both pollute the cost
// ledger and consume a daily slot the crons need. Same reasoning, and the same
// conclusion, as `worker_requests.manager_notified_at` in worker-request-ping.ts
// next door.
//
// The PAID rung claims a row under its own `kind` BEFORE the Graph call, which
// is what makes the send idempotent and caps it at ONE NUDGE PER PERSON PER
// DAY. A failed nudge keeps the claim for the rest of today, exactly as both
// daily sends do: the trade-off is that a transient Meta failure costs that
// person their nudge until tomorrow rather than risking a second paid send.
//
// Unlike the crew request ping, this function does NOT swallow its failures
// into a log line and return quietly. It returns them, because the manager is
// sitting in a conversation waiting to be told what happened.

/**
 * Everything read off the `workers` row.
 *
 * `select('*')` rather than a column list, for the standing reason: naming a
 * column a pending migration adds turns a deploy that lands first into a 42703,
 * and here that would be every attempt to reach the crew. `last_inbound_at` is
 * read through `readLastInboundAt`'s validating index inside `routeCrewMessage`,
 * so an absent column reads as "no proof of a window" and takes the paid rung.
 */
interface CrewRow {
  id: string;
  name: string;
  language?: string | null;
}

/**
 * Build the messenger `message_worker` calls.
 *
 * ── WHICH CLIENT, AND WHY IT IS THE SERVICE ROLE ───────────────────────────
 * `db` here must be a SYSTEM client, not the manager's RLS-scoped one:
 * `notification_log` is deny-all for tenants by design (0016), so the paid
 * claim would be refused outright on the request path. That is the same posture
 * every other send in the product has.
 *
 * The tenant boundary is therefore NOT RLS on this path, it is `companyId`, and
 * `companyId` comes from `ToolContext.companyId` — resolved by the session on
 * the web and by the matched profile row on WhatsApp, never from anything the
 * model produced. Every read below is scoped by it. Same shape as
 * `handleCheckinTap`'s ownership read: the filter IS the boundary, so do not
 * widen it and do not add a caller that skips it.
 */
export function whatsappWorkerMessenger(dbFor: () => Db, env: WhatsAppEnv | null): WorkerMessenger | null {
  if (!env) return null;
  return async ({ companyId, workerId, text }) => {
    try {
      // Resolved LAZILY, inside the try. `getDb()` THROWS when the service-role
      // key is absent, and on the chat request path that would turn a missing
      // secret into a broken conversation rather than into one tool that
      // reports it cannot reach the crew. Building the messenger must stay free.
      return await deliverToCrewMember(dbFor(), env, companyId, workerId, text);
    } catch (err) {
      // A failure anywhere OUTSIDE the two send attempts (a database read, the
      // clock) lands here. Reported as a fact rather than rethrown: a thrown
      // tool error reads to the model as Capo being broken, and the honest
      // statement is narrower than that. Never reports a delivery.
      logEvent('crew_message.failed', {
        companyId,
        workerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { outcome: 'not_delivered', reason: 'send_failed' };
    }
  };
}

async function deliverToCrewMember(
  db: Db,
  env: WhatsAppEnv,
  companyId: string,
  workerId: string,
  text: string,
): Promise<WorkerMessageResult> {
  const { data: worker } = await db
    .from('workers')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', workerId)
    .maybeSingle();
  // Covers both "no such worker" and "another company's worker": the two are
  // deliberately indistinguishable from here, so this cannot become an
  // existence oracle for another tenant's crew.
  if (!worker) return { outcome: 'not_delivered', reason: 'worker_not_found' };

  const crew = worker as unknown as CrewRow;

  const { data: company } = await db
    .from('companies')
    .select('name, language')
    .eq('id', companyId)
    .maybeSingle();

  // The THIRD dial (AGENTS.md): what this person reads is their own
  // `workers.language`, and its null means "inherit the company language". The
  // manager's dial is deliberately not consulted anywhere here.
  const locale = coerceLocale(crew.language ?? company?.language ?? null);
  // Falls back to Capo's own name only if `companies.name` is somehow empty, so
  // the crew member is never handed an unattributed instruction.
  const companyName = company?.name?.trim() || 'Capo';

  const route = routeCrewMessage(worker, Date.now());
  if (route.rung === 'blocked') {
    logEvent('crew_message.blocked', { companyId, workerId, reason: route.reason });
    return { outcome: 'not_delivered', reason: route.reason, workerName: crew.name };
  }

  const config = sendConfigFor(env, route.recipient);

  // ── rung 1: free-form, inside their own window ───────────────────────────
  if (route.rung === 'free_form') {
    try {
      await sendWhatsAppText(renderCrewMessage({ company: companyName, text }, locale), config);
      logEvent('crew_message.sent', { companyId, workerId, path: 'free_form' });
      return { outcome: 'sent', workerName: crew.name };
    } catch (err) {
      // 131047 means our proof of an open window was stale — the stamp lags its
      // message, and a send decided at the top of a turn goes out seconds
      // later. This is the ONE send failure that is recoverable, and the
      // recovery is precisely the next rung. Every other failure is a real
      // breakage and retrying it as a paid template would spend money to fail
      // again identically.
      if (!isOutsideWindowError(err)) {
        logEvent('crew_message.failed', {
          companyId,
          workerId,
          path: 'free_form',
          error: describeSendError(err),
        });
        return { outcome: 'not_delivered', reason: 'send_failed', workerName: crew.name };
      }
      logEvent('crew_message.window_closed', { companyId, workerId });
    }
  }

  // ── rung 2: the paid window reopener ─────────────────────────────────────
  return await nudge(db, { companyId, crew, companyName, locale, config });
}

async function nudge(
  db: Db,
  args: {
    companyId: string;
    crew: CrewRow;
    companyName: string;
    locale: Locale;
    config: WhatsAppSendConfig;
  },
): Promise<WorkerMessageResult> {
  const { companyId, crew, companyName, locale, config } = args;

  // ONE CLOCK. `notification_date` is the key half that makes the claim a daily
  // lock, so it comes from `lisbon_today()` like every other send in the
  // product and never from this runtime. An unreadable clock refuses the send
  // rather than guessing a date, because a guessed date on the wrong side of
  // midnight is a second paid message to the same person.
  const { data: today } = await db.rpc('lisbon_today');
  if (typeof today !== 'string' || !today) {
    logEvent('crew_message.failed', { companyId, workerId: crew.id, stage: 'clock' });
    return { outcome: 'not_delivered', reason: 'send_failed', workerName: crew.name };
  }

  // THE LOCK, claimed before the Graph call. A second attempt today, from a
  // retry or from a manager asking twice, answers 23505 and claims nothing.
  const claimed = await claimNotification(db, {
    kind: MESSAGE_WAITING_KIND,
    company_id: companyId,
    audience: 'worker',
    worker_id: crew.id,
    notification_date: today,
    task_ids: [],
  });
  if (!claimed) {
    logEvent('crew_message.already_nudged', { companyId, workerId: crew.id });
    return { outcome: 'not_delivered', reason: 'already_nudged_today', workerName: crew.name };
  }

  try {
    const { providerMessageId } = await sendWhatsAppTemplate(
      {
        name: MESSAGE_WAITING_TEMPLATE,
        languageCode: getCatalog(locale).reminders.templateLanguage,
        bodyParams: messageWaitingParams({ workerName: crew.name, company: companyName }),
      },
      config,
    );
    await resolveNotification(db, claimed.id, 'sent', { provider_message_id: providerMessageId });
    logEvent('crew_message.sent', { companyId, workerId: crew.id, path: 'template' });
    // NOT 'sent'. The nudge went out; the manager's words did not. Rounding
    // this up to a delivery is the whole failure this feature exists to end.
    return { outcome: 'nudged', workerName: crew.name };
  } catch (err) {
    // The likely code here is 132001: `capo_message_waiting` has never been
    // wired to a send path before this change and its approval in all three
    // locales has not been confirmed. A missing locale fails the send whole,
    // and Meta approves each name-and-language pair separately without telling
    // anybody. `pnpm whatsapp-template status` is the way to check.
    await resolveNotification(db, claimed.id, 'failed', { error: describeSendError(err) });
    logEvent('crew_message.failed', {
      companyId,
      workerId: crew.id,
      path: 'template',
      error: describeSendError(err),
    });
    return { outcome: 'not_delivered', reason: 'template_failed', workerName: crew.name };
  }
}
