/**
 * The `wa.me` link a freshly signed-up manager taps (mobile) or scans (desktop)
 * to start their first WhatsApp conversation with Capo — issue #84.
 *
 * PURE on purpose: no env read, no network, no React. The business number is a
 * parameter rather than a `process.env` read inside here, so this file can be
 * imported by `scripts/whatsapp-check.mts` with no credentials and no
 * configuration, and so the env-read rule (inside the request, never at module
 * scope) stays the caller's problem and lives in exactly one place.
 *
 * ── Why this does its own digit-stripping ─────────────────────────────────
 * `toSendTarget` in ./whatsapp.ts does the same '+'-stripping and is
 * deliberately UNEXPORTED, so that no BSUID (`PT.13491208655302741918`) can
 * ever reach phone-digit surgery — a BSUID belongs in a `recipient` field, and
 * a BSUID stripped and placed in a `to` field addresses a stale number while
 * reporting success. Exporting it for this file would reopen exactly that door.
 *
 * So this builder validates E.164 FIRST and returns null for anything else,
 * which refuses a BSUID structurally rather than by convention: the shape has a
 * dot and letters and can never match. `pnpm whatsapp-check` pins that.
 */

/** WhatsApp's own click-to-chat host. Not configurable — it is Meta's. */
const WA_ME = 'https://wa.me';

/**
 * Build the click-to-chat URL, or null when `businessNumber` is not a phone
 * number we can address.
 *
 * Null rather than a throw: the only caller is a page in the middle of signup,
 * and the right answer to "this deployment has no business number configured"
 * is to skip the screen quietly, not to 500 the last step of onboarding.
 *
 * @param businessNumber Capo's own number in E.164 (`+351911097383`). Spaces,
 *   dashes, dots and brackets are tolerated because a human may paste it into
 *   an env var; the leading '+' is mandatory, matching `composeE164` /
 *   `canonicalizeE164` in `packages/core/src/channels/phone.ts`.
 * @param text What WhatsApp pre-fills into the composer. The manager can edit
 *   it before sending — this is an opening offer, not a submission.
 */
export function buildWhatsAppLink(businessNumber: string, text: string): string | null {
  const compact = businessNumber.replace(/[\s\-().]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(compact)) return null;
  // encodeURIComponent, not encodeURI: the text contains '?' and may contain
  // '&', either of which would truncate the message if left raw in a query.
  return `${WA_ME}/${compact.slice(1)}?text=${encodeURIComponent(text)}`;
}
