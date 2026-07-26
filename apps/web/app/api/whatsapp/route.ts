import { createHmac, timingSafeEqual } from 'node:crypto';
import { after, NextResponse, type NextRequest } from 'next/server';
import { getDb, type Db } from '@capo/db/client';
import { handleInbound } from '@capo/core/agent';
import { MAX_AUDIO_BYTES, transcribeAudio } from '@capo/core/transcription';
import { coerceLocale, type Locale, type LocaleContext } from '@capo/i18n/locale';
import { getCatalog } from '@capo/i18n/catalog';
import { sendWhatsAppText, whatsappSink, type WhatsAppSinkConfig } from '@capo/core/channels/whatsapp';
import { downloadMedia } from '@capo/core/channels/whatsapp-media';
import { getBillingState } from '../../../lib/billing';
import { logEvent } from '../../../lib/log';
import { testTierArSendTarget, type WhatsAppEnv } from '../../../lib/whatsapp';

// WhatsApp manager channel — Meta Cloud API webhook (see
// docs/whatsapp-cloud-api-runbook.md for the one-time Meta setup).
//
// This is a SYSTEM path: there is no user session. The structural boundary is
// the X-Hub-Signature-256 HMAC (app secret) on every POST; tenant resolution
// is sender phone → profiles.phone (unique E.164) → company_id, never
// anything from the message body. Unknown senders are a silent no-op — no
// reply, no error detail, nothing persisted.
//
// Two kinds of sender, and only one of them reaches the agent:
//   profiles.phone → a MANAGER. Full agent loop, persisted to the thread.
//   workers.phone  → a WORKER replying to their 07:00 briefing. Acknowledged
//                    deterministically, never persisted, never given to the
//                    model. See handleWorkerReply.
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

// Media download + a Gemini transcription now sit IN FRONT OF a 12-step agent
// loop and the outbound Graph send, all inside after(). This route previously
// declared no maxDuration at all and inherited the platform default, while
// /api/chat declares 120 for the agent loop alone and /api/transcribe declares
// 60 for transcription alone. 300 is the honest sum.
//
// If a Vercel plan caps function duration below this, `next build` fails loudly
// — drop to 120 and accept a tighter tail rather than removing the declaration.
export const maxDuration = 300;

