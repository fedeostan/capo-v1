import { createHmac, timingSafeEqual } from 'node:crypto';
import { after, NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@capo/db/client';
import { handleInbound } from '@capo/core/agent';
import { whatsappSink } from '@capo/core/channels/whatsapp';

// WhatsApp manager channel — Meta Cloud API webhook (see
// docs/whatsapp-cloud-api-runbook.md for the one-time Meta setup).
//
// This is a SYSTEM path: there is no user session. The structural boundary is
// the X-Hub-Signature-256 HMAC (app secret) on every POST; tenant resolution
// is sender phone → profiles.phone (unique E.164) → company_id, never
// anything from the message body. Unknown senders are a silent no-op — no
// reply, no error detail, nothing persisted.
//
// All secrets are read lazily inside the handlers (never at module scope):
//   WHATSAPP_VERIFY_TOKEN   — GET verification challenge
//   WHATSAPP_APP_SECRET     — POST signature verification
//   WHATSAPP_ACCESS_TOKEN   — outbound sends (Meta System User, never expires)
//   WHATSAPP_PHONE_NUMBER_ID — the shared business number

// Webhook verification challenge: Meta calls this once when the webhook URL
// is registered (and on re-verification).
export async function GET(request: NextRequest) {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!verifyToken) return new NextResponse('whatsapp not configured', { status: 503 });

  const params = request.nextUrl.searchParams;
  if (params.get('hub.mode') === 'subscribe' && params.get('hub.verify_token') === verifyToken) {
    return new NextResponse(params.get('hub.challenge') ?? '', { status: 200 });
  }
  return new NextResponse('verification failed', { status: 403 });
}

interface WhatsAppMessage {
  from: string; // wa_id: digits, no '+'
  id: string;
  type: string;
  text?: { body: string };
}

interface WhatsAppWebhookBody {
  entry?: {
    changes?: {
      value?: {
        messages?: WhatsAppMessage[];
      };
    }[];
  }[];
}

// Meta's free test-tier "allowed recipients" list stores Buenos Aires
// (area code 11) mobile numbers in the legacy domestic format (54 + area
// code + 15 + local number) rather than the wa_id's modern format
// (54 + 9 + area code + local number). Sending to the wa_id directly is
// rejected with "(#131030) Recipient phone number not in allowed list"
// even though it's the same number and inbound matching (above) works
// fine. This is a test-tier-only quirk — a verified production number has
// no allow-list, so this becomes a no-op once the pilot graduates. Buenos
// Aires only for now; extend the regex if a non-11 area code joins.
function testTierArSendTarget(waId: string): string {
  const match = /^549(\d{2})(\d{8})$/.exec(waId);
  return match ? `54${match[1]}15${match[2]}` : waId;
}

function signatureValid(raw: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(raw).digest('hex');
  const provided = header.slice('sha256='.length);
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!appSecret || !accessToken || !phoneNumberId) {
    return new NextResponse('whatsapp not configured', { status: 503 });
  }

  // HMAC over the RAW body — parse only after the signature holds.
  const raw = await request.text();
  if (!signatureValid(raw, request.headers.get('x-hub-signature-256'), appSecret)) {
    return new NextResponse('invalid signature', { status: 401 });
  }

  let body: WhatsAppWebhookBody;
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse('invalid payload', { status: 400 });
  }

  // Meta batches; anything that isn't an inbound text message (delivery
  // statuses, reactions, media we don't handle yet) is acked and ignored.
  const inbound = (body.entry ?? [])
    .flatMap(entry => entry.changes ?? [])
    .flatMap(change => change.value?.messages ?? [])
    .filter(message => message.type === 'text' && message.text?.body);

  const db = getDb();
  for (const message of inbound) {
    // wa_id is digits-only; profiles.phone is E.164 with '+'.
    const { data: profile } = await db
      .from('profiles')
      .select('company_id')
      .eq('phone', `+${message.from}`)
      .maybeSingle();

    if (!profile) {
      // Safe no-op: don't reveal whether a number is known, don't reply.
      console.warn(`whatsapp: inbound from unknown number (wa_id ending …${message.from.slice(-4)}), ignoring`);
      continue;
    }

    const text = message.text!.body;
    const companyId = profile.company_id;

    // Ack Meta fast (retries + duplicate delivery kick in otherwise); the
    // agent loop runs after the response, within the function's maxDuration.
    after(async () => {
      try {
        const { sink, delivery } = whatsappSink({
          accessToken,
          phoneNumberId,
          to: testTierArSendTarget(message.from),
        });
        await handleInbound(db, companyId, { channel: 'whatsapp', text }, sink);
        await delivery;
      } catch (err) {
        console.error(`whatsapp: failed handling message ${message.id}:`, err);
      }
    });
  }

  return NextResponse.json({ received: true });
}
