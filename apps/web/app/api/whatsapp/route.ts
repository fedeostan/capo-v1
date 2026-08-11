import { createHmac, timingSafeEqual } from 'node:crypto';
import { after, NextResponse, type NextRequest } from 'next/server';
import { getDb, type Db } from '@capo/db/client';
import { handleInbound } from '@capo/core/agent';
import { MAX_AUDIO_BYTES, transcribeAudio } from '@capo/core/transcription';
import { coerceLocale, type Locale, type LocaleContext } from '@capo/i18n/locale';
import { getCatalog } from '@capo/i18n/catalog';
import {
  isBsuid,
  parseCheckinPayload,
  parseProposalButtonId,
  senderLabel,
  sendWhatsAppText,
  whatsappSink,
  type WhatsAppSendConfig,
} from '@capo/core/channels/whatsapp';
import { resolveProposal } from '@capo/core/capabilities/propose';
import { downloadMedia } from '@capo/core/channels/whatsapp-media';
import { getBillingState } from '../../../lib/billing';
import { logEvent } from '../../../lib/log';
import { type WhatsAppEnv } from '../../../lib/whatsapp';

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
// The phone is on its way out as the name badge. Once a sender adopts a
// WhatsApp username Meta omits `from` entirely and sends only `from_user_id`
// (a BSUID). This route already RECORDS that id against whoever the phone
// resolved to — see captureBsuid — but it still resolves on phone alone, so a
// message with no phone is an unknown sender. Reading the BSUID as a
// resolution key is Stage 2 (issue #28).
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
  // wa_id: digits, no '+'. OPTIONAL, and this is a correction rather than a new
  // possibility — it has been a type lie since April 2026. Meta omits `from`
  // entirely once the sender has adopted a WhatsApp username; that is the whole
  // point of the feature. Every use below must guard on it.
  from?: string;
  // The BSUID Meta has sent on every message since April 2026 — a per-person,
  // portfolio-scoped id (PT.13491208655302741918) that survives username
  // changes. Stage 1 only RECORDS it (see captureBsuid); phone is still the
  // sole resolution key. Resolving by BSUID is Stage 2 (issue #28).
  //
  // Deliberately read from the MESSAGE and not from the sibling `contacts[]`
  // array: from_user_id is per-message and unambiguous, while `contacts` lives
  // one level up in `value` and the parser below flat-maps messages, discarding
  // exactly the context that pairing them would need.
  from_user_id?: string;
  id: string;
  type: string;
  text?: { body: string };
  // voice: true is a push-to-talk voice note; absent/false is an uploaded audio
  // file. Both are accepted — refusing a manager's own m4a of himself talking
  // would be user-hostile — but `voice` is logged so the split stays visible.
  audio?: { id: string; mime_type?: string; voice?: boolean };
  // A tap on an approval card's Aprovar/Rechazar button — an INTERACTIVE reply
  // button, sent by the sink inside the 24h window, always to a MANAGER. Other
  // subtypes (`list_reply`, `nfm_reply`) are logged and ignored.
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
  };
  // A tap on a TEMPLATE quick-reply button — the late-afternoon check-in. A DIFFERENT
  // shape from `interactive` above and easy to conflate: `payload` is the string
  // we set when sending (see checkinPayload), `text` is the label the worker
  // actually saw.
  //
  // Only ever arrives from a WORKER, and is handled on the worker path in
  // handleWorkerReply → handleCheckinTap. A manager is never sent a template
  // with buttons, so a manager-side `type: 'button'` still falls to the
  // unsupported-message triage, which is correct.
  button?: { payload?: string; text?: string };
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
 * Unsubscribe keywords, matched with the SAME whole-message discipline as the
 * language keywords above and for the same reason: "stop, o Zé não vem hoje" is
 * a sentence, not a withdrawal of consent, and a substring match would read it
 * as one. Someone who means it sends the word alone — that is the convention
 * every WhatsApp business number has trained them on.
 *
 * Meta's business-messaging policy requires honouring opt-outs, and after 0025
 * this is the mechanism. `start` is the counterpart, so a worker who leaves can
 * come back without going through their manager.
 *
 * Deliberately no Portuguese "pare"/"parar" beyond the two below: the more
 * ordinary the word, the likelier a real sentence collides with it.
 */
