import type { Db } from '@capo/db/client';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { isHiPayload, sendWhatsAppText, WhatsAppSendError, type WhatsAppSendConfig } from '@capo/core/channels/whatsapp';
import { logEvent } from '../../lib/log';
import { siteUrl } from '../../lib/site-url';
import { dayLinkUrl, mintDayLinks } from '../../lib/day-link';
import { loadWorkerBriefing, renderWorkerFreeForm } from './briefing';

// ── THE "SAY HI" TAP (issue #45 follow-up) ──────────────────────────────────
//
// The welcome now ends in a button rather than in silence, and this is what
// answers it. Zero model calls, in front of both agents, same family as the
// check-in tap and the guided menu: the cheap deterministic thing happens in
// front of the model, never instead of it.
//
// ── THE TAP ARRIVES ON TWO DIFFERENT FIELDS ────────────────────────────────
// The welcome has two envelopes, so its one button has two shapes:
//
//   template capo_welcome_v2  → `type: 'button'`,      `button.payload`
//   free-form interactive     → `type: 'interactive'`, `interactive.button_reply.id`
//
// Same payload (`capo:hi`) on both, so there is one fact and one handler.
// isHiTap is where that is read, and it is deliberately the FIRST thing both
// the worker and the manager branch consult: a `capo:hi` reaching
// handleCheckinTap would log `whatsapp.unknown_checkin_payload` — the log line
// that is supposed to mean "the check-in template went out without its button
// component", the single most likely silent failure in that feature — and a
// `capo:hi` reaching the manager's approval branch would log
// `whatsapp.unknown_button`. Both would be false alarms in the one log a human
// actually greps.
//
// ── THE ANSWER IS THEIR OWN WORK, NOT A TOUR ───────────────────────────────
// A crew member who taps hello is told hello, told they can just write, and
// then shown what they are doing today — through the SAME renderer the 07:00
// message uses, so the two cannot disagree about what a task says. A person who
// has nothing on today is told when the next message arrives, because an empty
// first answer reads as "this thing does nothing".
//
// The tap opened Meta's free 24-hour window, so every send here is ordinary
// text and costs nothing. It follows that a failure must never be answered with
// a template: 131047 is logged and swallowed, exactly as the OK/DETALHE reply
// does, because silence is the safe direction and a paid recovery send for a
// greeting is not.

/** Did this inbound message carry the welcome's one button, in either shape? */
export function isHiTap(message: {
  type?: string;
  button?: { payload?: string };
  interactive?: { button_reply?: { id?: string } };
}): boolean {
  if (message.type === 'button') return isHiPayload(message.button?.payload);
  if (message.type === 'interactive') return isHiPayload(message.interactive?.button_reply?.id);
  return false;
}

/**
 * Answer a CREW member's tap: hello by name, one line about writing back, and
 * today's work.
 *
 * Never throws. Everything below the greeting is best-effort, and a crew member
 * who taps hello and gets a hello has already had the point of the button.
 */
export async function answerWorkerHi(
  db: Db,
  worker: { id: string; company_id: string; name: string; language: string | null },
  locale: Locale,
  sendConfig: WhatsAppSendConfig,
): Promise<void> {
  const t = getCatalog(locale).whatsapp;
  const opening = [t.hiWorkerGreeting(worker.name), t.hiWorkerWriteAnyTime].join('\n\n');
  try {
    const briefing = await loadWorkerBriefing(db, {
      companyId: worker.company_id,
      workerId: worker.id,
      name: worker.name,
      recipient: sendConfig.recipient,
      locale,
      hasChosenLanguage: !!worker.language,
    });

    // One clock: the same lisbon_today() the cron and the /dia page read. A
    // failed clock costs the link line, never the reply — same posture as
    // mintDayLinks itself, which swallows every failure into a Map of nothing.
    const { data: today } = await db.rpc('lisbon_today');
    const links = today
      ? await mintDayLinks(db, { companyId: worker.company_id, workerIds: [worker.id], today })
      : new Map<string, string>();
    const token = links.get(worker.id);

    const body = renderWorkerFreeForm(briefing, {
      opening,
      dayLinkUrl: token ? dayLinkUrl(token) : undefined,
    });
    // With no tasks the renderer says "nothing scheduled for today" and stops,
    // which on a FIRST message reads as a dead end. One line saying when the
    // next one arrives is the difference between "this does nothing" and "this
    // starts tomorrow at seven".
    const withNext = briefing.tasks.length === 0 ? `${body}\n\n${t.hiWorkerMorning}` : body;

    await sendWhatsAppText(withNext, sendConfig);
    logEvent('whatsapp.hi_answered', {
      companyId: worker.company_id,
      workerId: worker.id,
      audience: 'worker',
      tasks: briefing.tasks.length,
    });
  } catch (err) {
    if (err instanceof WhatsAppSendError && err.code === 131047) {
      // Outside the free-form window, which should be impossible: the tap that
      // reached us opened it seconds ago. Logged rather than recovered — the
      // only legal recovery is a paid template, and none of them says hello.
      logEvent('whatsapp.hi_window_expired', { companyId: worker.company_id, workerId: worker.id });
      return;
    }
    logEvent('whatsapp.hi_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      error: err instanceof Error ? err.message : String(err),
    });
    // Silence after a button OUR message asked them to press reads as "Capo is
    // broken" — the rule every other tap and keyword in this file follows. The
    // greeting alone still answers the tap.
    await sendWhatsAppText(opening, sendConfig).catch(() => {});
  }
}

/**
 * Answer a MANAGER's tap. One line and a pointer to the app.
 *
 * A manager gets the same welcome and the same button, but not the same answer:
 * their work is a board, not a task list, and reading it out over WhatsApp
 * would be a worse version of a screen they already have. Never throws.
 */
export async function answerManagerHi(
  companyId: string,
  locale: Locale,
  sendConfig: WhatsAppSendConfig,
): Promise<void> {
  const t = getCatalog(locale).whatsapp;
  try {
    await sendWhatsAppText(t.hiManager(siteUrl()), sendConfig);
    logEvent('whatsapp.hi_answered', { companyId, audience: 'manager' });
  } catch (err) {
    logEvent('whatsapp.hi_failed', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
