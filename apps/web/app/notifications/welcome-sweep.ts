import { getCatalog } from '@capo/i18n/catalog';
import type { Db } from '@capo/db/client';
import {
  hiPayload,
  isOutsideWindowError,
  sendWhatsAppButtons,
  sendWhatsAppTemplate,
  sendWhatsAppText,
  WhatsAppSendError,
  withinFreeFormWindow,
  type WhatsAppRecipient,
} from '@capo/core/channels/whatsapp';
import { describeRecipient, sendConfigFor, whatsappSendEnv, type WhatsAppEnv } from '../../lib/whatsapp';
import { logEvent } from '../../lib/log';
import {
  billableCompanies,
  claimNotification,
  describeSendError,
  readLisbonClock,
  resolveNotification,
  sendWindowEnd,
  withinSendWindow,
} from '../../lib/cron';
import { welcomeTemplateFor } from '../../lib/welcome-template';
import { welcomeWindowFor, type WelcomeWindow } from '../../lib/welcome-window';
import {
  loadPendingWelcomes,
  renderWelcome,
  renderWelcomeEvent,
  renderWelcomeFreeForm,
  WELCOME_KIND,
} from './welcome';
import { readThreadLocale, recordThreadEvent } from './thread';

// ── THE WELCOME, IN ONE PLACE (issue #45, and the immediate trigger) ─────────
//
// "We need a welcome to Capo as soon as a number is added to the system."
//
// This file is the whole send: who is owed a welcome, the quiet-hours gate, the
// claim, the envelope, the thread note. It exists as its own module because
// there are now TWO ways to start it and only one of them is a cron:
//
//   'cron'      — /api/cron/welcome, every fifteen minutes, every company,
//                 Lisbon 09:00-19:59. Unchanged in every observable way.
//   'immediate' — called from after() on the four request paths where a
//                 manager can have just added somebody or recorded a consent.
//                 One company, and a WIDER gate (Lisbon 08:00-21:59).
//
// ── THE SWEEP IS STILL THE MECHANISM. THE TRIGGER IS AN OPTIMISATION ────────
// This is the same relationship dispatchPushes has with /api/cron/push, and it
// is the reason the trigger is allowed to be as careless as it is. A number
// entering the system is not the moment Capo may use it — a recorded WhatsApp
// opt-in is (0025) — and the two happen at different times through five
// different doors: the onboarding form, the crew card on /perfil, Capo's
// guarded add_worker and update_worker tools, an approved card, and a worker
// replying START. A hook per door is a door somebody forgets, silently.
//
// So the function below asks a QUESTION instead of remembering an event: "who
// may be messaged and has never been introduced?". Every door leads to it, no
// door has to know it exists, and consent recorded three weeks late is picked
// up on the next run. Delete every immediate call site and the product still
// welcomes everybody, just later. Add a sixth door and it needs no hook at all.
//
// ── SYSTEM PATH ─────────────────────────────────────────────────────────────
// No user session, service-role client, acts across tenants. The cron's
// structural gate is its CRON_SECRET bearer token; the immediate caller's is
// that it has already authenticated the manager whose company id it passes,
// and that this function will not send to a company outside billableCompanies
// whatever it is handed.

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

export interface WelcomeSweepOptions {
  /** Restrict the run to one company. The immediate trigger always sets it. */
  companyId?: string;
  window: WelcomeWindow;
  /** Render everything, send nothing, write nothing, and ignore the hour gate. */
  dryRun?: boolean;
}

export type WelcomeSweepOutcome =
  | { status: 'ledger_not_ready'; error: string }
  | { status: 'clock_unavailable' }
  | { status: 'not_configured' }
  | { status: 'company_read_failed'; error: string }
  | { status: 'outside_window'; lisbonHour: number; sendHour: number; windowEnd: number }
  | {
      status: 'ran';
      date: string;
      lisbonHour: number;
      /** How many people were actually sent a welcome across the whole run. */
      welcomed: number;
      companies: unknown[];
    };