const OPT_OUT_KEYWORDS = new Set(['stop', 'parar', 'baja', 'sair', 'cancelar', 'unsubscribe']);
const OPT_IN_KEYWORDS = new Set(['start', 'comecar', 'começar', 'alta', 'subscribe']);

type ConsentCommand = 'opt_out' | 'opt_in';

function consentCommand(text: string | undefined): ConsentCommand | null {
  if (!text) return null;
  const word = text.trim().toLowerCase();
  if (OPT_OUT_KEYWORDS.has(word)) return 'opt_out';
  if (OPT_IN_KEYWORDS.has(word)) return 'opt_in';
  return null;
}

/** notification_log.kind for the late-afternoon ask. Must match /api/cron/checkin. */
const CHECKIN_KIND = 'task_checkin';

/**
 * The silent no-op, in one place so both callers stay identical: a sender we
 * cannot place, whether the number is unknown or there is no number at all.
 *
 * Never reveals whether a number is known and never replies — that silence is
 * the security property, not an omission. senderLabel is truncated for the same
 * reason it always was.
 */
function logUnknownSender(message: WhatsAppMessage): void {
  const sender = senderLabel(message);
  console.warn(`whatsapp: inbound from unknown sender (${sender}), ignoring`);
  logEvent('whatsapp.unknown_sender', { sender });
}

/** Where a captured BSUID goes. `id` is the primary key of the resolved row. */
type BsuidTarget =
  | { audience: 'manager'; id: string; companyId: string }
  | { audience: 'worker'; id: string; companyId: string };

/**
 * Record the sender's BSUID against the row their PHONE just resolved to.
 *
 * This is the whole point of Stage 1 (issue #27). Meta shows both identifiers
 * on the same message only until 30 days after a username adopter's last
 * exchange with us; after that the phone is gone for good and there is no way
 * left to connect the BSUID to someone we already know. So we bind them now,
 * on every message, while both are still on the wire.
 *
 * Best-effort by construction, three ways:
 *   - Every failure is logged and swallowed. A failed capture must never cost a
 *     manager their reply — this is bookkeeping, not the conversation.
 *   - It runs inside after(), never on the synchronous path. Slowing the ack to
 *     Meta buys retries and duplicate delivery.
 *   - It adds no query to sender resolution. The obvious alternative — select
 *     whatsapp_user_id alongside the existing profiles/workers lookup and
 *     compare — would couple resolution to a migration that is deliberately not
 *     applied yet: PostgREST would 42703, the lookup would come back null, and
 *     EVERY MANAGER would silently become an unknown sender. Here the same
 *     error is one swallowed log line. (AGENTS.md, on code that reads ahead of
 *     a pending migration.)
 *
 * ONE conditional UPDATE, no read: the `or` filter makes the statement match
 * nothing when the stored value is already this BSUID, so an unchanged value
 * writes nothing and a redelivered webhook is free. No read means no TOCTOU
 * window either. `.select('id')` is how we tell "wrote" from "matched nothing".
 */
