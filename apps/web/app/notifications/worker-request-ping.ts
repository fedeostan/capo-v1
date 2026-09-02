import type { Db } from '@capo/db/client';
import { sendWhatsAppText, withinFreeFormWindow } from '@capo/core/channels/whatsapp';
import { coerceLocale } from '@capo/i18n/locale';
import { hasWhatsAppConsent, recipientFor, sendConfigFor, type WhatsAppEnv } from '@/lib/whatsapp';
import { renderRequestEvent, renderRequestMessage } from '@/lib/worker-request';
import { logEvent } from '@/lib/log';
import { readLastInboundAt } from './briefing';
import { readThreadLocale, recordThreadEvent } from './thread';

// Telling the MANAGER that their crew asked for something (issue #152).
//
// ── THE WHATSAPP HALF IS BUILT FOR THE FREE CASE ONLY, DELIBERATELY ─────────
// Reaching a manager on WhatsApp has two cases and only one of them is legal
// without a new Meta approval:
//
//   INSIDE their own 24-hour window (they wrote to Capo recently) — ordinary
//   free-form text. Immediate, and FREE.
//
//   OUTSIDE it — free-form is refused outright with 131047 and the recipient
//   gets NOTHING. The only legal contact is a pre-approved template, and there
//   is no template for this. `capo_message_waiting` in
//   scripts/whatsapp-templates.ts is NOT it: it was submitted for issue #123
//   Part B, it is aimed at a WORKER, and the code half it belongs to (the
//   held-message flush) does not exist. Submitting a new template means a
//   manual approval in WhatsApp Manager in three locales, and a body frozen at
//   approval time — #49's lesson.
//
// So OUTSIDE the window this sends NOTHING over WhatsApp, and that is a
// decision rather than a gap. The manager still gets the request immediately
// and for free, through the in-app inbox (0024, written by 0043's trigger) and
// Web Push (0026, which rides that row with no producer of its own) — which is
// exactly why those two carry the weight here and the WhatsApp line is a bonus
// for somebody already mid-conversation.
//
// ── THE ROW IS THE QUEUE ───────────────────────────────────────────────────
// `worker_requests.manager_notified_at` marks that the fan-out below has been
// ATTEMPTED — sent, or skipped for want of a window or consent. Same shape as
// notifications.pushed_at (0026): no outbound ledger, no separate producer, and
// idempotent by construction, so a manager outside their window is never pinged
// about the same request again when the next crew message happens to arrive.
// notification_log is deliberately NOT used: that table is the PAID TEMPLATE
// ledger and its unique key is what prevents a double-billed send. Nothing free
// belongs in it.
//
// ── FAILURE POSTURE ────────────────────────────────────────────────────────
// Nothing here throws, and the whole call site is `.catch()`-ed as well. A
// failure to TELL the manager over one channel must never cost the crew member
// their request being recorded — the row and the inbox entry already exist by
// the time this runs. Every failure is swallowed into a greppable log line, so
// the cost is that a broken grant presents as a channel that quietly stops
// pinging. Grep `request.ping_failed` before concluding a quiet WhatsApp means
// a quiet crew.

/** Most requests per sweep. A crew member filing more than this in one turn is
 *  a data problem, not a busy morning, and an unbounded fan-out on the webhook
 *  path is how one tenant's bad input becomes everybody's timeout. */
const MAX_PER_SWEEP = 5;

/**
 * Tell every reachable manager of this company about the requests that have not
 * been announced yet, then stamp them.
 *
 * Runs on the SERVICE ROLE — the WhatsApp webhook has no session, so RLS
 * enforces nothing and every filter below is doing work RLS does elsewhere.
 */
