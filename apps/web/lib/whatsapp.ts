import type { WhatsAppSendConfig } from '@capo/core/channels/whatsapp';

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
 */
export function toSendTarget(e164: string): string {
  return e164.replace(/^\+/, '');
}

export function sendConfigFor(env: WhatsAppEnv, to: string): WhatsAppSendConfig {
  return { accessToken: env.accessToken, phoneNumberId: env.phoneNumberId, to };
}

// The consent predicate lives in @capo/core because BOTH sides need it and they
// must never disagree: the crons decide whether to send with it, and
// list_workers reports `recebe_whatsapp` with it. Re-exported here so the web
// app's WhatsApp callers keep one import.
export { hasWhatsAppConsent } from '@capo/core/channels/whatsapp';
