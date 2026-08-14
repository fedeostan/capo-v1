import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@capo/db/client';
import {
  isOutsideWindowError,
  sendWhatsAppTemplate,
  sendWhatsAppText,
  withinFreeFormWindow,
  type WhatsAppRecipient,
} from '@capo/core/channels/whatsapp';
import { getCatalog } from '@capo/i18n/catalog';
import { describeRecipient, sendConfigFor, whatsappSendEnv, type WhatsAppEnv } from '../../../../lib/whatsapp';
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
  loadPendingWelcomes,
  renderWelcome,
  renderWelcomeEvent,
  renderWelcomeFreeForm,
  WELCOME_KIND,
} from '../../../notifications/welcome';
import { readThreadLocale, recordThreadEvent } from '../../../notifications/thread';

// ── THE WELCOME SWEEP (issue #45) ───────────────────────────────────────────
//
// "We need a welcome to Capo as soon as a number is added to the system."
//
// A SWEEP rather than a hook on the moment a number is typed, and that is the
// whole design decision. A number entering the system is not the moment Capo is
// allowed to use it — a recorded WhatsApp opt-in is (0025), and the two happen
// at different times through four different doors: the onboarding form, the
// crew card on /perfil, Capo's guarded add_worker and update_worker tools, and
// a worker replying START to a message. A hook would have to be remembered at
// each of them, and the one that was forgotten would fail silently.
//
// A sweep asks a question instead of remembering an event: "who may be messaged
// and has never been introduced?". Every door leads to it, no door has to know
// it exists, and consent recorded three weeks late is picked up on the next
// run. Same reasoning as /api/cron/push, which exists so a producer that forgets
// the immediate call costs lateness rather than silence.
//
// SYSTEM path: no user session, service-role client, acts across tenants. Its
// structural gate is the CRON_SECRET bearer token, which Vercel injects on its
// own scheduled invocations.

export const dynamic = 'force-dynamic';

// One Graph API round-trip per person, across every company, in one invocation
// — the same shape as the two daily sends, and the same ceiling.
export const maxDuration = 300;

/**
 * The first Lisbon hour a welcome may go out, and how many hours wide that
 * window is. 09:00 through 19:59.
 *
 * ── WHY THERE IS AN HOUR GATE AT ALL ───────────────────────────────────────
 * Unlike the two daily sends this route has no "correct" time — it fires
 * whenever somebody was added. But a manager doing admin at 23:40 must not wake
 * their crew, and a first-ever message from an unknown number at 03:00 is how a
 * business number earns a block report. Quiet hours are a courtesy the crew
 * will never see working and would certainly notice failing.
 *
 * ── WHY IT STARTS AT 09 AND NOT 07 ─────────────────────────────────────────
 * The 07:00 briefing's own window is Lisbon 07–08. Starting here at 09 means a
 * crew member added overnight cannot receive their welcome and their first
 * briefing in the same hour, in an order nobody chose. They get the briefing
 * first and the welcome an hour later, which is still the wrong way round —
 * see the known limitation at the end of this file — but it is one message out
 * of order rather than two arriving together.
 *
 * ── WHY DRIFT CANNOT SILENCE THIS ROUTE ────────────────────────────────────
 * The window is ELEVEN hours wide and the schedule runs every fifteen minutes,
 * so Vercel's cron drift (measured at 33–49 minutes on this project) can at
 * worst push one invocation out of the window at the very end of the day. The
 * sweep is stateless — it re-derives its queue from the database on every run —
 * so a lost invocation costs lateness, never silence, exactly as it does for
 * /api/cron/push. That is also why AGENTS.md's ":00, never :30" rule does not
 * bind here: it exists for routes whose window is one hour wide and whose
 * miss is total.
 */
const SEND_HOUR = 9;
const WINDOW_HOURS = 11;