interface WelcomeDelivery {
  path: 'free_form' | 'template';
  providerMessageId: string | null;
  /** A free-form attempt was refused as out-of-window and the template picked
   *  it up — meaning the stored `last_inbound_at` and Meta's own view of the
   *  window disagreed. Logged, because it is the only way to see that. */
  fellBack: boolean;
  /** Whether the message the person received carries the "Say hi" button. */
  button: boolean;
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
 * ── THE BUTTON RIDES BOTH ENVELOPES, BY TWO DIFFERENT MECHANISMS ────────────
 * Free-form, it is an interactive reply button, which needs no approval from
 * anybody and is therefore always available. As a template it needs
 * capo_welcome_v2 approved in that specific locale, so welcomeTemplateFor is
 * consulted and a locale still waiting falls back to the button-less
 * capo_welcome. The two must be decided TOGETHER — a button component against
 * a template that declares none is a 132000 on every send — which is why the
 * name and `hasButton` come back from one call.
 *
 * Both attempts sit inside the caller's SINGLE notification_log claim. One
 * person, one claim, forever.
 */
async function deliverWelcome(args: {
  env: WhatsAppEnv;
  recipient: WhatsAppRecipient;
  freeForm: boolean;
  freeFormBody: string;
  buttonLabel: string;
  templateLanguage: string;
  templateParams: [string, string];
}): Promise<WelcomeDelivery> {
  const config = sendConfigFor(args.env, args.recipient);
  const chosen = welcomeTemplateFor(args.templateLanguage);
  const template = async (): Promise<WelcomeDelivery> => {
    const { providerMessageId } = await sendWhatsAppTemplate(
      {
        name: chosen.name,
        languageCode: args.templateLanguage,
        bodyParams: args.templateParams,
        // Present ONLY for the name that declares the button. Omitted, the
        // payload is byte-identical to what this path has always sent.
        ...(chosen.hasButton ? { quickReplies: [{ payload: hiPayload() }] } : {}),
      },
      config,
    );
    return { path: 'template', providerMessageId, fellBack: false, button: chosen.hasButton };
  };

  if (!args.freeForm) return await template();

  try {
    await sendWhatsAppButtons(
      { body: args.freeFormBody, buttons: [{ id: hiPayload(), title: args.buttonLabel }] },
      config,
    );
    return { path: 'free_form', providerMessageId: null, fellBack: false, button: true };
  } catch (err) {
    // Caught NARROWLY, by Meta's error code. Any other failure means the send
    // is genuinely broken, and re-sending it as a template would spend money to
    // reach the same wall.
    if (isOutsideWindowError(err)) {
      const sent = await template();
      return { ...sent, fellBack: true };
    }
    // Meta rejected OUR interactive payload — a 4xx that is not the window.
    // Plain text says everything the buttoned version said except "tap here",
    // so it is strictly better than a template (free) and far better than
    // silence. Anything else is rethrown: a socket reset may have delivered
    // the buttons already, and falling through would welcome somebody twice.
    // Same narrowing, for the same reason, as sendWorkerDayDetail's.
    const rejected =
      err instanceof WhatsAppSendError && err.status >= 400 && err.status < 500;
    if (!rejected) throw err;
    logEvent('welcome.buttons_rejected', { error: describeSendError(err) });
    const { providerMessageId } = await sendWhatsAppText(args.freeFormBody, config);
    return { path: 'free_form', providerMessageId, fellBack: false, button: false };
  }
}

/**
 * The whole welcome run, for one company or for every billable company.
 *
 * Returns rather than throws for every expected refusal, so the cron route can
 * turn each into its own status code and the immediate trigger can log one and
 * carry on. A genuinely broken company still cannot stop the rest of the
 * estate: that catch is per company, inside the loop.
 */
export async function runWelcomeSweep(db: Db, opts: WelcomeSweepOptions): Promise<WelcomeSweepOutcome> {
  const dryRun = opts.dryRun ?? false;

  // ── THE DEPLOY GATE ───────────────────────────────────────────────────────
  // 0033 adds two things: the partial unique index that makes a welcome
  // once-per-person-EVER, and the backfill that marks everybody who already
  // exists as already introduced. Without them this would introduce Capo, by
  // paid template, to every crew member and every manager already using it.
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
    return { status: 'ledger_not_ready', error: ledgerError.message };
  }

  const clock = await readLisbonClock(db, 'welcome-sweep');
  if (!clock) return { status: 'clock_unavailable' };
  const { hour, today } = clock;

  // The ONE difference between the two ways in. Everything below this line is
  // the same code for both, which is the point of the refactor: a bug fixed in
  // the sweep is fixed for the trigger and the other way round.
  const { sendHour, windowHours } = welcomeWindowFor(opts.window);
  const windowEnd = sendWindowEnd(sendHour, windowHours);
  if (!dryRun && !withinSendWindow(hour, sendHour, windowHours)) {
    // Logged, not just returned — a rejected invocation leaves no other trace
    // anywhere, which is how a broken schedule stays invisible. On the
    // immediate path it is also the only way to see that somebody was added at
    // 23:00 and is waiting for 09:00, which looks exactly like a bug from the
    // outside.
    logEvent('welcome.outside_send_hour', { lisbonHour: hour, sendHour, windowEnd, window: opts.window });
    return { status: 'outside_window', lisbonHour: hour, sendHour, windowEnd };
  }

