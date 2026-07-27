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

// Meta's free test-tier "allowed recipients" list stores Buenos Aires
// (area code 11) mobile numbers in the legacy domestic format (54 + area
// code + 15 + local number) rather than the wa_id's modern format
// (54 + 9 + area code + local number). Sending to the wa_id directly is
// rejected with "(#131030) Recipient phone number not in allowed list"
// even though it's the same number and inbound matching works fine. This is a
// test-tier-only quirk — a verified production number has no allow-list, so
// this becomes a no-op once the pilot graduates. Buenos Aires only for now;
// extend the regex if a non-11 area code joins.
export function testTierArSendTarget(waId: string): string {
  const match = /^549(\d{2})(\d{8})$/.exec(waId);
  return match ? `54${match[1]}15${match[2]}` : waId;
}

/**
 * E.164 (as stored in profiles.phone / workers.phone) → Meta's wa_id format
 * (digits, no '+'), with the test-tier fixup applied.
 *
 * The inbound webhook receives a wa_id and adds the '+' to match the DB; the
 * cron starts from the DB and has to go the other way. Getting this backwards
 * fails as a 131030, which looks exactly like "number not allow-listed".
 */
export function toSendTarget(e164: string): string {
  return testTierArSendTarget(e164.replace(/^\+/, ''));
}

export function sendConfigFor(env: WhatsAppEnv, to: string): WhatsAppSendConfig {
  return { accessToken: env.accessToken, phoneNumberId: env.phoneNumberId, to };
}