/**
 * How many people one company may be welcomed in a single run.
 *
 * Not a cost control — the ledger already guarantees one welcome per person
 * ever, so the total spend is fixed no matter how this is set. It is a
 * WALL-CLOCK control: sends are serial Graph API round trips and a company that
 * imports a fifty-person crew in one afternoon would otherwise try all fifty
 * inside one 300-second invocation, alongside every other company. Whatever is
 * left over is picked up fifteen minutes later.
 */
const MAX_PER_COMPANY_PER_RUN = 20;

/**
 * The Meta template. Must already be approved in WhatsApp Manager for every
 * locale in @capo/i18n — see docs/whatsapp-cloud-api-runbook.md and
 * scripts/whatsapp-templates.ts, which holds the submitted copy. Two body
 * parameters: {{1}} the recipient's name, {{2}} the audience-specific sentence.
 */
const TEMPLATE_NAME = 'capo_welcome';

interface WelcomeDelivery {
  path: 'free_form' | 'template';
  providerMessageId: string | null;
  /** A free-form attempt was refused as out-of-window and the template picked
   *  it up — meaning the stored `last_inbound_at` and Meta's own view of the
   *  window disagreed. Logged, because it is the only way to see that. */
  fellBack: boolean;
}

/**
 * Send ONE welcome, in the cheapest envelope that will actually arrive.
 *
 * Identical decision to deliverBriefing's, and identical for the same reason:
 * `withinFreeFormWindow` returns true only on POSITIVE PROOF of an inbound in
 * the last 23 hours and fails closed toward the paid template on everything
 * else. A template always arrives and merely costs money; free-form text
 * outside the window is refused outright (131047) and the person gets nothing.
 *
 * For a welcome the free-form branch is the rare one by construction — this
 * message exists because nobody has heard from Capo yet — but it is free when
 * it applies, so it is worth having.
 *
 * Both attempts sit inside the caller's SINGLE notification_log claim. One
 * person, one claim, forever.
 */
async function deliverWelcome(args: {
  env: WhatsAppEnv;
  recipient: WhatsAppRecipient;
  freeForm: boolean;
  freeFormBody: string;
  templateLanguage: string;
  templateParams: [string, string];
}): Promise<WelcomeDelivery> {
  const config = sendConfigFor(args.env, args.recipient);
  const template = () =>
    sendWhatsAppTemplate(
      { name: TEMPLATE_NAME, languageCode: args.templateLanguage, bodyParams: args.templateParams },
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
    // Caught NARROWLY, by Meta's error code. Any other failure means the send
    // is genuinely broken, and re-sending it as a template would spend money to
    // reach the same wall.
    if (!isOutsideWindowError(err)) throw err;
    const { providerMessageId } = await template();
    return { path: 'template', providerMessageId, fellBack: true };
  }
}

