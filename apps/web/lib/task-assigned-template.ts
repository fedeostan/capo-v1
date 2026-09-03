// Which Meta locales `capo_task_assigned` is approved in (issue W7).
//
// Same shape, and the same reasoning, as lib/briefing-template.ts: Meta
// approves a template PER name+language pair, naming an unapproved one is a
// 132001 refusal at send time, and approval state lives in a dashboard rather
// than in this repository. So it is a hand-maintained constant that is wrong in
// a BOUNDED way when it lags, never a Graph API lookup in front of a send.
//
// ── IT STARTS EMPTY, AND THAT IS THE SAFE DIRECTION ────────────────────────
// The template is submitted by scripts/whatsapp-template.mts and reviewed by
// Meta asynchronously — minutes to days. Until a locale appears below, a crew
// member OUTSIDE their 24-hour window gets NOTHING when they are assigned a
// task, and the notice is stamped `template_unapproved`. They still get the
// task in tomorrow's 07:00 briefing, which is exactly the product this feature
// improves on rather than replaces. Flipping a locale on too early costs a
// per-recipient 132001 and a `failed` notification_log row; leaving it off
// costs one late message. The second failure is the cheaper one.
//
// To update: `pnpm whatsapp-template status` prints the live approval state.
// When a locale shows capo_task_assigned as APPROVED, add its code below.
//
// Pure and dependency-free so `pnpm whatsapp-check` can assert the switch.

/** Meta locale codes (`reminders.templateLanguage`) whose template is APPROVED. */
export const TASK_ASSIGNED_APPROVED_LANGUAGES: ReadonlySet<string> = new Set<string>();

/** May we send the paid assignment template to a recipient on this locale? */
export function taskAssignedTemplateApproved(templateLanguage: string): boolean {
  return TASK_ASSIGNED_APPROVED_LANGUAGES.has(templateLanguage);
}
