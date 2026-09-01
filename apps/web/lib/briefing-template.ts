// Which Meta template the 07:00 briefing goes out under, per locale (issue #108).
//
// `capo_daily_briefing_v2` is the line-broken body — greeting, blank line,
// {{2}}, blank line, opt-out — submitted alongside #108's knock. Meta approves
// a template PER name+language pair, so the switch-over is per locale too: a
// locale still waiting on approval must keep sending the old single-sentence
// template, because naming an unapproved template is a 132001 refusal at 07:00
// and a worker who hears nothing.
//
// ── WHY THIS IS A HARDCODED CONSTANT AND NOT A GRAPH API LOOKUP ─────────────
// Approval state lives in Meta's dashboard and could be asked for at send time
// — but that would put a network dependency and a brand-new failure mode in
// front of every morning send, to answer a question whose answer changes a
// handful of times ever. A constant is honest about what it is: a mirror of
// the dashboard, updated by hand, and wrong in a BOUNDED way when it lags.
// Flipping a locale too early is a per-recipient 132001 that the send loop
// already catches and logs as a `failed` notification_log row; flipping it too
// late sends the old, uglier template. Neither is silence.
//
// To update: `pnpm whatsapp-template status` prints the live approval state;
// when a locale shows capo_daily_briefing_v2 as APPROVED there, add its code
// below. State as of 2026-09-01: pt_PT APPROVED, en_US APPROVED, es_ES
// PENDING.
//
// Pure and dependency-free so `pnpm whatsapp-check` can assert the whole
// matrix, including that an unknown code falls back to the old name.

export type BriefingTemplateName = 'capo_daily_briefing' | 'capo_daily_briefing_v2';

/** Meta locale codes (`reminders.templateLanguage`) whose v2 is APPROVED. */
export const BRIEFING_V2_APPROVED_LANGUAGES: ReadonlySet<string> = new Set(['pt_PT', 'en_US']);

/**
 * The template name for one recipient. Keyed on the Meta locale code because
 * that is the unit Meta approves. Anything not explicitly approved — es_ES
 * today, and any code this file has never heard of — falls to the OLD
 * template, which has been approved in all three locales since #49.
 */
export function briefingTemplateFor(templateLanguage: string): BriefingTemplateName {
  return BRIEFING_V2_APPROVED_LANGUAGES.has(templateLanguage)
    ? 'capo_daily_briefing_v2'
    : 'capo_daily_briefing';
}
