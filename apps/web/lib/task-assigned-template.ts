// Which Meta locales `capo_task_assigned` is approved in (issue W7).
//
// Same shape, and the same reasoning, as lib/briefing-template.ts: Meta
// approves a template PER name+language pair, naming an unapproved one is a
// 132001 refusal at send time, and approval state lives in a dashboard rather
// than in this repository. So it is a hand-maintained constant that is wrong in
// a BOUNDED way when it lags, never a Graph API lookup in front of a send.
//
// ── IT STARTS EMPTY, AND THAT IS THE SAFE DIRECTION ────────────────────────
// Submitted 3 September 2026; all three locales were PENDING review when this
// shipped (pt_PT 1859688468524905, es_ES 1603821794728431, en_US
// 28806849452245917). Meta reviews asynchronously — minutes to days. Until a
// locale appears below, a crew
// member OUTSIDE their 24-hour window gets NOTHING when they are assigned a
// task, and the notice is stamped `template_unapproved`. They still get the
// task in tomorrow's 07:00 briefing, which is exactly the product this feature
// improves on rather than replaces. Flipping a locale on too early costs a
// per-recipient 132001 and a `failed` notification_log row; leaving it off
// costs one late message. The second failure is the cheaper one.
//
// To update: `WHATSAPP_WABA_ID=715247827972608 ./node_modules/.bin/tsx
// scripts/whatsapp-template.mts status` prints the live approval state — the
// WABA id is required, see runbook §6d. When a locale shows capo_task_assigned
// as APPROVED, add its code below.
//
// Pure and dependency-free so `pnpm whatsapp-check` can assert the switch.

/** Meta locale codes (`reminders.templateLanguage`) whose template is APPROVED. */
// Verified against the live WABA on 2026-09-03: capo_task_assigned is APPROVED
// in pt_PT, es_ES and en_US (template ids 1859688468524905, 1603821794728431,
// 28806849452245917). Remove a code here to fall back to silence for that locale.
export const TASK_ASSIGNED_APPROVED_LANGUAGES: ReadonlySet<string> = new Set(['pt_PT', 'es_ES', 'en_US']);

/** May we send the paid assignment template to a recipient on this locale? */
export function taskAssignedTemplateApproved(templateLanguage: string): boolean {
  return TASK_ASSIGNED_APPROVED_LANGUAGES.has(templateLanguage);
}
