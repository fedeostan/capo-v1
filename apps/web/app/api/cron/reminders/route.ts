import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@capo/db/client';
import { appendEventMessage, ensureConversation } from '@capo/core/conversation';
import {
  isOutsideWindowError,
  sendWhatsAppTemplate,
  sendWhatsAppText,
  withinFreeFormWindow,
  type WhatsAppRecipient,
} from '@capo/core/channels/whatsapp';
import { coerceLocale, type Locale } from '@capo/i18n/locale';
import { getCatalog } from '@capo/i18n/catalog';
import {
  describeRecipient,
  hasWhatsAppConsent,
  recipientFor,
  sendConfigFor,
  whatsappSendEnv,
  type WhatsAppEnv,
} from '../../../../lib/whatsapp';
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
import {
  loadCompanyBriefing,
  readLastInboundAt,
  renderManagerBriefing,
  renderManagerEvent,
  renderManagerFreeForm,
  renderWorkerBriefing,
  renderWorkerFreeForm,
} from '../../../notifications/briefing';

// The daily 07:00 Europe/Lisbon briefing.
//
// This replaces the external n8n + Twilio SMS dispatch, which is switched off.
// Nothing here reads dispatch_tasks_today or writes dispatch_log — that
// contract stays frozen so SMS can be switched back on (see AGENTS.md).
//
// SYSTEM path: no user session, service-role client, acts across tenants. Its
// structural gate is the CRON_SECRET bearer token, which Vercel injects
// automatically on scheduled invocations.

export const dynamic = 'force-dynamic';

// One Graph API round-trip per worker plus one per manager, across every
// company, all inside a single invocation. 300 matches the WhatsApp webhook.
export const maxDuration = 300;

/**
 * 07:00 in Lisbon — the hour this briefing TARGETS, not the only hour it may
 * go out in. Vercel schedules in UTC and its dispatch drifts by up to an hour
 * on this project, so the gate below accepts the whole SEND_WINDOW_HOURS-wide
 * window starting here (07:00–08:59 Lisbon). The reasoning, the measured drift
 * and the matching vercel.json UTC entries are all in `withinSendWindow`.
 */
const SEND_HOUR = 7;

/**
 * The Meta template. Must already be approved in WhatsApp Manager for every
 * locale in @capo/i18n — see docs/whatsapp-cloud-api-runbook.md. Two body
 * parameters: {{1}} the recipient's name, {{2}} the one-line summary.
 */
const TEMPLATE_NAME = 'capo_daily_briefing';

/**
 * ── FEDERICO: message a worker who has nothing scheduled today?
 * false  — stay quiet, and record a 'skipped' row. Saves a paid template send
 *          per idle worker per day — a real cost now that the number is off the
 *          free test tier and conversations are billed.
 * true   — Capo is never silent; an idle worker gets `reminders.workerNothing`,
 *          so silence never has to be interpreted.
 */
const NOTIFY_IDLE_WORKERS = false;

const KIND = 'daily_briefing';

/** Which envelope a briefing actually went out in. */
type SendPath = 'free_form' | 'template';

interface BriefingDelivery {
  path: SendPath;
  providerMessageId: string | null;
  /** True when a free-form attempt was refused as out-of-window and the
   *  template picked it up. Logged, because it means the stored
   *  `last_inbound_at` and Meta's own view of the window disagreed. */
  fellBack: boolean;
}

/**
 * Send ONE person their briefing, in the cheapest envelope that will actually
 * arrive.
 *
 * ── The decision (issue #46, defect 1) ─────────────────────────────────────
 * Meta bills every TEMPLATE send. It bills nothing for ordinary text sent
 * inside the 24 hours a person's own inbound message opens. Before this, the
 * 07:00 briefing sent a paid template to everybody — including the manager who
 * had been chatting with Capo minutes earlier.
 *
 * `freeForm` comes from withinFreeFormWindow(), which returns true only on
 * POSITIVE PROOF of an inbound in the last 23 hours and fails closed toward the
 * template on everything else. That asymmetry is the safety property: a
 * template always arrives and merely costs money, while free-form text outside
 * the window is refused outright (131047) and the person gets nothing at all.
 *
 * ── The fallback ───────────────────────────────────────────────────────────
 * A free-form attempt that is refused as out-of-window costs nothing, so the
 * template picks it up immediately — the recipient still hears from Capo, and
 * the day costs exactly what it cost before. Caught NARROWLY, by Meta's error
 * code: any other failure means the send is genuinely broken and re-sending it
 * as a template would spend money to reach the same wall.
 *
 * Both attempts sit inside the caller's SINGLE notification_log claim. One
 * person, one claim, one day — a second claim would defeat the idempotency lock
 * the whole cron rests on.
 */