  const env = whatsappSendEnv();
  if (!env && !dryRun) return { status: 'not_configured' };

  // ONE `now` for the whole invocation, for the same reason /api/cron/reminders
  // freezes it: a run across a large estate takes minutes, and two people with
  // identical inbound times must not be classified differently.
  const now = Date.now();

  let companies;
  try {
    companies = await billableCompanies(db);
  } catch (err) {
    console.error('welcome sweep:', describeSendError(err));
    return { status: 'company_read_failed', error: describeSendError(err) };
  }
  // Filtered here rather than in the query, deliberately: billableCompanies is
  // the subscription gate every proactive send passes through, and an immediate
  // trigger handed a company id must not be able to reach past it. An id that
  // is not billable simply matches nothing.
  if (opts.companyId) companies = companies.filter(c => c.id === opts.companyId);

  const report: unknown[] = [];
  let welcomed = 0;

  for (const company of companies) {
    try {
      const audience = await loadPendingWelcomes(db, company, today);
      const batch = audience.pending.slice(0, MAX_PER_COMPANY_PER_RUN);
      const sends: unknown[] = [];
      // Crew names ONLY, and every one of them typed by the MANAGER on /perfil
      // or dictated to Capo. Never a word a crew member wrote — see
      // notifications/thread.ts.
      const welcomedCrew: string[] = [];

      // The dominant reason somebody is not welcomed, and the one a manager can
      // actually act on: a number on file that nobody has agreed to.
      //
      // Logged only on a run that actually sends, deliberately. The cron wakes
      // up ninety-six times a day and this count does not change between runs,
      // so logging it unconditionally would write the same line every fifteen
      // minutes forever and bury the lines that mean something.
      if (batch.length > 0 && audience.excludedNoConsent > 0) {
        logEvent('welcome.workers_no_consent', {
          companyId: company.id,
          excluded: audience.excludedNoConsent,
        });
      }

      for (const target of batch) {
        const [name, middle] = renderWelcome(target, company.name, audience.managerName);
        const freeForm = withinFreeFormWindow(target.lastInboundAt, now);
        const freeFormBody = renderWelcomeFreeForm(target, company.name, audience.managerName);
        const t = getCatalog(target.locale).reminders;

        if (dryRun) {
          sends.push({
            audience: target.audience,
            address: describeRecipient(target.recipient),
            locale: target.locale,
            name,
            middle,
            path: freeForm ? 'free_form' : 'template',
            template: freeForm ? undefined : welcomeTemplateFor(t.templateLanguage).name,
            body: freeForm ? freeFormBody : undefined,
          });
          continue;
        }

        // THE LOCK. Claimed BEFORE the Graph API call, so a crash mid-send
        // costs this person their welcome rather than risking a second one —
        // the same trade-off both daily sends make, and a sharper one here
        // because there is no tomorrow to try again on.
        //
        // It is also what makes the immediate trigger safe to fire as often as
        // it likes: a run racing the cron, or four call sites racing each other
        // inside one request, all lose to 0033's partial unique index. Nothing
        // anywhere in this feature is made idempotent by app state.
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
            buttonLabel: t.welcomeButton,
            templateLanguage: t.templateLanguage,
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
            button: delivery.button,
            window: opts.window,
          });
          welcomed += 1;
          if (target.audience === 'worker') welcomedCrew.push(target.name);
        } catch (err) {
          // One unreachable person must never abort the run. The claim is kept
          // for the rest of TODAY — 0016's daily unique key refuses a second
          // one per person per day — but since 0041 a 'failed' row releases
          // the once-EVER lock, and loadPendingWelcomes' retry policy decides
          // what happens next (issue #121): a retryable code like 132001
          // (the template not approved for that locale — fixable) earns one
          // more attempt a day, up to WELCOME_MAX_ATTEMPTS ever; a permanent
          // one like 131026 (the number is not on WhatsApp) or anything
          // unclassifiable never does. To force a retry past that policy,
          // delete the person's failed welcome rows.
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
      // to say and a later run cannot repeat what this one said. That property
      // is what lets the immediate trigger reuse this code untouched.
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
        excludedFailed: audience.excludedFailed,
        sends,
      });
    } catch (err) {
      // A broken company must not stop the rest of the estate.
      console.error(`welcome sweep: company ${company.id} failed:`, err);
      logEvent('welcome.company_failed', { companyId: company.id, error: describeSendError(err) });
      report.push({ company: company.name, error: describeSendError(err) });
    }
  }

  return { status: 'ran', date: today, lisbonHour: hour, welcomed, companies: report };
}