async function captureBsuid(db: Db, message: WhatsAppMessage, target: BsuidTarget): Promise<void> {
  const bsuid = message.from_user_id;
  if (!bsuid || !isBsuid(bsuid)) return;

  // isBsuid is load-bearing beyond validity HERE: it has already established
  // that the value is [A-Za-z0-9.] only, so it cannot contain a PostgREST
  // filter metacharacter (comma, parenthesis, quote) and is safe to interpolate
  // into the `or` expression below. Do not reorder these two statements.
  //
  // The `is.null` disjunct is NOT redundant with `neq`, and dropping it would
  // silently disable the whole feature. Under three-valued logic
  // `NULL <> 'PT.…'` is NULL, not true, so `neq` alone matches no row whose
  // column is still null — which is every row we have never captured, i.e. the
  // only rows this write exists for. (Same trap as 0021, opposite direction:
  // there a null made a guard fail open, here it would make a write fail shut.)
  const unchanged = `whatsapp_user_id.is.null,whatsapp_user_id.neq.${bsuid}`;

  try {
    // Awaited inside each branch rather than building one query and awaiting
    // after: a ternary over two different table builders gives TypeScript a
    // union it cannot apply .or() to.
    const { data, error } =
      target.audience === 'manager'
        ? await db
            .from('profiles')
            .update({ whatsapp_user_id: bsuid })
            .eq('id', target.id)
            .or(unchanged)
            .select('id')
        : await db
            .from('workers')
            .update({ whatsapp_user_id: bsuid })
            .eq('id', target.id)
            // Defence in depth. The row was already resolved within the tenant;
            // this makes a mis-wired call site fail closed rather than write
            // across companies.
            .eq('company_id', target.companyId)
            .or(unchanged)
            .select('id');

    if (error) {
      // Expected, and harmless, on any deploy that lands before 0022 is
      // applied: "column whatsapp_user_id does not exist".
      logEvent('whatsapp.bsuid_capture_failed', {
        companyId: target.companyId,
        audience: target.audience,
        error: error.message,
      });
      return;
    }
    // No rows means the stored value already matched — the common case after
    // the first message, and deliberately not an event.
    if (data?.length) {
      // No raw identifier in the payload: a BSUID is exactly as identifying as
      // the phone number it replaces.
      logEvent('whatsapp.bsuid_captured', { companyId: target.companyId, audience: target.audience });
    }
  } catch (err) {
    logEvent('whatsapp.bsuid_capture_failed', {
      companyId: target.companyId,
      audience: target.audience,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A check-in button tap: the worker answering the late-afternoon check-in template.
 *
 * Returns true when it was one AND the worker has been answered; false to fall
 * through to the ordinary ack path, which is where a malformed or unowned
 * payload goes. Never silence — silence after a tap reads as "Capo is broken",
 * and the ack is also what refreshes Meta's 24h window.
 *
 * NO MODEL IS INVOLVED, in either direction. The payload is one of exactly two
 * strings /api/cron/checkin minted a few hours earlier, so there is nothing to
 * interpret. A worker's TEXT already never reaches the model (see the header of
 * handleWorkerReply) and a button tap carries no text at all — the only things a
 * model could add here are cost, latency, and the ability to be wrong about a
 * two-valued answer.
 */
async function handleCheckinTap(
  db: Db,
  message: WhatsAppMessage,
  worker: { id: string; company_id: string },
  locale: Locale,
  sendConfig: WhatsAppSendConfig,
): Promise<boolean> {
  const parsed = parseCheckinPayload(message.button?.payload ?? '');
  if (!parsed) {
    // Also the shape you get when the template declares quick replies but the
    // send omitted the button component: Meta then echoes the button's LABEL as
    // the payload, so this logs "Sim, terminei" arriving as a payload. See
    // docs/whatsapp-cloud-api-runbook.md §6b — it is the single most likely
    // silent failure in this feature, and this log line is its only symptom.
    logEvent('whatsapp.unknown_checkin_payload', {
      companyId: worker.company_id,
      workerId: worker.id,
      messageId: message.id,
    });
    return false;
  }

  // ── THE TENANT BOUNDARY ON THIS PATH ───────────────────────────────────────
  // Everything here runs on the SERVICE-ROLE client, so RLS enforces nothing.
  // Without this read a worker could record an answer against another company's
  // ask by guessing a uuid. Same shape and same reasoning as the `proposals`
  // read on the manager button path below: ONE query, so "no such ask", "not
  // your company" and "not your row" collapse into a single silent outcome with
  // no timing difference to read as an existence oracle.
  //
  // The kind filter is not decoration. Without it a guessed daily_briefing row
  // id would be accepted, and that row's 07:00 task snapshot recorded as the
  // answer to a question it never asked.
  const { data: ask } = await db
    .from('notification_log')
    .select('id, notification_date, task_ids')
    .eq('id', parsed.notificationId)
    .eq('company_id', worker.company_id)
    .eq('worker_id', worker.id)
    .eq('kind', CHECKIN_KIND)
    .maybeSingle();
  if (!ask) {
    logEvent('whatsapp.checkin_not_owned', {
      companyId: worker.company_id,
      workerId: worker.id,
      messageId: message.id,
    });
    return false;
  }

  // Read before write, purely to tell a REDELIVERY from a change of mind. Meta
  // redelivers on non-200 or timeout carrying the same wamid; a worker who taps
  // "Ainda não" at 16:35 and "Sim, terminei" at 17:40 sends a new one and
  // deserves a fresh confirmation.
  const { data: prior } = await db
    .from('worker_checkins')
    .select('inbound_message_id')
    .eq('worker_id', worker.id)
    .eq('checkin_date', ask.notification_date)
    .maybeSingle();
  const redelivery = prior?.inbound_message_id === message.id;

  const t = getCatalog(locale).whatsapp;
  const { error: writeError } = await db.from('worker_checkins').upsert(
    {
      company_id: worker.company_id,
      worker_id: worker.id,
      // From the ASK, never from the clock: the buttons stay tappable, so a
      // late answer must still land on the day it was asked about.
      checkin_date: ask.notification_date,
      notification_id: ask.id,
      answer: parsed.answer,
      // Explicit. The column DEFAULT fires on INSERT only, so an upsert that
      // UPDATES would otherwise keep the first tap's timestamp against the
      // second tap's answer.
      answered_at: new Date().toISOString(),
      task_ids: ask.task_ids,
      inbound_message_id: message.id,
    },
    { onConflict: 'worker_id,checkin_date' },
  );

  if (writeError) {
    logEvent('whatsapp.checkin_write_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      messageId: message.id,
      error: writeError.message,
    });
    await sendWhatsAppText(t.checkinError, sendConfig).catch(() => {});
    return true;
  }

  logEvent('whatsapp.checkin_recorded', {
    companyId: worker.company_id,
    workerId: worker.id,
    messageId: message.id,
    answer: parsed.answer,
    date: ask.notification_date,
    redelivery,
  });

  // Recorded either way; only the acknowledgement is suppressed, so Meta
  // retrying does not double-message the worker.
  if (redelivery) return true;

  await sendWhatsAppText(
    parsed.answer === 'done' ? t.checkinDone : t.checkinNotDone,
    sendConfig,
  ).catch(err => {
    logEvent('whatsapp.checkin_ack_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return true;
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
async function handleWorkerReply(
  db: Db,
  message: WhatsAppMessage,
  // Passed in already narrowed rather than re-read from the message: the POST
  // loop has to guard on it anyway, and taking it as a parameter makes "there
  // is a phone here" structural instead of a defensive branch that can never
  // run. A worker with no phone on the wire is unresolvable in Stage 1.
  from: string,
  env: WhatsAppEnv,
): Promise<boolean> {
  const { data: matches, error } = await db
    .from('workers')
    .select('id, company_id, language, company:companies(language)')
    .eq('phone', `+${from}`)
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
    logEvent('whatsapp.worker_ambiguous', { sender: senderLabel(message), matches: matches.length });
    return true;
  }

  const worker = matches[0];

  // Above every branch below, so it covers all three of this function's
  // remaining exits — check-in tap, language switch, plain ack. Deliberately
  // NOT above the ambiguity guard: a number on two companies' crews would mean
  // guessing which tenant to write the BSUID into, which is the same guess the
  // guard exists to refuse.
  await captureBsuid(db, message, { audience: 'worker', id: worker.id, companyId: worker.company_id });

  const current = worker.language ? coerceLocale(worker.language) : coerceLocale(worker.company?.language);
  const requested = message.type === 'text' ? languageCommand(message.text?.body) : null;
  const consent = message.type === 'text' ? consentCommand(message.text?.body) : null;

  logEvent('whatsapp.worker_reply', {
    companyId: worker.company_id,
    workerId: worker.id,
    messageId: message.id,
    type: message.type,
    // The message body is deliberately NOT logged — it is third-party content.
    // These two are the recognised keywords, not the text, so they are safe.
    languageCommand: requested ?? undefined,
    consentCommand: consent ?? undefined,
  });

  // Send-, not sink-config: a worker ack carries no approval buttons, and
  // WhatsAppSinkConfig now requires the ApprovalLabels the cards need.
  // `from` is already a wa_id (digits, no '+'), which is exactly what the send
  // API wants — replying is the one direction that needs no conversion.
  const sendConfig: WhatsAppSendConfig = {
    accessToken: env.accessToken,
    phoneNumberId: env.phoneNumberId,
    to: from,
  };

  // The check-in answer. Sits here — inside the WORKER path — and not
  // beside the manager's `interactive` branch below, because a check-in tap
  // comes from a workers.phone sender: sender resolution diverts it here and
  // `continue`s, so it never reaches that branch or the triage after it. Before
  // this existed, a tap fell straight through to the canned workerAck.
  //
  // It is also below the .limit(2) ambiguity guard above, deliberately: a number
  // on two companies' crews still gets silence rather than an answer recorded
  // against a guessed tenant.
  if (message.type === 'button' && (await handleCheckinTap(db, message, worker, current, sendConfig))) {
    return true;
  }

  // STOP / START. Sits beside the language switch because it is the same kind
  // of thing — a whole-message keyword answered deterministically, with no model
  // and nothing persisted to `messages` — and ABOVE it because the two keyword
  // sets are disjoint, so the order only decides which check pays for the miss.
  //
  // Meta requires opt-outs to be honoured; hasWhatsAppConsent() is where that
  // takes effect, and the write below is its only worker-side input. The ack is
  // legal free-form text: this worker's own message opened the 24-hour window a
  // moment ago, which is also why the opt-out itself does not suppress it.
  if (consent) {
    const now = new Date().toISOString();
    const patch = consent === 'opt_out' ? { whatsapp_opt_out_at: now } : { whatsapp_opt_in_at: now };
    const { error: consentError } = await db.from('workers').update(patch).eq('id', worker.id);
    if (consentError) {
      // Do NOT ack a withdrawal we failed to record — an "you're unsubscribed"
      // followed by tomorrow's briefing is worse than silence, and Meta will
      // redeliver this webhook on a non-200 anyway.
      console.error('whatsapp: worker consent update failed:', consentError.message);
      return true;
    }
    const tc = getCatalog(current).whatsapp;
    await sendWhatsAppText(consent === 'opt_out' ? tc.workerOptedOut : tc.workerOptedIn, sendConfig).catch(err => {
      logEvent('whatsapp.worker_consent_ack_failed', {
        companyId: worker.company_id,
        workerId: worker.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return true;
  }

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
    const from = message.from;

    // No phone on the wire: the sender has adopted a WhatsApp username and Meta
    // has stopped telling us their number. Stage 1 resolves by phone ONLY, so
    // there is nothing to look up and this is genuinely an unknown sender — the
    // same silent no-op an unrecognised number gets, reached without throwing.
    // Binding a BSUID to a person needs a message that still carries both, and
    // this one does not. Stage 2 (issue #28) is what turns this branch into a
    // resolution.
    //
    // It is also what narrows `from` to a string for every use below.
    if (!from) {
      logUnknownSender(message);
      continue;
    }

    // wa_id is digits-only; profiles.phone is E.164 with '+'.
    const { data: profile } = await db
      .from('profiles')
      .select('id, company_id, language, company:companies(language)')
      .eq('phone', `+${from}`)
      .maybeSingle();

    if (!profile) {
      // Not a manager — but it may be a worker replying to their 07:00
      // briefing, which is the one other number we know. Runs after the ack so
      // the lookup and the ack send add no latency to Meta's webhook call.
      after(async () => {
        const handled = await handleWorkerReply(db, message, from, { accessToken, phoneNumberId });
        // Safe no-op: don't reveal whether a number is known, don't reply.
        if (!handled) logUnknownSender(message);
      });
      continue;
    }

    const companyId = profile.company_id;
    const userId = profile.id;

    // Placed ABOVE the interactive-button branch and the triage below, so it
    // covers every path a resolved manager can take out of this loop —
    // including the ones that `continue` without ever reaching handleInbound.
    // A manager who only ever taps approval buttons still gets their BSUID
    // recorded.
    after(() => captureBsuid(db, message, { audience: 'manager', id: userId, companyId }));

    // Service role: auth.uid() is null on this path, so the locale cannot come
    // from RLS — it comes from the profile row matched by phone.
    const locales: LocaleContext = {
      user: coerceLocale(profile.language),
      company: coerceLocale(profile.company?.language),
    };

    const t = getCatalog(locales.user);
    const sendConfig: WhatsAppSendConfig = {
      accessToken,
      phoneNumberId,
      to: from,
    };

    // ── Approval card button tap ────────────────────────────────────────────
    // Must sit ABOVE the unsupported-type triage below, which would otherwise
    // swallow it, and BELOW sender resolution, because companyId is the input
    // to the ownership check.
    //
    // This path deliberately never reaches handleInbound: the decision is
    // already deterministic (parse the button id → resolveProposal), exactly
    // like the web card. An agent turn here would cost a model call and could
    // re-propose or narrate the decision. The thread record still happens —
    // finalize_proposal writes the role='event' message in the same
    // transaction as the status flip, so the NEXT real turn sees the outcome
    // as context.
    if (message.type === 'interactive') {
      const reply = message.interactive?.button_reply;
      if (!reply) {
        logEvent('whatsapp.unsupported_interactive', {
          companyId,
          messageId: message.id,
          interactiveType: message.interactive?.type,
        });
        continue;
      }

      const button = parseProposalButtonId(reply.id);
      if (!button) {
        logEvent('whatsapp.unknown_button', { companyId, messageId: message.id });
        continue;
      }

      // ── THE TENANT BOUNDARY ON THIS PATH ─────────────────────────────────
      // resolveProposal below runs on the SERVICE-ROLE client, and
      // finalize_proposal is SECURITY DEFINER scoped by
      //   `where id = p_id and (auth.uid() is null or company_id = …)`
      // (supabase/migrations/0007_auth_multitenancy.sql). With the service
      // role auth.uid() IS null, so that predicate short-circuits to true.
      // Nothing below this line enforces the tenant. Without this read any
      // pilot manager could resolve any other company's proposal by guessing
      // a uuid. Do not delete it as redundant.
      //
      // One query, not two: .eq('id').eq('company_id') collapses "no such
      // proposal" and "not yours" into a single silent branch. Two branches
      // would still differ in timing, which is an existence oracle.
      // TOCTOU is benign — proposals.company_id is never updated anywhere.
      const { data: owned } = await db
        .from('proposals')
        .select('id')
        .eq('id', button.proposalId)
        .eq('company_id', companyId)
        .maybeSingle();
      if (!owned) {
        logEvent('whatsapp.proposal_not_owned', { companyId, messageId: message.id });
        continue;
      }

      logEvent('whatsapp.button_reply', {
        companyId,
        messageId: message.id,
        decision: button.decision,
      });

      after(async () => {
        try {
          const resolution = await resolveProposal(db, button.proposalId, button.decision, locales);
          const confirmation =
            resolution.outcome === 'approved'
              ? t.whatsapp.proposalApproved
              : resolution.outcome === 'rejected'
                ? t.whatsapp.proposalRejected
                : resolution.outcome === 'failed'
                  ? t.whatsapp.proposalFailed(resolution.reason)
                  : // 'not_pending' — a duplicate tap, or Meta redelivering the
                    // webhook. The CAS in resolveProposal makes this a no-op.
                    // resolution.status is deliberately not echoed: 'executing'
                    // and 'expired' are internal vocabulary.
                    t.whatsapp.proposalNotPending;
          logEvent('whatsapp.proposal_resolved', {
            companyId,
            messageId: message.id,
            decision: button.decision,
            outcome: resolution.outcome,
          });
          await sendWhatsAppText(confirmation, sendConfig).catch(() => {});
        } catch (err) {
          // resolveProposal throws if the row vanished or the RPC failed.
          // Silence after a button press reads as "Capo is broken" — the same
          // failure mode the voice-note path already guards against.
          logEvent('whatsapp.proposal_resolve_failed', {
            companyId,
            messageId: message.id,
            error: err instanceof Error ? err.message : String(err),
          });
          await sendWhatsAppText(t.whatsapp.proposalError, sendConfig).catch(() => {});
        }
      });
      continue;
    }

    // Triage. Images, documents, stickers, reactions and delivery statuses are
    // still acked and ignored — but now they leave a trace. (Approval-card
    // button replies are handled above.)
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
      let text: string;
      let transcribed = false;

      if (message.type === 'text') {
        text = message.text!.body;
      } else {
        transcribed = true;
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
        // Approval copy is INJECTED, not imported by the core: @capo/core
        // depends on @capo/i18n/locale only, never on the copy catalog, so UI
        // strings stay out of the agent bundle (AGENTS.md).
        const { sink, delivery } = whatsappSink({
          ...sendConfig,
          approval: {
            approve: t.whatsapp.approveButton,
            reject: t.whatsapp.rejectButton,
            prompt: t.whatsapp.approvalPrompt,
            fallback: t.whatsapp.approvalFallback,
          },
        });
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