interface WhatsAppMessage {
  from: string; // wa_id: digits, no '+'
  id: string;
  type: string;
  text?: { body: string };
  // voice: true is a push-to-talk voice note; absent/false is an uploaded audio
  // file. Both are accepted — refusing a manager's own m4a of himself talking
  // would be user-hostile — but `voice` is logged so the split stays visible.
  audio?: { id: string; mime_type?: string; voice?: boolean };
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

// The whole worker-facing command surface: reply one of these, alone, and your
// briefing language changes. Deliberately not a chat — a worker's text never
// reaches the model (see handleWorkerReply), so this is a lookup, not a parse.
//
// Whole-message exact match only. A worker writing "es que falta material"
// must not be read as "switch to Spanish", and a substring match would do
// exactly that.
const LANGUAGE_KEYWORDS: Record<string, Locale> = {
  pt: 'pt-PT',
  'pt-pt': 'pt-PT',
  portugues: 'pt-PT',
  português: 'pt-PT',
  es: 'es-ES',
  'es-es': 'es-ES',
  espanol: 'es-ES',
  español: 'es-ES',
  en: 'en-US',
  'en-us': 'en-US',
  english: 'en-US',
  ingles: 'en-US',
  inglês: 'en-US',
};

function languageCommand(text: string | undefined): Locale | null {
  if (!text) return null;
  return LANGUAGE_KEYWORDS[text.trim().toLowerCase()] ?? null;
}

/**
 * A reply from a WORKER — someone with a row in `workers` but no account, no
 * profile, and no conversation with Capo.
 *
 * Returns true when the sender was recognised as a worker (handled, whatever
 * the outcome), false when they are genuinely unknown.
 *
 * Three deliberate limits:
 *   - The agent NEVER runs here and the text is NEVER persisted to `messages`.
 *     Worker text is third-party input; keeping it out of the thread keeps it
 *     out of the model's context window entirely.
 *   - `workers.phone` has no unique constraint (unlike `profiles.phone`), so
 *     two companies can hold the same number. On a collision we stay silent
 *     rather than guess a tenant.
 *   - The ack is not politeness. A template send does not open Meta's 24-hour
 *     window — only the recipient's reply does — so acknowledging a worker is
 *     what converts tomorrow's paid template into a free session message.
 */
async function handleWorkerReply(db: Db, message: WhatsAppMessage, env: WhatsAppEnv): Promise<boolean> {
  const waIdSuffix = message.from.slice(-4);
  const { data: matches, error } = await db
    .from('workers')
    .select('id, company_id, language, company:companies(language)')
    .eq('phone', `+${message.from}`)
    .eq('active', true)
    .limit(2);

  if (error) {
    console.error('whatsapp: worker lookup failed:', error.message);
    return false;
  }
  if (!matches || matches.length === 0) return false;
  if (matches.length > 1) {
    // Same number on two companies' crews. Answering either would leak which
    // tenant we picked, and picking is guesswork.
    logEvent('whatsapp.worker_ambiguous', { waIdSuffix, matches: matches.length });
    return true;
  }

  const worker = matches[0];
  const current = worker.language ? coerceLocale(worker.language) : coerceLocale(worker.company?.language);
  const requested = message.type === 'text' ? languageCommand(message.text?.body) : null;

  logEvent('whatsapp.worker_reply', {
    companyId: worker.company_id,
    workerId: worker.id,
    messageId: message.id,
    type: message.type,
    // The message body is deliberately NOT logged — it is third-party content.
    languageCommand: requested ?? undefined,
  });

  const sendConfig: WhatsAppSinkConfig = {
    accessToken: env.accessToken,
    phoneNumberId: env.phoneNumberId,
    to: testTierArSendTarget(message.from),
  };

  if (requested && requested !== current) {
    const { error: updateError } = await db.from('workers').update({ language: requested }).eq('id', worker.id);
    if (updateError) {
      console.error('whatsapp: worker language update failed:', updateError.message);
      return true;
    }
  }

  // Confirmation is always in the language the worker will get from now on.
  const locale = requested ?? current;
  const t = getCatalog(locale).whatsapp;
  await sendWhatsAppText(requested ? t.workerLanguageChanged : t.workerAck, sendConfig).catch(err => {
    logEvent('whatsapp.worker_ack_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return true;
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

  // Meta batches. Everything is collected here and triaged per message AFTER
  // sender resolution, so an unsupported type can be logged against a real
  // companyId. Previously this was a .filter() that dropped every non-text
  // message with no log line at all — a manager sending a voice note produced
  // literally zero observability.
  const inbound = (body.entry ?? [])
    .flatMap(entry => entry.changes ?? [])
    .flatMap(change => change.value?.messages ?? []);

  const db = getDb();
  for (const message of inbound) {
    // wa_id is digits-only; profiles.phone is E.164 with '+'.
    const { data: profile } = await db
      .from('profiles')
      .select('id, company_id, language, company:companies(language)')
      .eq('phone', `+${message.from}`)
      .maybeSingle();

    if (!profile) {
      // Not a manager — but it may be a worker replying to their 07:00
      // briefing, which is the one other number we know. Runs after the ack so
      // the lookup and the ack send add no latency to Meta's webhook call.
      after(async () => {
        const handled = await handleWorkerReply(db, message, { accessToken, phoneNumberId });
        if (!handled) {
          // Safe no-op: don't reveal whether a number is known, don't reply.
          console.warn(`whatsapp: inbound from unknown number (wa_id ending …${message.from.slice(-4)}), ignoring`);
          logEvent('whatsapp.unknown_sender', { waIdSuffix: message.from.slice(-4) });
        }
      });
      continue;
    }

    const companyId = profile.company_id;
    const userId = profile.id;
    // Service role: auth.uid() is null on this path, so the locale cannot come
    // from RLS — it comes from the profile row matched by phone.
    const locales: LocaleContext = {
      user: coerceLocale(profile.language),
      company: coerceLocale(profile.company?.language),
    };

    // Triage. Images, documents, stickers, reactions, delivery statuses and
    // button replies are still acked and ignored — but now they leave a trace.
    if (message.type !== 'text' && message.type !== 'audio') {
      logEvent('whatsapp.unsupported_message', { companyId, messageId: message.id, type: message.type });
      continue;
    }
    if (message.type === 'text' && !message.text?.body) {
      logEvent('whatsapp.empty_text', { companyId, messageId: message.id });
      continue;
    }
    if (message.type === 'audio' && !message.audio?.id) {
      logEvent('whatsapp.audio_without_id', { companyId, messageId: message.id });
      continue;
    }

    logEvent('whatsapp.inbound_handled', {
      companyId,
      messageId: message.id,
      type: message.type,
      voice: message.audio?.voice,
    });

    // WhatsApp is NEVER gated by billing during the pilot — just log so a
    // blocked company's usage is visible without interrupting the channel.
    const billing = await getBillingState({ db, companyId });
    if (billing.enabled && billing.blocked) {
      logEvent('billing.whatsapp_ungated', { companyId });
    }

    // Ack Meta fast (retries + duplicate delivery kick in otherwise); the
    // transcription and agent loop run after the response, within maxDuration.
    after(async () => {
      const sendConfig: WhatsAppSinkConfig = {
        accessToken,
        phoneNumberId,
        to: testTierArSendTarget(message.from),
      };

      let text: string;
      let transcribed = false;

      if (message.type === 'text') {
        text = message.text!.body;
      } else {
        transcribed = true;
        const t = getCatalog(locales.user);
        try {
          // The media URL from hop 1 is short-lived (~5 min) and single-use, so
          // the download must happen here and now — never stored, never retried.
          const media = await downloadMedia(message.audio!.id, {
            accessToken,
            maxBytes: MAX_AUDIO_BYTES,
          });
          text = await transcribeAudio({
            db,
            companyId,
            locale: locales.user,
            audio: media.bytes,
            mediaType: media.mediaType,
          });
        } catch (err) {
          logEvent('whatsapp.voice_note_failed', {
            companyId,
            messageId: message.id,
            error: err instanceof Error ? err.message : String(err),
          });
          // Silence on a voice note reads as "Capo is broken". Send directly
          // rather than through the sink: the sink's `delivery` promise only
          // settles once mergeAssistantStream is called, and the agent never
          // runs on this path.
          await sendWhatsAppText(t.whatsapp.voiceNoteFailed, sendConfig).catch(() => {});
          return;
        }

        if (!text) {
          logEvent('whatsapp.voice_note_empty', { companyId, messageId: message.id });
          await sendWhatsAppText(t.whatsapp.voiceNoteEmpty, sendConfig).catch(() => {});
          return;
        }
      }

      try {
        const { sink, delivery } = whatsappSink(sendConfig);
        await handleInbound({
          db,
          companyId,
          userId,
          locales,
          inbound: { channel: 'whatsapp', text, transcribed },
          sink,
        });
        await delivery;
      } catch (err) {
        console.error(`whatsapp: failed handling message ${message.id}:`, err);
        logEvent('whatsapp.send_failure', { companyId, messageId: message.id, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  return NextResponse.json({ received: true });
}