export async function GET(request: NextRequest) {
  const denied = authorizeCron(request);
  if (denied) {
    // Logged for the reason /api/cron/push logs it: an auth misconfiguration —
    // a rotated CRON_SECRET, a typo in Vercel's env — otherwise looks
    // byte-identical to a healthy idle sweep. Both write nothing and raise
    // nothing, which is the exact shape of failure that let the check-in ship
    // and never send a single message.
    logEvent('welcome.cron_denied', { status: denied.status });
    return denied;
  }

  // dry_run renders everything and sends nothing, writes nothing. It also
  // bypasses the hour gate, so the output can be inspected at any time of day.
  const dryRun = request.nextUrl.searchParams.get('dry_run') === '1';

  const db = getDb();

  // ── THE DEPLOY GATE ───────────────────────────────────────────────────────
  // 0033 adds two things: the partial unique index that makes a welcome
  // once-per-person-EVER, and the backfill that marks everybody who already
  // exists as already introduced. Without them this route would introduce Capo,
  // by paid template, to every crew member and every manager already using it.
  //
  // On this project a migration has been skipped in production before while a
  // later one was applied, so "the code will obviously ship after its
  // migration" is not a safe assumption to build a paid send on. The marker
  // function 0033 creates is the proof, and its absence is a REFUSAL: a welcome
  // that is a day late is a nuisance; a welcome sent to everybody at once is a
  // bill and an apology.
  const { error: ledgerError } = await db.rpc('welcome_ledger_ready');
  if (ledgerError) {
    logEvent('welcome.ledger_not_ready', { error: ledgerError.message });
    return new NextResponse('welcome ledger not ready', { status: 503 });
  }

  const clock = await readLisbonClock(db, 'cron/welcome');
  if (!clock) return new NextResponse('clock unavailable', { status: 500 });
  const { hour, today } = clock;
  const windowEnd = sendWindowEnd(SEND_HOUR, WINDOW_HOURS);
  if (!dryRun && !withinSendWindow(hour, SEND_HOUR, WINDOW_HOURS)) {
    // Logged, not just returned — a rejected invocation leaves no other trace
    // anywhere, which is how a broken schedule stays invisible.
    logEvent('welcome.outside_send_hour', { lisbonHour: hour, sendHour: SEND_HOUR, windowEnd });
    return NextResponse.json({ skipped: 'outside the send window', lisbonHour: hour, sendHour: SEND_HOUR, windowEnd });
  }

  const env = whatsappSendEnv();
  if (!env && !dryRun) return new NextResponse('whatsapp not configured', { status: 503 });

  // ONE `now` for the whole invocation, for the same reason /api/cron/reminders
  // freezes it: a run across a large estate takes minutes, and two people with
  // identical inbound times must not be classified differently.
  const now = Date.now();

  let companies;
  try {
    companies = await billableCompanies(db);
  } catch (err) {
    console.error('cron/welcome:', describeSendError(err));
    return new NextResponse('company read failed', { status: 500 });
  }

  const report: unknown[] = [];

  for (const company of companies) {
    try {
      const audience = await loadPendingWelcomes(db, company);
      const batch = audience.pending.slice(0, MAX_PER_COMPANY_PER_RUN);
      const sends: unknown[] = [];
      // Crew names ONLY, and every one of them typed by the MANAGER on /perfil
      // or dictated to Capo. Never a word a crew member wrote — see
      // notifications/thread.ts.
      const welcomedCrew: string[] = [];

      // The dominant reason somebody is not welcomed, and the one a manager can
      // actually act on: a number on file that nobody has agreed to.
      //
      // Logged only on a run that actually sends, deliberately. This route wakes
      // up ninety-six times a day and this count does not change between runs,
      // so logging it unconditionally would write the same line every fifteen
      // minutes forever and bury the lines that mean something. The same number
      // is in this route's JSON response on every run, and /api/cron/reminders
      // logs its own copy once a day.
      if (batch.length > 0 && audience.excludedNoConsent > 0) {
        logEvent('welcome.workers_no_consent', {
          companyId: company.id,
          excluded: audience.excludedNoConsent,
        });
      }

      for (const target of batch) {
        const [name, middle] = renderWelcome(target, company.name);
        const freeForm = withinFreeFormWindow(target.lastInboundAt, now);
        const freeFormBody = renderWelcomeFreeForm(target, company.name);

        if (dryRun) {
          sends.push({
            audience: target.audience,
            address: describeRecipient(target.recipient),
            locale: target.locale,
            name,
            middle,
            path: freeForm ? 'free_form' : 'template',
            body: freeForm ? freeFormBody : undefined,
          });
          continue;
        }

        // THE LOCK. Claimed BEFORE the Graph API call, so a crash mid-send
        // costs this person their welcome rather than risking a second one —
        // the same trade-off both daily sends make, and a sharper one here
        // because there is no tomorrow to try again on.
        const claimed = await claimNotification(db, {
          kind: WELCOME_KIND,
          company_id: company.id,
          audience: target.audience,
          ...(target.audience === 'worker' ? { worker_id: target.id } : { profile_id: target.id }),
          notification_date: today,
          task_ids: [],
        });
        // 23505 on 0033's partial unique index: somebody else claimed this
        // person, in a concurrent invocation or a fifteen-minute-old one whose
        // ledger read raced this one. A no-op by construction.
        if (!claimed) continue;

        try {
          const delivery = await deliverWelcome({
            env: env!,
            recipient: target.recipient,
            freeForm,
            freeFormBody,
            templateLanguage: getCatalog(target.locale).reminders.templateLanguage,
            templateParams: [name, middle],
          });
          await resolveNotification(db, claimed.id, 'sent', {
            provider_message_id: delivery.providerMessageId,
          });
          logEvent('welcome.sent', {
            companyId: company.id,
            audience: target.audience,
            path: delivery.path,
            fellBack: delivery.fellBack,
          });
          if (target.audience === 'worker') welcomedCrew.push(target.name);
        } catch (err) {
          // One unreachable person must never abort the run — and the claim is
          // KEPT, deliberately. A 132001 means capo_welcome is not approved for
          // that locale, a 131026 means the number is not on WhatsApp: retrying
          // either every fifteen minutes forever would be a paid loop against a
          // wall. The failure is visible in notification_log; to force a retry,
          // delete that row.
          await resolveNotification(db, claimed.id, 'failed', { error: describeSendError(err) });
          logEvent('welcome.send_failed', {
            companyId: company.id,
            audience: target.audience,
            error: describeSendError(err),
          });
        }
      }

      // ── the chat thread ──────────────────────────────────────────────────
      // Written ONLY when this run actually welcomed somebody, which makes it
      // idempotent for free: `messages` has no unique constraint, and every
      // welcome is claimed once ever, so a run that welcomed nobody has nothing
      // to say and a later run cannot repeat what this one said.
      //
      // Deliberately no "nobody was welcomed today" note, unlike the morning
      // briefing's targets === 0 branch. There, silence means a whole company
      // is unreachable and is worth saying; here it is the steady state — most
      // days nobody new joins a crew.
      if (welcomedCrew.length > 0 && !dryRun) {
        const eventLocale = await readThreadLocale(db, company.id, audience.companyLocale);
        await recordThreadEvent(db, {
          companyId: company.id,
          source: 'welcome',
          text: renderWelcomeEvent(welcomedCrew.length, welcomedCrew, eventLocale),
        });
      }

      report.push({
        company: company.name,
        pending: audience.pending.length,
        attempted: batch.length,
        alreadyWelcomed: audience.alreadyWelcomed,
        excludedNoConsent: audience.excludedNoConsent,
        excludedUnreachable: audience.excludedUnreachable,
        excludedInactive: audience.excludedInactive,
        excludedManagers: audience.excludedManagers,
        sends,
      });
    } catch (err) {
      // A broken company must not stop the rest of the estate.
      console.error(`cron/welcome: company ${company.id} failed:`, err);
      logEvent('welcome.company_failed', { companyId: company.id, error: describeSendError(err) });
      report.push({ company: company.name, error: describeSendError(err) });
    }
  }

  // The one line that makes "the sweep stopped running" falsifiable, exactly as
  // `dashboard.push_swept` does for the push backstop. Every other log line in
  // this route is conditional on somebody being welcomed, and most days nobody
  // is — so without this, a healthy idle sweep and a route that has not been
  // invoked for a week look identical.
  if (!dryRun) logEvent('welcome.swept', { companies: companies.length });
  return NextResponse.json({ dryRun, date: today, lisbonHour: hour, companies: report });
}

// ── KNOWN AND NOT FIXED ─────────────────────────────────────────────────────
//
// A crew member added and consented between midnight and 07:00 gets their first
// 07:00 briefing BEFORE their welcome, because the briefing's window opens two
// hours earlier than this one. They are introduced to Capo by a list of tasks
// and then told who Capo is. Fixing it properly means the briefing consulting
// the welcome ledger, which would put a second reader on this route's lock and
// couple the morning send to a feature that has nothing to do with it. The
// window it applies to is small (added, consented AND swept, all inside seven
// overnight hours) and the failure is cosmetic.
