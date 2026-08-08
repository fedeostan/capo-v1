import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@capo/db/client';
import { checkinPayload, sendWhatsAppTemplate } from '@capo/core/channels/whatsapp';
import { getCatalog } from '@capo/i18n/catalog';
import { sendConfigFor, toSendTarget, whatsappSendEnv } from '../../../../lib/whatsapp';
import { logEvent } from '../../../../lib/log';
import {
  authorizeCron,
  billableCompanies,
  claimNotification,
  describeSendError,
  readLisbonClock,
  resolveNotification,
} from '../../../../lib/cron';
import { loadCompanyBriefing, renderWorkerBriefing } from '../../../notifications/briefing';

// The 16:30 Europe/Lisbon check-in: "did you finish today's tasks?", asked as a
// template with two quick-reply buttons and answered by tapping one.
//
// DETERMINISTIC END TO END, in both directions. The message is rendered by
// renderWorkerBriefing — the same function the 07:00 briefing uses, so the two
// can never drift about what "your tasks today" means — and the answer comes
// back as one of two payload strings this route minted itself. No model is
// called on this path, which is what makes the "Ainda não" branch free.
//
// It records an ANSWER and nothing else. It does not flip tasks.status; see the
// header of supabase/migrations/0017_worker_checkins.sql.
//
// Nothing here reads dispatch_tasks_today or writes dispatch_log — that
// contract stays frozen so SMS can be switched back on (AGENTS.md).
//
// SYSTEM path: no user session, service-role client, acts across tenants. Its
// structural gate is the CRON_SECRET bearer, which Vercel injects on scheduled
// invocations.

export const dynamic = 'force-dynamic';

// One Graph API round-trip per worker across every company, in one invocation.
// Matches the reminder cron and the WhatsApp webhook.
export const maxDuration = 300;

/**
 * 16:30 in Lisbon. Vercel schedules in UTC and Lisbon is UTC+0 in winter and
 * UTC+1 in summer, so apps/web/vercel.json registers TWO entries — 15:30 and
 * 16:30 UTC — and this gate lets exactly one of them through, year round. The
 * hour is all that is compared because both entries fire at :30, which is the
 * same mechanism the 07:00 job uses.
 */
const SEND_HOUR = 16;

/**
 * The Meta template. Must already be approved for every locale in @capo/i18n —
 * `pnpm whatsapp-template status` is the check. Two body parameters ({{1}} the
 * worker's name, {{2}} the task list) and TWO quick-reply buttons.
 *
 * BUTTON ORDER IS A CONTRACT: index 0 is "done", index 1 is "not_done", matching
 * scripts/whatsapp-templates.ts and the catalog's checkinDoneButton /
 * checkinNotDoneButton. Swapping them inverts every answer, and the Graph API
 * answers the send with a 200. See docs/whatsapp-cloud-api-runbook.md §6b.
 */
const TEMPLATE_NAME = 'capo_task_checkin';

/**
 * Separate from the briefing's 'daily_briefing' — and that separation is the
 * only reason both can be sent on the same day. notification_log is unique on
 * (kind, audience, worker_id, profile_id, notification_date), so collapsing the
 * two kinds gives a 16:30 run that claims nothing, skips everyone, and reports
 * success with no error anywhere.
 */
const KIND = 'task_checkin';

export async function GET(request: NextRequest) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  // dry_run renders everything and sends nothing, writes nothing. It also
  // bypasses the hour gate, so the output can be inspected at any time of day.
  const dryRun = request.nextUrl.searchParams.get('dry_run') === '1';

  const db = getDb();

  const clock = await readLisbonClock(db, 'cron/checkin');
  if (!clock) return new NextResponse('clock unavailable', { status: 500 });
  const { hour, today } = clock;
  if (!dryRun && hour !== SEND_HOUR) {
    return NextResponse.json({ skipped: 'outside the send hour', lisbonHour: hour });
  }

  const env = whatsappSendEnv();
  if (!env && !dryRun) return new NextResponse('whatsapp not configured', { status: 503 });

  let companies;
  try {
    companies = await billableCompanies(db);
  } catch (err) {
    console.error('cron/checkin:', describeSendError(err));
    return new NextResponse('company read failed', { status: 500 });
  }

  const report: unknown[] = [];

  for (const company of companies) {
    try {
      const briefing = await loadCompanyBriefing(db, company.id, company.language);
      const sends: unknown[] = [];
      let asked = 0;

      for (const worker of briefing.workers) {
        // Note there is deliberately no NOTIFY_IDLE_WORKERS dial here, unlike
        // the 07:00 briefing. Asking "did you finish today's tasks?" of someone
        // who had none is not a product decision with two defensible answers;
        // it is a bug. No claim is written either, so an idle worker leaves no
        // 'skipped' row — there was nothing to skip.
        if (worker.tasks.length === 0) continue;

        const [name, taskList] = renderWorkerBriefing(worker);
        const taskIds = worker.tasks.map(t => t.id);

        if (dryRun) {
          sends.push({
            audience: 'worker',
            to: toSendTarget(worker.phone),
            locale: worker.locale,
            name,
            taskList,
            taskIds,
          });
          continue;
        }

        const claimed = await claimNotification(db, {
          kind: KIND,
          company_id: company.id,
          audience: 'worker',
          worker_id: worker.workerId,
          notification_date: today,
          task_ids: taskIds,
        });
        if (!claimed) continue;

        try {
          const { providerMessageId } = await sendWhatsAppTemplate(
            {
              name: TEMPLATE_NAME,
              languageCode: getCatalog(worker.locale).reminders.templateLanguage,
              bodyParams: [name, taskList],
              // The CLAIM id travels in the payload — not the worker id and not
              // the date. That is what lets a tap arriving hours later still be
              // recorded against the day it was asked about, and it gives the
              // webhook exactly one row to check ownership against.
              quickReplies: [
                { payload: checkinPayload('done', claimed.id) },
                { payload: checkinPayload('not_done', claimed.id) },
              ],
            },
            sendConfigFor(env!, toSendTarget(worker.phone)),
          );
          await resolveNotification(db, claimed.id, 'sent', { provider_message_id: providerMessageId });
          asked += 1;
        } catch (err) {
          // One unreachable worker must never abort the run — on the test tier
          // a 131030 for a not-yet-allow-listed number is the expected case,
          // and a 132001 is the expected case until the template is approved.
          await resolveNotification(db, claimed.id, 'failed', { error: describeSendError(err) });
          logEvent('checkin.worker_send_failed', {
            companyId: company.id,
            workerId: worker.workerId,
            error: describeSendError(err),
          });
        }
      }

      // No manager audience and no chat-thread note, both deliberately. The
      // manager's surface for this is worker_checkins; a per-company thread
      // message at 16:30, before anyone has answered, would say nothing.
      report.push({ company: company.name, asked, sends });
    } catch (err) {
      // One broken company must not cost every other company its check-in.
      console.error(`cron/checkin: company ${company.id} failed:`, err);
      logEvent('checkin.company_failed', { companyId: company.id, error: describeSendError(err) });
      report.push({ company: company.name, error: describeSendError(err) });
    }
  }

  return NextResponse.json({ dryRun, date: today, lisbonHour: hour, companies: report });
}
