import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@capo/db/client';
import { checkinPayload, sendWhatsAppTemplate } from '@capo/core/channels/whatsapp';
import { getCatalog } from '@capo/i18n/catalog';
import { describeRecipient, sendConfigFor, whatsappSendEnv } from '../../../../lib/whatsapp';
import { logEvent } from '../../../../lib/log';
import {
  authorizeCron,
  billableCompanies,
  claimNotification,
  describeSendError,
  readLisbonClock,
  resolveNotification,
  sendWindowEnd,
  withinSendWindow,
} from '../../../../lib/cron';
import { readCompanySchedules, scheduleFor } from '../../../../lib/schedule';
import { recordCronRun } from '../../../notifications/cron-runs';
import {
  loadCompanyBriefing,
  renderCheckinEvent,
  renderWorkerBriefing,
} from '../../../notifications/briefing';
import { readThreadLocale, recordThreadEvent } from '../../../notifications/thread';

// The late-afternoon Europe/Lisbon check-in: "did you finish today's tasks?",
// asked as a template with two quick-reply buttons and answered by tapping one.
// It goes out inside a two-hour window starting at the company's chosen hour —
// 16:00 unless they moved it on /perfil/automacoes (issue #51). See KIND below
// for where the hour lives now and why the schedule is deliberately not pinned
// to a prettier minute.
//
// DETERMINISTIC END TO END, in both directions. The message is rendered by
// renderWorkerBriefing — the same function the 07:00 briefing uses, so the two
// can never drift about what "your tasks today" means — and the answer comes
// back as one of two payload strings this route minted itself. No model is
// called on this path, which is what makes the "Ainda não" branch free.
//
// THIS ROUTE records an ANSWER and nothing else — it asks the question, and it
// does not flip tasks.status; see the header of
// supabase/migrations/0017_worker_checkins.sql.
//
// It also writes ONE line into the company's chat thread saying who it asked
// (issue #47). Until then it wrote nothing there at all, so the crew's phones
// held a question Capo had no record of ever asking — and a manager asking
// "did you check on the crew today?" got an answer assembled from a board read
// instead of from what had actually happened. That note goes through the shared
// seam in apps/web/app/notifications/thread.ts, not through an inline
// ensureConversation call: the 07:00 route having solved this privately is
// precisely why this one shipped silent.
//
// The ANSWER is no longer inert, though (issue #54). A "Sim, terminei" tap
// arrives at /api/whatsapp, which files a completion claim per task in the
// snapshot below — open_task_review, so `pending_review` and never `done`. Two
// consequences for this file: `task_ids` on the claim it writes is the exact
// set that will be claimed hours later, so anything that changes what goes in
// there changes what a tap declares finished; and "Ainda não" still files
// nothing, which is what keeps that branch free.
//
// That is also why this route diverges from the 07:00 briefing about who is
// asked (issue #44): the morning message goes to everyone on a task, this one
// only to the person who LEADS it. See the filter in the worker loop.
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
 * two kinds gives a late-afternoon run that claims nothing, skips everyone, and reports
 * success with no error anywhere.
 *
 * ── WHERE 16:00 WENT (issue #51, part B1) ──────────────────────────────────
 * There is no `SEND_HOUR` constant here any more. 16:00 is the DEFAULT in
 * apps/web/lib/schedule.ts and the hour that applies is per company, in
 * `company_schedules` (0036). vercel.json is a static file baked into the
 * deployment, so while the schedule lived there no manager could ever move it.
 *
 * ⚠ THE :00 RULE STILL STANDS, and this route is why it exists. The entries
 * used to be 15:30/16:30, and Vercel's cron dispatch drifts — 33 to 49 minutes,
 * reproducibly, on this project. A :00 schedule has a full hour of headroom
 * before the Lisbon hour rolls over; a :30 schedule has thirty minutes, so both
 * check-in entries drifted past the boundary, the gate rejected them, and NOT
 * ONE CHECK-IN WAS EVER SENT. The 07:00 briefing survived the identical drift
 * purely because it was scheduled at :00. The two-hour window bought a second
 * hour of headroom on top; it did not retire the rule, and neither does the
 * hourly heartbeat that replaced the fixed entries — `0 * * * *` is at :00 by
 * construction and must stay that way.
 */
const KIND = 'task_checkin';

export async function GET(request: NextRequest) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  // dry_run renders everything and sends nothing, writes nothing. It also
  // bypasses the send window, so the output can be inspected at any time of day.
  const dryRun = request.nextUrl.searchParams.get('dry_run') === '1';

  const db = getDb();

  const clock = await readLisbonClock(db, 'cron/checkin');
  if (!clock) return new NextResponse('clock unavailable', { status: 500 });
  const { hour, today } = clock;
  // Captured next to the clock read, and written onto every cron_runs row this
  // invocation produces. See CronRunRecord.ranAt for why the pair has to come
  // from the same moment.
  const startedAt = new Date().toISOString();

  let companies;
  try {
    companies = await billableCompanies(db);
  } catch (err) {
    console.error('cron/checkin:', describeSendError(err));
    return new NextResponse('company read failed', { status: 500 });
  }

  // ── the per-company gate (issue #51, part B1) ─────────────────────────────
  // Deliberately the same shape as the 07:00 route's, and for the same two
  // reasons: the hour is per company now, and an invocation that is nobody's
  // hour must cost the clock, the company list and one read of this table
  // rather than a task_board read per company. The hourly heartbeat in
  // vercel.json is only affordable because of this filter.
  const schedules = await readCompanySchedules(db, KIND);
  const due: { company: (typeof companies)[number]; sendHour: number }[] = [];
  let disabledInWindow = 0;
  for (const company of companies) {
    const schedule = scheduleFor(schedules, company.id, KIND);
    if (!dryRun && !withinSendWindow(hour, schedule.sendHour)) continue;
    if (!schedule.enabled) {
      disabledInWindow += 1;
      logEvent('checkin.schedule_disabled', { companyId: company.id, sendHour: schedule.sendHour });
      continue;
    }
    due.push({ company, sendHour: schedule.sendHour });
  }

  if (due.length === 0) {
    // The SAME event name the single-hour gate wrote. A rejected invocation
    // writes no notification_log row, no cron_runs row and raises no error, so
    // this line is still its only trace anywhere — and an empty table was
    // exactly the symptom of the :30 schedule bug that kept this feature dead
    // for two days.
    logEvent('checkin.outside_send_hour', {
      lisbonHour: hour,
      companies: companies.length,
      disabledInWindow,
    });
    return NextResponse.json({
      skipped: 'outside the send window',
      lisbonHour: hour,
      companies: companies.length,
      disabledInWindow,
    });
  }

  // Read AFTER the window gate, for the reason given in the 07:00 route: a
  // preview deployment with no WhatsApp credentials must answer the same
  // 200-with-{skipped} an out-of-hours run always did, not twenty-four 503s.
  const env = whatsappSendEnv();
  if (!env && !dryRun) return new NextResponse('whatsapp not configured', { status: 503 });

  const report: unknown[] = [];

  for (const { company, sendHour } of due) {
    const windowEnd = sendWindowEnd(sendHour);
    try {
      const briefing = await loadCompanyBriefing(db, company.id, company.language);
      const sends: unknown[] = [];
      let asked = 0;
      // WHO was asked, and how many claims THIS invocation won (issue #47).
      //
      // `askedNames` is crew names — text the MANAGER typed on /perfil — for
      // the thread note below. Nothing a worker wrote ever enters it.
      //
      // `claims` is the idempotency counter. Since the send window widened to
      // two Lisbon hours (#51) two invocations pass the hour gate every day;
      // notification_log's unique constraint makes the SENDS safe (the second
      // run claims nothing and messages nobody), but a thread note is a message
      // and no unique constraint protects it. Counting claims is what makes the
      // note ride the same lock: the run that won the claims is the run that
      // asked the question, and later runs stay quiet.
      const askedNames: string[] = [];
      let claims = 0;

      // The tallies that become the cron_runs row (issue #51, part B2). No
      // `skippedIdle` counter here and no manager counters: this route writes
      // no claim at all for an idle worker (there is nothing to skip) and has
      // no manager audience.
      let failed = 0;

      // The consent gate lives inside loadCompanyBriefing, so it applies to this
      // send without this route implementing anything. All that is left to do is
      // say so out loud — see the same block in cron/reminders.
      if (briefing.excludedNoConsent > 0) {
        logEvent('checkin.workers_no_consent', {
          companyId: company.id,
          excluded: briefing.excludedNoConsent,
        });
      }
      if (briefing.excludedUnreachable > 0) {
        logEvent('checkin.workers_unreachable', {
          companyId: company.id,
          excluded: briefing.excludedUnreachable,
        });
      }
      // The third way to be skipped, and the only one that used to leave no
      // trace at all (#51, #54): a crew row switched off. Skipping it is
      // correct; being unable to tell that from a broken cron was not. This is
      // the counter that explains "the manager was assigned a task and got no
      // check-in card" without a database session.
      if (briefing.excludedInactive > 0) {
        logEvent('checkin.workers_inactive', {
          companyId: company.id,
          excluded: briefing.excludedInactive,
        });
      }

      for (const worker of briefing.workers) {
        // Note there is deliberately no NOTIFY_IDLE_WORKERS dial here, unlike
        // the 07:00 briefing. Asking "did you finish today's tasks?" of someone
        // who had none is not a product decision with two defensible answers;
        // it is a bug. No claim is written either, so an idle worker leaves no
        // 'skipped' row — there was nothing to skip.
        if (worker.tasks.length === 0) continue;

        // ── THE COLLABORATOR DECISION (issue #44) ────────────────────────────
        // The 07:00 briefing goes to everybody on a task, lead and helpers
        // alike. This one does NOT. The check-in asks a person only about the
        // tasks they LEAD, and a crew member whose whole day was helping is not
        // asked at all.
        //
        // WHY, and it is not caution for its own sake. A "Sim, terminei" tap is
        // not an answer any more — since #54 it files a completion claim, one
        // per id in this snapshot, through open_task_review. Widening the
        // snapshot to helper tasks would mean a helper can declare somebody
        // else's job finished by tapping one button, with the lead's name
        // nowhere near the claim. The manager would then read "the Pintura is
        // finished" attributed to a person who was carrying buckets on it.
        //
        // That is worse than it sounds, because a claim is not reversible from
        // the crew's side: `task_reviews_one_pending_idx` allows exactly one
        // live review per task, so the helper's premature claim BLOCKS the lead
        // from filing their own until the manager resolves it.
        //
        // The lead is asked about the same task on the same afternoon, so
        // nothing goes unasked — the question simply goes to the person
        // accountable for the answer.
        //
        // KNOWN LIMIT, stated rather than hidden: a helper has NO way to report
        // a task finished at all. `declare_task_done` checks
        // `assignee_worker_id` too, so asking the worker agent in words gets
        // "that task is not one of yours". Today they tell the lead or the
        // manager. Giving a helper their own reportable claim is a real feature
        // and a bigger one — it needs a shape for two claims on one task, which
        // task_reviews_one_pending_idx currently forbids.
        //
        // Filtered HERE rather than in loadCompanyBriefing on purpose: the
        // briefing route needs the full list, and one shared loader that
        // silently dropped helper tasks would take the 07:00 message with it.
        const leadTasks = worker.tasks.filter(t => t.role === 'lead');
        if (leadTasks.length === 0) continue;

        // The rendered list and the claimed ids come from the SAME array, which
        // is what keeps "what the worker was asked about" and "what their tap
        // declares finished" the same set. Do not let these two diverge.
        const [name, taskList] = renderWorkerBriefing({ ...worker, tasks: leadTasks });
        const taskIds = leadTasks.map(t => t.id);

        if (dryRun) {
          sends.push({
            audience: 'worker',
            to: worker.recipient.kind === 'phone' ? worker.recipient.waId : worker.recipient.userId,
            address: describeRecipient(worker.recipient),
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
        claims += 1;

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
            sendConfigFor(env!, worker.recipient),
          );
          await resolveNotification(db, claimed.id, 'sent', { provider_message_id: providerMessageId });
          asked += 1;
          askedNames.push(worker.name);
        } catch (err) {
          // One unreachable worker must never abort the run. A 132001 is the
          // expected case until the template is approved; a 131026 means the
          // number is not on WhatsApp; a 131021 means we tried to message the
          // business number itself. The allow-list 131030 belonged to the test
          // tier and should no longer appear.
          await resolveNotification(db, claimed.id, 'failed', { error: describeSendError(err) });
          failed += 1;
          logEvent('checkin.worker_send_failed', {
            companyId: company.id,
            workerId: worker.workerId,
            error: describeSendError(err),
          });
        }
      }

      // ── the chat thread (issue #47) ──────────────────────────────────────
      //
      // This route used to write nothing here, and the comment that used to sit
      // in this spot argued the case: the manager's surface for a check-in is
      // worker_checkins, and a note before anyone has answered says nothing.
      //
      // That was wrong in one specific way, and it is the whole of issue #47.
      // The crew's phones held a question Capo had never been told about, so a
      // manager asking "did you check on the crew today?" got an answer built
      // from a board read while the real conversation was elsewhere. What the
      // manager sees and what Capo sees must not diverge — and the 07:00 route
      // had already accepted that argument for itself, months earlier, inline.
      //
      // No manager AUDIENCE, though: nothing here is sent to a manager over
      // WhatsApp. That part of the old comment stands.
      //
      // ── written once a day, by the run that did the asking ───────────────
      // `claims > 0` and nothing else. It means this invocation won at least
      // one notification_log claim, i.e. it is the invocation that actually
      // sent the question; every later in-window run claims nothing (23505) and
      // stays quiet.
      //
      // Deliberately NO `targets === 0` branch, unlike the 07:00 route. There,
      // claiming nobody means a whole company is unreachable and the note is
      // the only in-product trace of it. Here it means the crew had nothing
      // scheduled — a weekend, a quiet Tuesday — which is the ordinary case,
      // and "I asked nobody anything" written into the thread every evening
      // would be noise in front of the manager AND in front of the model.
      //
      // A dry run renders it unconditionally and sends nothing, so an operator
      // can read the note at any hour without waiting for a real claim.
      if (dryRun || claims > 0) {
        const eventLocale = await readThreadLocale(db, company.id, briefing.companyLocale);
        const eventText = renderCheckinEvent(asked, askedNames, eventLocale);
        if (dryRun) {
          sends.push({ audience: 'thread', locale: eventLocale, text: eventText });
        } else {
          await recordThreadEvent(db, { companyId: company.id, source: 'checkin_ask', text: eventText });
        }
      }

      // ── the run row (issue #51, part B2) ─────────────────────────────────
      // Written on EVERY in-window invocation that reaches here, unlike the
      // thread note above, but only the claiming one replaces. A quiet
      // afternoon — nobody with a task they lead — is the ordinary case here
      // rather than the alarming one, and the `replace: false` row is what
      // makes "we looked, and there was nobody to ask" visible without writing
      // "I asked nobody anything" into the manager's chat every evening.
      if (!dryRun) {
        await recordCronRun(
          db,
          {
            companyId: company.id,
            jobKind: KIND,
            runDate: today,
            dueHour: sendHour,
            ranHour: hour,
            ranAt: startedAt,
            messaged: asked,
            skippedIdle: 0,
            failed,
            excludedNoConsent: briefing.excludedNoConsent,
            excludedUnreachable: briefing.excludedUnreachable,
            excludedInactive: briefing.excludedInactive,
            managersNoConsent: 0,
            noManagerAccount: false,
          },
          { replace: claims > 0 },
        );
      }

      report.push({
        company: company.name,
        dueHour: sendHour,
        windowEnd,
        asked,
        failed,
        excluded: {
          noConsent: briefing.excludedNoConsent,
          unreachable: briefing.excludedUnreachable,
          inactive: briefing.excludedInactive,
        },
        sends,
      });
    } catch (err) {
      // One broken company must not cost every other company its check-in.
      console.error(`cron/checkin: company ${company.id} failed:`, err);
      logEvent('checkin.company_failed', { companyId: company.id, error: describeSendError(err) });
      report.push({ company: company.name, error: describeSendError(err) });
    }
  }

  return NextResponse.json({ dryRun, date: today, lisbonHour: hour, companies: report });
}