async function deliverBriefing(args: {
  env: WhatsAppEnv;
  recipient: WhatsAppRecipient;
  freeForm: boolean;
  /** The multi-line text body. Only read when `freeForm` is true. */
  freeFormBody: string;
  templateLanguage: string;
  templateParams: [string, string];
}): Promise<BriefingDelivery> {
  const config = sendConfigFor(args.env, args.recipient);
  const template = () =>
    sendWhatsAppTemplate(
      {
        name: TEMPLATE_NAME,
        languageCode: args.templateLanguage,
        bodyParams: args.templateParams,
      },
      config,
    );

  if (!args.freeForm) {
    const { providerMessageId } = await template();
    return { path: 'template', providerMessageId, fellBack: false };
  }

  try {
    const { providerMessageId } = await sendWhatsAppText(args.freeFormBody, config);
    return { path: 'free_form', providerMessageId, fellBack: false };
  } catch (err) {
    if (!isOutsideWindowError(err)) throw err;
    const { providerMessageId } = await template();
    return { path: 'template', providerMessageId, fellBack: true };
  }
}

export async function GET(request: NextRequest) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  // dry_run renders everything and sends nothing, writes nothing. It also
  // bypasses the send window, so the output can be inspected at any time of day.
  const dryRun = request.nextUrl.searchParams.get('dry_run') === '1';

  const db = getDb();

  const clock = await readLisbonClock(db, 'cron/reminders');
  if (!clock) return new NextResponse('clock unavailable', { status: 500 });
  const { hour, today } = clock;
  const windowEnd = sendWindowEnd(SEND_HOUR);
  if (!dryRun && !withinSendWindow(hour, SEND_HOUR)) {
    // Logged, not just returned. A cron that fires and is then rejected by this
    // gate leaves no trace anywhere else — no notification_log row, no error —
    // which is exactly how the check-in's schedule bug stayed invisible for two
    // days, and exactly what a drift past the window would look like on the
    // morning the crew hears nothing. `windowEnd` is in the payload so the line
    // records what was actually required rather than only what was aimed at.
    logEvent('reminders.outside_send_hour', { lisbonHour: hour, sendHour: SEND_HOUR, windowEnd });
    return NextResponse.json({
      skipped: 'outside the send window',
      lisbonHour: hour,
      sendHour: SEND_HOUR,
      windowEnd,
    });
  }

  const env = whatsappSendEnv();
  if (!env && !dryRun) return new NextResponse('whatsapp not configured', { status: 503 });

  // ONE `now` for the whole invocation, read here rather than per recipient.
  // A run across a large estate can take minutes; a per-recipient clock would
  // mean two people with identical inbound times could be classified
  // differently, which is impossible to reason about from a log. The 23-hour
  // margin in FREE_FORM_WINDOW_MS is far wider than any run could last, so
  // freezing the clock costs nothing and makes the decision reproducible.
  const now = Date.now();

  let companies;
  try {
    companies = await billableCompanies(db);
  } catch (err) {
    console.error('cron/reminders:', describeSendError(err));
    return new NextResponse('company read failed', { status: 500 });
  }

  const report: unknown[] = [];

  for (const company of companies) {
    try {
      const briefing = await loadCompanyBriefing(db, company.id, company.language);
      const sends: unknown[] = [];
      let notified = 0;

      // Two counters that exist only to keep the chat-thread note below written
      // exactly once a day now that more than one invocation can pass the gate.
      // `targets` is everyone this run was willing to claim; `claims` is how
      // many of those claims it actually won. See the note's own comment.
      let targets = 0;
      let claims = 0;

      // Not a per-worker log line: this is the count of people the consent gate
      // removed before the loop below could see them, and without it a company
      // whose crew has not opted in is indistinguishable from a company with no
      // crew at all.
      if (briefing.excludedNoConsent > 0) {
        logEvent('reminders.workers_no_consent', {
          companyId: company.id,
          excluded: briefing.excludedNoConsent,
        });
      }
      if (briefing.excludedUnreachable > 0) {
        logEvent('reminders.workers_unreachable', {
          companyId: company.id,
          excluded: briefing.excludedUnreachable,
        });
      }
      // The third way to be skipped, and the only one that used to leave no
      // trace at all (#51, #54): a crew row switched off. Skipping it is
      // correct; being unable to tell that from a broken cron was not.
      if (briefing.excludedInactive > 0) {
        logEvent('reminders.workers_inactive', {
          companyId: company.id,
          excluded: briefing.excludedInactive,
        });
      }

      // ── workers ──────────────────────────────────────────────────────────
      for (const worker of briefing.workers) {
        const [name, summary] = renderWorkerBriefing(worker);
        const taskIds = worker.tasks.map(t => t.id);
        const idle = worker.tasks.length === 0;

        // Decided ONCE per recipient, from `now` rather than per attempt, so
        // the dry-run report and the real send can never disagree about which
        // envelope this person was going to get.
        const freeForm = withinFreeFormWindow(worker.lastInboundAt, now);
        const freeFormBody = renderWorkerFreeForm(worker);

        if (dryRun) {
          // `to` keeps its old meaning — the address as sent — and `address`
          // adds which KIND it is. That kind is the operator's only pre-flight
          // way to tell a send that will go to a phone from one that will go to
          // a BSUID; without it the two are indistinguishable in this output.
          sends.push({
            audience: 'worker',
            to: worker.recipient.kind === 'phone' ? worker.recipient.waId : worker.recipient.userId,
            address: describeRecipient(worker.recipient),
            locale: worker.locale,
            name,
            summary,
            idle,
            // The two fields an operator needs to answer "why did this cost
            // money?" before it does. `body` is what would actually be sent on
            // the free-form path — the template path sends `summary`.
            path: freeForm ? 'free_form' : 'template',
            body: freeForm ? freeFormBody : undefined,
          });
          continue;
        }

        targets += 1;
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

        if (idle && !NOTIFY_IDLE_WORKERS) {
          await resolveNotification(db, claimed.id, 'skipped');
          continue;
        }

        try {
          const delivery = await deliverBriefing({
            env: env!,
            recipient: worker.recipient,
            freeForm,
            freeFormBody,
            templateLanguage: getCatalog(worker.locale).reminders.templateLanguage,
            templateParams: [name, summary],
          });
          await resolveNotification(db, claimed.id, 'sent', {
            provider_message_id: delivery.providerMessageId,
          });
          // WHICH ENVELOPE, on every send. notification_log has no column for
          // it and adding one would make a deploy that lands before its
          // migration leave every row stuck at 'pending', so the record lives
          // in the log drain instead. Without this line the cost saving is
          // unverifiable: a free send and a paid one look identical in the
          // ledger.
          logEvent('reminders.briefing_sent', {
            companyId: company.id,
            audience: 'worker',
            workerId: worker.workerId,
            path: delivery.path,
            fellBack: delivery.fellBack,
          });
          notified += 1;
        } catch (err) {
          // One unreachable worker must never abort the run. A 132001 means the
          // template is not approved for that locale; a 131026 means the number
          // is not on WhatsApp; a 131021 means we tried to message the business
          // number itself. The allow-list 131030 belonged to the test tier and
          // should no longer appear.
          await resolveNotification(db, claimed.id, 'failed', { error: describeSendError(err) });
          logEvent('reminders.worker_send_failed', {
            companyId: company.id,
            workerId: worker.workerId,
            error: describeSendError(err),
          });
        }
      }

      // ── managers ─────────────────────────────────────────────────────────
      // Throw rather than fall through to `?? []`: a failed read here would
      // otherwise look identical to a company with no managers, and silently
      // stop briefing the one person who would notice.
      //
      // select('*') for the same deploy-ordering reason as the workers read in
      // loadCompanyBriefing: 0025 adds the two consent columns.
      const { data: managers, error: managersError } = await db
        .from('profiles')
        .select('*')
        .eq('company_id', company.id);
      if (managersError) throw new Error(`profiles read failed: ${managersError.message}`);

      for (const manager of managers ?? []) {
        // The manager's own consent. Their briefing is as proactive a template
        // send as the crew's, so it needs the same recorded opt-in — the fact
        // that they are the account holder is not itself consent to be messaged
        // on WhatsApp. They tick this for themselves on /perfil.
        if (!hasWhatsAppConsent(manager)) {
          logEvent('reminders.manager_no_consent', { companyId: company.id });
          continue;
        }

        const locale: Locale = coerceLocale(manager.language);
        const [name, summary] = renderManagerBriefing(manager.full_name, briefing.counts, locale);

        // Phone, then the BSUID captured from their own inbound messages.
        // profiles.phone is `not null` (0007:17), so null here means an empty
        // string and a manager nobody could ever have reached — but the branch
        // is real rather than defensive: it is the same code path a future
        // BSUID-only manager takes, and leaving it out would make that person a
        // throw instead of a skip.
        const recipient = recipientFor(manager);

        // The manager gets the cost fix too, and is in fact the person who
        // reported it — issue #46 opens with "a user, that is, the manager in
        // this case, which is me". Their CONTENT is unchanged: what a manager
        // needs at 07:00 is the count, and the board is one tap away.
        const freeForm = withinFreeFormWindow(readLastInboundAt(manager), now);
        const freeFormBody = renderManagerFreeForm(manager.full_name, briefing.counts, locale);

        if (dryRun) {
          sends.push({
            audience: 'manager',
            to: recipient?.kind === 'phone' ? recipient.waId : recipient?.userId,
            address: recipient ? describeRecipient(recipient) : 'unreachable',
            locale,
            name,
            summary,
            path: freeForm ? 'free_form' : 'template',
            body: freeForm ? freeFormBody : undefined,
          });
          continue;
        }

        targets += 1;
        const claimed = await claimNotification(db, {
          kind: KIND,
          company_id: company.id,
          audience: 'manager',
          profile_id: manager.id,
          notification_date: today,
          task_ids: [],
        });
        if (!claimed) continue;
        claims += 1;

        // Claimed FIRST, then skipped — the same order the idle-worker branch
        // uses above. A 'skipped' row is what makes an unreachable manager
        // visible in notification_log; returning before the claim would leave
        // the day looking as though nothing had been attempted. And it is a
        // skip, never a throw: one unreachable recipient must not abort the run
        // for every other company.
        if (!recipient) {
          await resolveNotification(db, claimed.id, 'skipped');
          logEvent('reminders.manager_unreachable', { companyId: company.id });
          continue;
        }

        try {
          const delivery = await deliverBriefing({
            env: env!,
            recipient,
            freeForm,
            freeFormBody,
            templateLanguage: getCatalog(locale).reminders.templateLanguage,
            templateParams: [name, summary],
          });
          await resolveNotification(db, claimed.id, 'sent', {
            provider_message_id: delivery.providerMessageId,
          });
          logEvent('reminders.briefing_sent', {
            companyId: company.id,
            audience: 'manager',
            path: delivery.path,
            fellBack: delivery.fellBack,
          });
        } catch (err) {
          await resolveNotification(db, claimed.id, 'failed', { error: describeSendError(err) });
          logEvent('reminders.manager_send_failed', {
            companyId: company.id,
            error: describeSendError(err),
          });
        }
      }

      // ── the chat thread ──────────────────────────────────────────────────
      // Written regardless of whether WhatsApp delivered: the thread is the
      // permanent record, and a manager who later asks "what did you send the
      // crew?" should get an answer even on a day Meta rejected every send.
      // appendEventMessage writes role='event', which the chat page renders as
      // a system note and toThread() presents to the model as <system-event>.
      //
      // ⚠ This is the ONE side effect of this route that notification_log's
      // unique constraint does not protect — it is a message, not a send — and
      // widening the hour gate into a two-hour window means two or three
      // invocations now pass it every day instead of one. Written
      // unconditionally, the manager would find the note two or three times
      // each morning, every copy after the first claiming "avisei 0 pessoas",
      // and every copy would also enter the agent's context as a
      // <system-event>. So only the invocation that actually did the work
      // writes it:
      //
      //   claims > 0    this run won the claims, so it is the run that briefed
      //                 the crew. Later runs in the same window claim nothing
      //                 (23505) and stay quiet. Holds however many times the
      //                 route is invoked.
      //   targets === 0 the company had nobody claimable at all — no crew with
      //                 consent, no manager with consent — so there is no
      //                 ledger row to dedupe against and the "nothing went out
      //                 today" note would otherwise be lost entirely. That note
      //                 is worth keeping: it is the only in-product trace that
      //                 a whole company is silently unreachable. Restricted to
      //                 the target hour so it is written once rather than once
      //                 per in-window invocation.
      const eventLocale = firstManagerLocale(managers, briefing.companyLocale);
      const eventText = renderManagerEvent(briefing.counts, notified, eventLocale);
      const firstRunOfTheDay = claims > 0 || (targets === 0 && hour === SEND_HOUR);
      if (!dryRun) {
        if (firstRunOfTheDay) {
          const conversationId = await ensureConversation(db, company.id);
          await appendEventMessage(db, conversationId, eventText);
        }
      } else {
        sends.push({ audience: 'thread', locale: eventLocale, text: eventText });
      }

      report.push({ company: company.name, counts: briefing.counts, notified, sends });
    } catch (err) {
      // A broken company must not stop the rest of the estate being briefed.
      console.error(`cron/reminders: company ${company.id} failed:`, err);
      logEvent('reminders.company_failed', { companyId: company.id, error: describeSendError(err) });
      report.push({ company: company.name, error: describeSendError(err) });
    }
  }

  return NextResponse.json({ dryRun, date: today, lisbonHour: hour, companies: report });
}

// The thread is shared, so its note can only be in one language. The first
// manager's is a better guess than the company's stored-content language,
// which is about task titles rather than about who is reading.
function firstManagerLocale(
  managers: { language: string | null }[] | null,
  fallback: Locale,
): Locale {
  const first = managers?.[0]?.language;
  return first ? coerceLocale(first) : fallback;
}
