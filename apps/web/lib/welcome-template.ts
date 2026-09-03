// Which Meta template the welcome goes out under, per locale.
//
// `capo_welcome_v2` is the same approved body as `capo_welcome` plus ONE
// quick-reply button ("Olá 👋"), so the first thing a crew member ever does
// with Capo can be a tap rather than a decision about what to type. Meta
// approves a template PER name+language pair, so the switch-over is per locale
// too: a locale still waiting on approval must keep sending the old
// button-less template, because naming an unapproved template is a 132001
// refusal and a person who hears nothing at all.
//
// ── THE ASYMMETRY THAT MAKES THIS DANGEROUS, AND WHY IT LIVES HERE ──────────
// A template send may declare a button component only when the APPROVED
// template declares the button. Get it wrong in either direction and nothing
// looks broken:
//   - a button component on capo_welcome (which has none) → 132000 on every
//     send, so nobody is welcomed at all;
//   - NO button component on capo_welcome_v2 → Meta accepts the send happily
//     and echoes the button's own LABEL back as the payload, so the tap comes
//     back as "Olá 👋" and parses as nothing.
// The name and the button therefore have to be decided TOGETHER, in one place,
// which is what welcomeTemplateFor returns.
//
// ── WHY THIS IS A HARDCODED CONSTANT AND NOT A GRAPH API LOOKUP ─────────────
// Exactly briefing-template.ts's reasoning, and it is deliberately the same
// shape: approval state lives in Meta's dashboard and could be asked for at
// send time, but that would put a network dependency and a brand-new failure
// mode in front of every send, to answer a question whose answer changes a
// handful of times ever. A constant is honest about what it is: a mirror of
// the dashboard, updated by hand, and wrong in a BOUNDED way when it lags.
// Flipping a locale too early is a per-recipient 132001 that the send loop
// already records as a `failed` notification_log row (and which #121's retry
// policy then re-attempts once a day); flipping it too late sends the old,
// button-less welcome. Neither is silence.
//
// To update: `pnpm whatsapp-template status` prints the live approval state;
// when a locale shows capo_welcome_v2 as APPROVED there, add its code below.
// State as of 2026-09-03: submitted and APPROVED in all three locales, checked
// against the live WABA the same afternoon (pt_PT 2214647296153003, es_ES
// 1539898150720126, en_US 2143674543236870). This set is therefore full, and
// the fallback below is a safety net rather than a live path — do not delete
// it: an unknown locale code, or a fourth language added to @capo/i18n before
// its template is approved, both land on it.
//
// Pure and dependency-free so `pnpm whatsapp-check` can assert the whole
// matrix, including that an unknown code falls back to the old name.

export type WelcomeTemplateName = 'capo_welcome' | 'capo_welcome_v2';

/** Meta locale codes (`reminders.templateLanguage`) whose v2 is APPROVED. */
export const WELCOME_V2_APPROVED_LANGUAGES: ReadonlySet<string> = new Set(['pt_PT', 'es_ES', 'en_US']);

/**
 * The template name for one recipient, and whether that name carries a button.
 * Keyed on the Meta locale code because that is the unit Meta approves.
 * Anything not explicitly approved falls to the OLD template, which has been
 * approved in all three locales since #45.
 */
export function welcomeTemplateFor(templateLanguage: string): {
  name: WelcomeTemplateName;
  hasButton: boolean;
} {
  return WELCOME_V2_APPROVED_LANGUAGES.has(templateLanguage)
    ? { name: 'capo_welcome_v2', hasButton: true }
    : { name: 'capo_welcome', hasButton: false };
}
