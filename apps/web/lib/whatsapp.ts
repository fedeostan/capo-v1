import type { WhatsAppRecipient, WhatsAppSendConfig } from '@capo/core/channels/whatsapp';

// Shared WhatsApp wiring for the two routes that talk to Meta: the inbound
// webhook (api/whatsapp) and the daily reminder cron (api/cron/reminders).
//
// Env is read lazily, inside functions — never at module scope. A module-scope
// read breaks `next build` in CI, where these secrets are absent.

export interface WhatsAppEnv {
  accessToken: string;
  phoneNumberId: string;
}

/** The two vars needed to SEND. Null when the channel is not configured. */
export function whatsappSendEnv(): WhatsAppEnv | null {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return accessToken && phoneNumberId ? { accessToken, phoneNumberId } : null;
}

/**
 * E.164 (as stored in profiles.phone / workers.phone) → Meta's wa_id format
 * (digits, no '+').
 *
 * The inbound webhook receives a wa_id and adds the '+' to match the DB; the
 * cron starts from the DB and has to go the other way. Getting this backwards
 * fails as a 131026 ("message undeliverable"), which reads like a recipient
 * problem rather than a formatting one.
 *
 * This used to also rewrite Argentine numbers from the wa_id's modern
 * `549 <area> <local>` form into the legacy `54 <area> 15 <local>` form, which
 * is how Meta's free test-tier allow-list stored them — sending to the wa_id
 * directly was rejected with a 131030. That rewrite is gone with the test tier:
 * a verified production number has no allow-list, and the legacy form is not a
 * valid wa_id, so keeping it would have broken every send to a `+549…` manager.
 * Do not reintroduce it; if a 131030 ever reappears it means something else.
 *
 * DELIBERATELY NOT EXPORTED. This is digit surgery on a PHONE NUMBER, and a
 * BSUID (PT.13491208655302741918) must never reach it — stripping a leading '+'
 * from one is meaningless, and the value would then be posted in `to`, where
 * Meta rejects it. The only way to build a phone recipient is phoneRecipient()
 * below, which calls this; the only way to build a BSUID recipient is
 * bsuidRecipient(), which cannot. That is the requirement "encode it in the
 * types, not in a comment", made structural: with no export there is no call
 * site left to get wrong.
 */
function toSendTarget(e164: string): string {
  return e164.replace(/^\+/, '');
}

/** Address a stored E.164 phone. The '+' is stripped here and only here. */
export function phoneRecipient(e164: string): WhatsAppRecipient {
  return { kind: 'phone', waId: toSendTarget(e164) };
}

/**
 * Address a stored BSUID — someone who has adopted a WhatsApp username, so Meta
 * no longer tells us their number. Passed through verbatim: a BSUID is not a
 * phone number and has no formatting to normalise.
 */
export function bsuidRecipient(userId: string): WhatsAppRecipient {
  return { kind: 'bsuid', userId };
}

/**
 * Prefer the phone, fall back to the BSUID, null when neither is usable.
 *
 * ONE definition of that preference, shared by every proactive send, for the
 * same reason hasWhatsAppConsent is shared: two copies of an addressing rule
 * would eventually disagree, and the symptom would be one send reaching a
 * worker while the other silently skipped them.
 *
 * Phone FIRST even for someone who has adopted a username. Adopting one stops
 * Meta from telling US their number; it does not stop the number we already
 * stored from working. The BSUID branch is what covers a person who never gave
 * us a number, or whose stored one has gone dead.
 */
export function recipientFor(row: {
  phone?: string | null;
  whatsapp_user_id?: string | null;
}): WhatsAppRecipient | null {
  if (row.phone) return phoneRecipient(row.phone);
  if (row.whatsapp_user_id) return bsuidRecipient(row.whatsapp_user_id);
  return null;
}

/**
 * How a send is labelled in dry_run output and in logs: the kind, then the last
 * four characters. The kind is the point — without it an operator cannot tell a
 * send that would go to a phone from one that would go to a BSUID, which is the
 * only pre-flight visibility they have.
 */
export function describeRecipient(recipient: WhatsAppRecipient): string {
  return recipient.kind === 'phone'
    ? `phone:…${recipient.waId.slice(-4)}`
    : `bsuid:…${recipient.userId.slice(-4)}`;
}

export function sendConfigFor(env: WhatsAppEnv, recipient: WhatsAppRecipient): WhatsAppSendConfig {
  return { accessToken: env.accessToken, phoneNumberId: env.phoneNumberId, recipient };
}

// The consent predicate lives in @capo/core because BOTH sides need it and they
// must never disagree: the crons decide whether to send with it, and
// list_workers reports `recebe_whatsapp` with it. Re-exported here so the web
// app's WhatsApp callers keep one import.
export { hasWhatsAppConsent } from '@capo/core/channels/whatsapp';