export async function pingManagersAboutRequests(db: Db, companyId: string, env: WhatsAppEnv): Promise<void> {
  try {
    const { data: pending, error } = await db
      .from('worker_requests')
      .select('id, worker_id, task_id, text, needed_by')
      .eq('company_id', companyId)
      .is('manager_notified_at', null)
      .order('created_at', { ascending: true })
      .limit(MAX_PER_SWEEP);
    // Includes 42P01 on a deploy that landed ahead of 0043 — in which case the
    // tool could not have written a row either, so there is nothing to announce.
    if (error || !pending || pending.length === 0) {
      if (error) logEvent('request.ping_failed', { companyId, stage: 'read', error: error.message });
      return;
    }

    // One clock. The urgency words ("para amanhã") have to mean the same thing
    // here as on the board, so the Lisbon day comes from the database and never
    // from this runtime.
    const { data: today } = await db.rpc('lisbon_today');
    const lisbonToday = typeof today === 'string' ? today : null;

    // Names and titles: COMPANY-OWNED text, both of them. workers.name was
    // typed by the manager on /perfil and tasks.title is the company's own
    // wording — the only strings here that are safe to put in a thread note.
    const workerIds = [...new Set(pending.map(r => r.worker_id))];
    const { data: workers } = await db.from('workers').select('id, name').eq('company_id', companyId).in('id', workerIds);
    const nameById = new Map((workers ?? []).map(w => [w.id, w.name]));

    const taskIds = [...new Set(pending.map(r => r.task_id).filter((id): id is string => Boolean(id)))];
    const titleById = new Map<string, string>();
    if (taskIds.length > 0) {
      const { data: tasks } = await db.from('tasks').select('id, title').eq('company_id', companyId).in('id', taskIds);
      for (const t of tasks ?? []) titleById.set(t.id, t.title);
    }

    // select('*') rather than a column list, for the standing reason: naming a
    // column a pending migration adds turns a deploy that lands first into a
    // 42703 on every manager. readLastInboundAt reads through an index and
    // validates, so an absent column reads as "no proof of a window" and this
    // sends nothing — the safe direction.
    const { data: managers } = await db.from('profiles').select('*').eq('company_id', companyId);
    const eventLocale = await readThreadLocale(db, companyId, coerceLocale(null));

    for (const request of pending) {
      const workerName = nameById.get(request.worker_id) ?? '';
      const taskTitle = request.task_id ? (titleById.get(request.task_id) ?? null) : null;
      let sent = 0;
      let skipped = 0;

      for (const manager of managers ?? []) {
        // TWO gates, both fail-closed, and neither is optional.
        //
        // hasWhatsAppConsent is the same predicate the daily briefing applies
        // (0025): a manager who never opted in, or who replied STOP, is not
        // messaged, full stop. It fails closed on a missing or unparseable
        // opt-in.
        //
        // withinFreeFormWindow is the money gate. It returns true only on
        // POSITIVE PROOF of an inbound message in the last 23 hours; a null, a
        // future timestamp or an absent column all read as "outside", and
        // outside means we send nothing at all. Guessing "inside" earns a
        // 131047 and the manager receives nothing anyway.
        const recipient = recipientFor(manager);
        if (
          !recipient ||
          !hasWhatsAppConsent(manager) ||
          !withinFreeFormWindow(readLastInboundAt(manager), Date.now())
        ) {
          skipped += 1;
          continue;
        }
        try {
          await sendWhatsAppText(
            renderRequestMessage(
              {
                workerName,
                // The crew member's own words, QUOTED and attributed by the
                // renderer. This envelope is a message to a person's phone, not
                // a row in `messages`, so worker prose is legitimate here — see
                // the thread note below, which deliberately cannot carry it.
                text: request.text,
                neededBy: request.needed_by,
                taskTitle,
              },
              lisbonToday,
              coerceLocale(manager.language),
            ),
            sendConfigFor(env, recipient),
          );
          sent += 1;
        } catch (err) {
          // One manager's failed send must not stop the others, and must not
          // stop the stamp below — a retry would re-ping everyone who DID get
          // it. The inbox row already carries the request either way.
          logEvent('request.ping_failed', {
            companyId,
            requestId: request.id,
            stage: 'send',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ── the manager's thread (issue #47) ───────────────────────────────────
      // Written whether or not the WhatsApp line went out, because it records
      // something the manager RECEIVED from the system — the inbox entry and
      // the push, which are unconditional. Without it, the manager can be
      // holding a request Capo has never heard of, and "did anyone ask for
      // anything today?" gets answered from a board read.
      //
      // ⚠ THREE INPUTS, AND THERE IS DELIBERATELY NO FOURTH. A name the MANAGER
      // typed, a date, and a task title. `request.text` is NOT passed and must
      // never be: `messages` is the table thread.recentUserTexts reads, and
      // those last three user rows are the evidence pool runGuarded matches a
      // model's quote against before executing a manager-level write directly
      // (0027, AGENTS.md). A crew member whose words landed there would be
      // authoring that evidence. renderRequestEvent's signature is what makes
      // the mistake impossible rather than merely discouraged.
      await recordThreadEvent(db, {
        companyId,
        source: 'worker_request',
        text: renderRequestEvent({ workerName, neededBy: request.needed_by, taskTitle }, lisbonToday, eventLocale),
      });

      logEvent('request.pinged', { companyId, requestId: request.id, sent, skipped });
    }

    // Stamped AFTER the attempt, one statement for the whole sweep. Dying
    // before this re-announces on the next crew turn — noisy, visible, and
    // recoverable. Stamping first would lose the announcement silently, which
    // is the failure this feature exists to end.
    const { error: stampError } = await db
      .from('worker_requests')
      .update({ manager_notified_at: new Date().toISOString() })
      .in(
        'id',
        pending.map(r => r.id),
      );
    if (stampError) {
      logEvent('request.ping_failed', { companyId, stage: 'stamp', error: stampError.message });
    }
  } catch (err) {
    logEvent('request.ping_failed', {
      companyId,
      stage: 'sweep',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
