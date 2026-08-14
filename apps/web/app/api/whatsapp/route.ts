import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { after, NextResponse, type NextRequest } from 'next/server';
import { getDb, type Db } from '@capo/db/client';
import { handleInbound } from '@capo/core/agent';
import { handleWorkerInbound } from '@capo/core/agent/worker';
import type { PendingPhoto } from '@capo/core/capabilities/worker';
import { MAX_AUDIO_BYTES, transcribeAudio } from '@capo/core/transcription';
import { coerceConfirmPosture } from '@capo/db/posture';
import { coerceLocale, type Locale, type LocaleContext } from '@capo/i18n/locale';
import { getCatalog } from '@capo/i18n/catalog';
import {
  isBsuid,
  parseCheckinPayload,
  parseProposalButtonId,
  readSender,
  routeWebhookChanges,
  senderLabel,
  sendWhatsAppText,
  whatsappSink,
  workerSink,
  WhatsAppSendError,
  type BsuidRotation,
  type WhatsAppSendConfig,
  type WhatsAppSender,
  type WhatsAppWebhookEnvelope,
} from '@capo/core/channels/whatsapp';
import { resolveProposal } from '@capo/core/capabilities/propose';
import { downloadMedia } from '@capo/core/channels/whatsapp-media';
import { TASK_PHOTO_MAX_BYTES, isTaskPhotoMime } from '@capo/core/media/photos';
import { getBillingState } from '../../../lib/billing';
import {
  checkinDoneAck,
  classifyClaimError,
  readTaskIds,
  type CheckinAck,
  type ClaimOutcome,
} from '../../../lib/checkin-claim';
import { logEvent } from '../../../lib/log';
import { type WhatsAppEnv } from '../../../lib/whatsapp';

// WhatsApp manager channel — Meta Cloud API webhook (see
// docs/whatsapp-cloud-api-runbook.md for the one-time Meta setup).
//
// This is a SYSTEM path: there is no user session. The structural boundary is
// the X-Hub-Signature-256 HMAC (app secret) on every POST; tenant resolution
// reads ONLY identifiers Meta put on the envelope, matched against rows we
// already hold, and never anything from the message body. Unknown senders are a
// silent no-op — no reply, no error detail, nothing persisted.
//
// Two kinds of sender, and they reach TWO DIFFERENT AGENTS:
//   profiles → a MANAGER. The full agent loop (handleInbound), the full roster,
//              the write guard, approval cards, persisted to `messages`.
//   workers  → a WORKER. Since PRD 4 (issue #22) their text DOES reach a model
//              — a second, restricted one (handleWorkerInbound) with four tools
//              and its own conversation tables. See handleWorkerReply.
//
// ── THE INVARIANT THAT CHANGED, AND THE ONE THAT REPLACED IT ────────────────
// This file used to say "a worker's text never reaches the model". That is no
// longer true and was replaced ON PURPOSE with a narrower promise that is still
// structural rather than hoped-for:
//
//     WORKER TEXT NEVER REACHES THE *MANAGER'S* AGENT CONTEXT.
//
// The mechanism is not a filter on this path. It is that worker turns are
// stored in `worker_conversations` / `worker_messages` (0027) — different
// tables, read by different code — so nothing a worker writes can ever appear
// in `messages`, and therefore never in thread.recentUserTexts, which is the
// evidence pool the manager-side write guard authorizes against
// (packages/core/src/capabilities/guard.ts). Without that separation a worker
// could author the quote that authorizes a direct manager-level write: a
// one-line privilege escalation with no error and no log.
//
// handleInbound and the manager roster are NOT modified by that PRD. If a
// change here ever needs to touch either, the isolation design has gone wrong.
//
// Three things on the worker path are deliberately still deterministic and
// still involve no model at all, because each is free, instant, and already
// correct: the check-in button tap, STOP/START, and the PT/ES/EN language
// keyword. All three sit IN FRONT of the agent.
//
// ── TWO RESOLUTION KEYS, IN A FIXED ORDER ──────────────────────────────────
// Since Stage 2 (issue #28) each of those tables is tried on the PHONE first
// and on the BSUID (`from_user_id`, present since April 2026) only as a
// fallback — four lookups, stopping at the first hit:
//
//   1. profiles.phone            3. workers.phone
//   2. profiles.whatsapp_user_id 4. workers.whatsapp_user_id
//
// The ordering is not cosmetic. Steps 1 and 3 are byte-identical to what this
// route has always run, so nothing added here can regress the traffic that
// already works. And steps 2 and 4 are SEPARATE QUERIES rather than a widened
// column list on 1 and 3: adding whatsapp_user_id to the working lookup would
// couple sender resolution to migration 0022, and a deploy landing first would
// 42703 and turn EVERY MANAGER into an unknown sender. As their own queries the
// same failure costs the fallback and nothing else.
//
// A BSUID is NOT a tenant boundary. It is scoped to our business portfolio, not
// to a customer company, which makes it exactly as tenant-ambiguous as the
// phone number it replaces — no better, no worse. company_id still comes from
// the matched row, and RLS is still the boundary. workers.whatsapp_user_id is
// non-unique for the same reason workers.phone is, so its lookup carries the
// same .limit(2) ambiguity guard: two companies matching means silence, never a
// guess.
//
// BSUIDs also ROTATE — changing your phone number regenerates yours — which is
// why the `user_id_update` webhook field is load-bearing rather than optional.
// See applyBsuidRotation, and note the app must be SUBSCRIBED to that field in
// the Meta App Dashboard or none of it ever fires
// (docs/whatsapp-cloud-api-runbook.md).
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
  // changes. Recorded by captureBsuid on every message, and used as the
  // FALLBACK resolution key when `from` is absent or matches nothing.
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
  // An inbound photo. Only ever taken in on the WORKER path, where it is
  // completion proof; a manager's image still falls to the unsupported-message
  // triage, unchanged.
  //
  // `caption` is the one place WhatsApp lets text and an image arrive together,
  // and it is the flow the worker agent is built around — "acabei" attached to
  // the photo of the finished work. Photos sent as their own message with no
  // caption still work; see runWorkerTurn for what does NOT work, and why.
  //
  // The BYTES are never shown to a model. An image can carry text and text is
  // instructions, so a vision pass here would be a prompt-injection surface
  // with nothing in front of it (0023, AGENTS.md).
  image?: { id: string; mime_type?: string; caption?: string; sha256?: string };
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
  // `type: 'system'` — Meta narrating a change about the sender rather than the
  // sender saying anything. `user_changed_number` has existed for years;
  // `user_changed_user_id` is the BSUID rotation announcement, and is the
  // SECONDARY signal for it. The primary one is the `user_id_update` webhook
  // FIELD, which is a different shape entirely and carries no messages at all.
  //
  // Typed as an open record on purpose: the exact member names for the
  // user_changed_user_id variant are documented only in Meta's changelog and
  // are quoted verbatim by no public source, so handleSystemMessage logs the
  // KEYS it actually received rather than guessing at them. Keys are not
  // identifiers, so logging them leaks nothing and makes the real shape
  // discoverable from a log drain the first time one arrives.
  system?: { type?: string } & Record<string, unknown>;
}

// Reply one of these, alone, and your briefing language changes.
//
// This lookup STAYS IN FRONT OF THE WORKER AGENT and must keep resolving "ES"
// with zero model calls. It is free, instant, and the command surface every
// briefing has trained the crew on; routing it through a model would be a
// regression in cost and latency for the one thing that already works. The
// agent has `set_my_language` for the sentence a lookup cannot answer
// ("podes falar comigo em espanhol?").
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
 * Record that this person just wrote to us (0030).
 *
 * This one timestamp is what makes the 07:00 briefing free for anybody already
 * in conversation with Capo. Meta bills every TEMPLATE send; free-form text
 * inside the 24 hours an inbound message opens costs nothing. Until this column
 * existed there was no way to tell the two groups apart, so everybody got the
 * paid envelope (issue #46, defect 1).
 *
 * BEST-EFFORT, and structured exactly like captureBsuid beside it, for the same
 * three reasons:
 *   - Every failure is logged and swallowed. A failed stamp must never cost
 *     somebody their reply. The worst it can cost is one wrongly-classified
 *     window tomorrow morning — a paid template where free text would have
 *     done, which is the direction the whole feature already fails in.
 *   - It runs inside after(), never on the synchronous path, so it adds no
 *     latency to the ack Meta is waiting for.
 *   - It is its OWN write, never a widened column list on an existing one. A
 *     deploy landing before 0030 answers 42703; as a separate statement that is
 *     one swallowed log line, whereas folded into sender resolution it would
 *     make every manager an unknown sender.
 *
 * Unconditional, unlike captureBsuid's `or` filter: the value changes on every
 * message by definition, so there is no unchanged case to skip. `now()` comes
 * from the RUNTIME rather than from Postgres, which is a deliberate small
 * imprecision — the alternative is an RPC, and the 23-hour margin in
 * FREE_FORM_WINDOW_MS is far wider than any clock skew between the two.
 */
async function stampLastInbound(db: Db, target: BsuidTarget): Promise<void> {
  const patch = { last_inbound_at: new Date().toISOString() };
  try {
    const { error } =
      target.audience === 'manager'
        ? await db.from('profiles').update(patch).eq('id', target.id)
        : await db
            .from('workers')
            .update(patch)
            .eq('id', target.id)
            // Defence in depth, same as captureBsuid: the row was already
            // resolved within the tenant, and this makes a mis-wired call site
            // fail closed rather than write across companies.
            .eq('company_id', target.companyId);
    if (error) {
      // Expected, and harmless, on any deploy that lands before 0030 is
      // applied: "column last_inbound_at does not exist".
      logEvent('whatsapp.last_inbound_stamp_failed', {
        companyId: target.companyId,
        audience: target.audience,
        error: error.message,
      });
    }
  } catch (err) {
    logEvent('whatsapp.last_inbound_stamp_failed', {
      companyId: target.companyId,
      audience: target.audience,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── sender identity ─────────────────────────────────────────────────────────
// readSender and WhatsAppSender live in @capo/core/channels/whatsapp: deciding
// WHICH identifier wins and WHICH envelope a reply travels in is the highest-
// risk logic in this change, and there it can be pinned by
// scripts/whatsapp-check.mts with no credentials and no network.

// Deliberately two constants rather than one: they answer different questions
// (who is the manager / who is the crew member) and are free to diverge without
// either lookup silently acquiring a column.
//
// MANAGER_COLUMNS became a `*` in 0031, and the reason is the rule stated at
// length in this file's header: a manager lookup must never name a column a
// pending migration adds. `confirm_posture` written out here would 42703 for
// the minutes between a deploy and its migration, and on THIS query a 42703
// means every manager in the product becomes an unknown sender — silence, no
// error to them, no reply. With `*` the field is simply absent until the column
// exists and coerceConfirmPosture reads that as the safe posture. The embed
// still has to be spelled out; PostgREST does not follow relations under `*`.
const MANAGER_COLUMNS = '*, company:companies(language)';
const WORKER_COLUMNS = 'id, company_id, language, company:companies(language)';

/** One resolved crew row, as both worker lookups return it. */
interface WorkerMatch {
  id: string;
  company_id: string;
  language: string | null;
  company: { language: string | null } | null;
}

/**
 * Phone first, BSUID second — see the ordering note in this file's header.
 *
 * The BSUID query runs only when the phone one has genuinely missed, so it costs
 * a round trip on unknown senders only. profiles.whatsapp_user_id is `unique`
 * (0022) AND absent from the tenant's column UPDATE grant, so a match here is a
 * globally unambiguous identity that only this route could ever have written —
 * the strongest of the four lookups, and deliberately so.
 */
async function resolveManager(db: Db, sender: WhatsAppSender) {
  if (sender.from) {
    const { data } = await db
      .from('profiles')
      .select(MANAGER_COLUMNS)
      .eq('phone', `+${sender.from}`)
      .maybeSingle();
    if (data) return data;
  }
  if (!sender.bsuid) return null;
  const { data } = await db
    .from('profiles')
    .select(MANAGER_COLUMNS)
    .eq('whatsapp_user_id', sender.bsuid)
    .maybeSingle();
  return data ?? null;
}

// ── rotation ────────────────────────────────────────────────────────────────

/**
 * A person changed their phone number, so Meta regenerated their BSUID and told
 * us. Rewrite the stored id from `previous` to `current`.
 *
 * THIS IS THE PART THAT WOULD OTHERWISE ROT SILENTLY. Without it a stored BSUID
 * quietly stops pointing at anybody: no error, no failed send, just a person who
 * gradually stops being recognised, months after the change, with nothing in any
 * log to connect the symptom to the cause. That is why the "matched nothing"
 * branch below gets its own event name — it is the alarm for exactly that.
 *
 * Blind UPDATE, no read first: the `.eq('whatsapp_user_id', previous)` filter is
 * itself the search, so there is no TOCTOU window and a redelivered webhook is
 * free (the second run matches nothing, because the first already moved the row).
 *
 * NOT scoped by company, and it cannot be — a rotation arrives with no tenant
 * context at all. That is safe because it is a pure key REWRITE: the row it
 * touches is the row that already held `previous`, so no row changes hands and
 * no company_id is read from the payload. Refusing to scope it is the point;
 * inventing a scope would mean guessing.
 */
async function applyBsuidRotation(db: Db, rotation: BsuidRotation): Promise<void> {
  const { previous, current } = rotation;
  // Both ends validated. `current` because it is about to be written into a
  // column with a CHECK constraint, where an invalid value is a 23514 rather
  // than a clean refusal; `previous` because a malformed value cannot match a
  // stored one and the attempt would look like an orphan, which is an alarm that
  // must not cry wolf.
  if (!isBsuid(previous) || !isBsuid(current)) {
    logEvent('whatsapp.bsuid_rotation_invalid', {
      previousValid: isBsuid(previous),
      currentValid: isBsuid(current),
    });
    return;
  }

  try {
    const [managers, workers] = await Promise.all([
      db.from('profiles').update({ whatsapp_user_id: current }).eq('whatsapp_user_id', previous).select('id'),
      db.from('workers').update({ whatsapp_user_id: current }).eq('whatsapp_user_id', previous).select('id'),
    ]);

    const movedManagers = managers.data?.length ?? 0;
    const movedWorkers = workers.data?.length ?? 0;

    // Both errors, and both counts alongside them. The two updates are
    // independent, so one can fail while the other succeeds — reporting only the
    // error would hide a rotation that DID land, and the follow-up question
    // after a failure here is always "so who moved and who didn't".
    const failures: string[] = [];
    if (managers.error) failures.push(`profiles: ${managers.error.message}`);
    if (workers.error) failures.push(`workers: ${workers.error.message}`);
    if (failures.length > 0) {
      // The realistic one is a unique violation on profiles: `current` is
      // already stored against a different row, which means our picture of who
      // is who is wrong and guessing would make it worse.
      logEvent('whatsapp.bsuid_rotation_failed', {
        error: failures.join('; '),
        managers: movedManagers,
        workers: movedWorkers,
      });
      return;
    }

    const moved = movedManagers + movedWorkers;
    if (moved === 0) {
      // THE SIGNAL THAT WE LOST SOMEBODY. Either we never captured this person,
      // or a rotation was missed earlier and the stored id is already stale. The
      // truncated suffix identifies nobody but is enough to correlate two
      // rotations for the same person in a log drain.
      logEvent('whatsapp.bsuid_rotation_orphan', { previous: `…${previous.slice(-4)}` });
      return;
    }
    logEvent('whatsapp.bsuid_rotated', { managers: movedManagers, workers: movedWorkers });
  } catch (err) {
    logEvent('whatsapp.bsuid_rotation_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * `type: 'system'` — Meta narrating something about the sender. Belt and
 * braces: the authoritative rotation signal is the `user_id_update` webhook
 * field, which arrives on its own change and is handled above.
 *
 * Handled BEFORE sender resolution, unlike every other message type, because a
 * system message is not a person writing to us and may well carry no identifier
 * we can still resolve — a rotation announcement is precisely the case where the
 * old identity is on its way out. The cost is that this log has no companyId
 * where the old unsupported-type triage would have had one; the benefit is that
 * `user_changed_number` and `user_changed_user_id` stop being invisible.
 *
 * The keys are logged, the values are not. Meta's member names for this variant
 * are quoted verbatim by no public source, so this makes the real shape
 * discoverable the first time one arrives instead of requiring a guess now. If
 * the payload happens to carry the same `{ user_id: { previous, current } }`
 * shape the webhook field uses, the rotation is applied too.
 */
function handleSystemMessage(db: Db, message: WhatsAppMessage): void {
  const system = message.system ?? {};
  logEvent('whatsapp.system_message', {
    messageId: message.id,
    systemType: system.type,
    keys: Object.keys(system).sort().join(','),
  });

  if (system.type !== 'user_changed_user_id') return;

  const userId = system.user_id;
  if (typeof userId !== 'object' || userId === null) return;
  const { previous, current } = userId as { previous?: unknown; current?: unknown };
  if (typeof previous !== 'string' || typeof current !== 'string') return;

  after(() => applyBsuidRotation(db, { previous, current }));
}

/** The `whatsapp` slice of the copy catalog, in the recipient's own language. */
type WhatsAppCopy = ReturnType<typeof getCatalog>['whatsapp'];

/** Three outcomes, three sentences. None of them says the task is done. */
function doneAckBody(t: WhatsAppCopy, ack: CheckinAck): string {
  if (ack === 'awaiting') return t.checkinDoneAwaiting;
  if (ack === 'nothing') return t.checkinDoneNothing;
  return t.checkinDoneProblem;
}

/**
 * File one completion claim per task the worker was asked about.
 *
 * ── WHY PER TASK, AND WHY THE ERRORS ARE CAUGHT PER TASK ─────────────────────
 * open_task_review refuses a task that is already `done`/`cancelled` (0019) and
 * `task_reviews_one_pending_idx` refuses a second pending review for one task
 * (0018). Both are ORDINARY outcomes for one row in the snapshot, not errors in
 * the tap. A worker with three tasks, one of which the manager closed at lunch,
 * must still get the other two claimed — so one refusal may never abort the
 * loop, and each is logged with the task it belongs to.
 *
 * ── THE TENANT BOUNDARY, AND WHERE IT IS NOT ─────────────────────────────────
 * open_task_review is SECURITY DEFINER and its tenant guard is
 * `if auth.uid() is not null and v_company is distinct from
 * private.current_company_id()`. On this path there IS no auth.uid() — the
 * webhook runs on the service-role client — so that guard is skipped by design
 * and the function will happily open a review on ANY task uuid it is handed.
 *
 * The `notification_log` read in handleCheckinTap is therefore the ENTIRE
 * tenant boundary for this write: it is what proves the task_ids came from an
 * ask that belongs to this company, this worker and this kind. That is why the
 * ids are passed in from the caller rather than re-read here, and why nothing
 * in this function accepts a task id from anywhere else. Do not move that read,
 * do not widen it, and do not add a caller that skips it.
 *
 * ── NO NOTE ──────────────────────────────────────────────────────────────────
 * `p_note` is deliberately left off. A quick-reply tap carries no text at all,
 * so there is nothing of the worker's to quote; inventing a sentence here would
 * put app copy in a data column, in one language, for managers who may read
 * another. `declared_by_worker_id` is what attributes the claim, and 0024's
 * trigger fans it into every manager's inbox with an empty body, which
 * /notificacoes already renders as "no quote" rather than an empty quote.
 */
async function claimCheckinTasks(
  db: Db,
  worker: { id: string; company_id: string },
  messageId: string,
  taskIds: readonly string[],
): Promise<ClaimOutcome[]> {
  const outcomes: ClaimOutcome[] = [];

  for (const taskId of taskIds) {
    let outcome: ClaimOutcome;
    let detail: string | undefined;
    try {
      // p_worker is the phone-derived worker row, exactly as declare_task_done
      // passes it. Nothing here comes from anything the worker typed.
      const { error } = await db.rpc('open_task_review', { p_task: taskId, p_worker: worker.id });
      outcome = classifyClaimError(error);
      if (outcome !== 'claimed') detail = error?.message;
    } catch (err) {
      // A transport failure, not a refusal. Same treatment: this task did not
      // get claimed, the others still get their turn.
      outcome = 'failed';
      detail = err instanceof Error ? err.message : String(err);
    }

    outcomes.push(outcome);
    logEvent('whatsapp.checkin_claim', {
      companyId: worker.company_id,
      workerId: worker.id,
      messageId,
      taskId,
      outcome,
      error: detail,
    });
  }

  return outcomes;
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
 *
 * Since #54 a "done" tap also FILES A COMPLETION CLAIM per task — see
 * claimCheckinTasks below. Before that it recorded the answer and nothing else,
 * so the worker believed they had reported the job, the manager's board still
 * said pending, and Capo (which reads the board) agreed with the board. The
 * claim is `pending_review`, never `done`: a tap is not a verification.
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

  // ── the completion claim (issue #54) ───────────────────────────────────────
  // "Ainda não" files NOTHING and must keep filing nothing: it is an answer to a
  // question, not a request. Only the "done" branch claims.
  //
  // Run BEFORE the redelivery early-return on purpose. A redelivery means our
  // previous attempt did not finish (Meta retries on a non-200 or a timeout), so
  // it may have claimed some of the tasks and not others. Re-running heals that:
  // every per-task call is idempotent in effect — a task already in review comes
  // back 'already_pending' and changes nothing. Only the ACK stays suppressed,
  // so a retry never double-messages the worker.
  const outcomes =
    parsed.answer === 'done'
      ? await claimCheckinTasks(db, worker, message.id, readTaskIds(ask.task_ids))
      : [];

  // Recorded either way; only the acknowledgement is suppressed, so Meta
  // retrying does not double-message the worker.
  if (redelivery) return true;

  await sendWhatsAppText(
    parsed.answer === 'done' ? doneAckBody(t, checkinDoneAck(outcomes)) : t.checkinNotDone,
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
 * Take in the photos attached to ONE inbound message.
 *
 * Downloaded synchronously, here and now, exactly as audio is: hop 1's media
 * URL lasts ~5 minutes, is effectively single-use, and still requires the
 * Authorization header. There is no retry and nothing is persisted at this
 * point — the bytes are held in memory for the duration of the turn, because a
 * task photo's object key contains the TASK id and the task is not known until
 * `declare_task_done` names one.
 *
 * TASK_PHOTO_MAX_BYTES rather than downloadMedia's 16 MiB default. One constant
 * bounds both intake paths (the manager's browser upload and this one) and it
 * matches Meta's own 5 MiB cap for an inbound image, which is what makes it the
 * right number rather than a convenient one.
 *
 * Returns an empty array on any failure. The caller then runs the turn anyway
 * with no photos, and the agent asks for the photo again — which is far better
 * than dropping the message, because the worker also wrote something.
 */
async function takeInboundPhotos(
  message: WhatsAppMessage,
  worker: { id: string; company_id: string },
  accessToken: string,
): Promise<{ photos: PendingPhoto[]; failed: boolean }> {
  if (message.type !== 'image' || !message.image?.id) return { photos: [], failed: false };

  try {
    const media = await downloadMedia(message.image.id, { accessToken, maxBytes: TASK_PHOTO_MAX_BYTES });
    if (!isTaskPhotoMime(media.mediaType)) {
      logEvent('whatsapp.worker_photo_rejected', {
        companyId: worker.company_id,
        workerId: worker.id,
        messageId: message.id,
        mediaType: media.mediaType,
      });
      return { photos: [], failed: true };
    }
    return {
      photos: [
        {
          // Ours, not Meta's media id. The id is handed to the model, and a
          // Graph API media id in a model's context is a value it could later
          // emit somewhere it should not be.
          id: randomUUID(),
          mime: media.mediaType,
          bytes: media.bytes,
          byteSize: media.byteLength,
        },
      ],
      failed: false,
    };
  } catch (err) {
    logEvent('whatsapp.worker_photo_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { photos: [], failed: true };
  }
}

/**
 * Run one turn of the RESTRICTED worker agent.
 *
 * Everything the manager branch below does — approval labels, the sink that can
 * render cards, `handleInbound` — is deliberately absent. `workerSink` takes a
 * plain send config and THROWS if a turn ever produces a proposal, because a
 * silently dropped card is the bug the channel file's header documents as
 * already fixed once, and on this path it would also be the only signal that
 * the two rosters had stopped being isolated.
 *
 * ── A KNOWN LIMIT, STATED RATHER THAN HIDDEN ────────────────────────────────
 * Photos live for exactly one turn. WhatsApp delivers each image as its OWN
 * message, so "photo, then a separate message saying which task" loses the
 * photo: by the time the second message arrives, the bytes are gone and the
 * agent has to ask for it again. The flows that work are the two natural ones —
 * a photo with a caption, and "acabei" → "manda foto" → photo — and the worker
 * policy tells the model to ask for a resend rather than pretend otherwise.
 * Sending three photos as three messages attaches only the last one.
 *
 * The fix is a staging area for inbound photos keyed on the worker, with its
 * own table, RLS and cleanup. That is a design, not a patch, and it is out of
 * this PRD's scope — but this is the first thing to build if the crew trips
 * over it.
 */
async function runWorkerTurn(
  db: Db,
  message: WhatsAppMessage,
  worker: { id: string; company_id: string },
  locale: Locale,
  sendConfig: WhatsAppSendConfig,
  accessToken: string,
): Promise<void> {
  const t = getCatalog(locale).whatsapp;
  const { photos, failed } = await takeInboundPhotos(message, worker, accessToken);
  if (failed) {
    // Say so immediately, before the turn: a worker who is told nothing assumes
    // the photo landed and stops trying to send it.
    await sendWhatsAppText(t.workerPhotoFailed, sendConfig).catch(() => {});
  }

  const text = message.type === 'image' ? (message.image?.caption ?? '') : (message.text?.body ?? '');

  // A photo that failed to download, with no caption to go with it, leaves
  // nothing for the model to answer. The worker has already been asked to send
  // it again, so running an agent turn on an empty message would spend a slice
  // of their daily budget to say nothing.
  if (!text.trim() && photos.length === 0) return;

  // Declared outside the try so the catch below can defuse it. `delivery` only
  // settles once mergeAssistantStream has been called; if the turn throws AFTER
  // that (persisting the reply, say) the promise can still reject later with
  // nobody awaiting it, which surfaces as an unhandled rejection inside after().
  let delivery: Promise<void> | undefined;

  try {
    const sinkPair = workerSink(sendConfig);
    const sink = sinkPair.sink;
    delivery = sinkPair.delivery;
    const result = await handleWorkerInbound({
      db,
      companyId: worker.company_id,
      workerId: worker.id,
      locale,
      inbound: { channel: 'whatsapp', text },
      photos,
      sink,
    });

    if (result.outcome === 'budget_exhausted') {
      // ZERO model calls were made getting here — that is the whole point of
      // the cap, and the reason it is read before anything else in the loop.
      logEvent('whatsapp.worker_budget_exhausted', {
        companyId: worker.company_id,
        workerId: worker.id,
        limit: result.limit,
      });
      await sendWhatsAppText(t.workerBudgetReached, sendConfig).catch(() => {});
      return;
    }

    await delivery;
    logEvent('whatsapp.worker_agent_answered', {
      companyId: worker.company_id,
      workerId: worker.id,
      messageId: message.id,
      photos: photos.length,
    });
  } catch (err) {
    // See the declaration above: swallow a late rejection from a send that was
    // already in flight when the turn failed, so it cannot escape as an
    // unhandled rejection.
    delivery?.catch(() => {});
    // 131047 = "re-engagement required": we are outside Meta's 24-hour window.
    // Log it, stop, and send NOTHING — in particular never a template. A paid
    // proactive send triggered by inbound text is a cost-amplification vector
    // an attacker controls directly, and the fallback text below would fail the
    // same way anyway.
    if (err instanceof WhatsAppSendError && err.code === 131047) {
      logEvent('whatsapp.worker_window_expired', {
        companyId: worker.company_id,
        workerId: worker.id,
        messageId: message.id,
      });
      return;
    }
    logEvent('whatsapp.worker_agent_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      messageId: message.id,
      // The message body is never logged — it is third-party content. An error
      // string from our own stack is not.
      error: err instanceof Error ? err.message : String(err),
    });
    // Silence after a question reads as "Capo is broken", the same failure the
    // voice-note path already guards against.
    await sendWhatsAppText(t.workerAgentFailed, sendConfig).catch(() => {});
  }
}

/**
 * A reply from a WORKER — someone with a row in `workers` but no account and no
 * profile.
 *
 * Returns true when the sender was recognised as a worker (handled, whatever
 * the outcome), false when they are genuinely unknown.
 *
 * Three deliberate limits:
 *   - The RESTRICTED worker agent runs here (PRD 4) and the text is persisted
 *     to `worker_messages` — NEVER to `messages`. That separation is what keeps
 *     worker text out of the manager agent's context and out of the write
 *     guard's evidence pool. See this file's header.
 *   - `workers.phone` has no unique constraint (unlike `profiles.phone`), so
 *     two companies can hold the same number. On a collision we stay silent
 *     rather than guess a tenant.
 *   - The reply is not politeness. A template send does not open Meta's 24-hour
 *     window — only the recipient's reply does — so answering a worker is
 *     what converts tomorrow's paid template into a free session message.
 */
async function handleWorkerReply(
  db: Db,
  message: WhatsAppMessage,
  // Passed in already resolved rather than re-read from the message: the POST
  // loop has to establish it anyway, and taking it as a parameter makes "there
  // is at least one usable identifier here" structural instead of a defensive
  // branch that can never run.
  sender: WhatsAppSender,
  env: WhatsAppEnv,
): Promise<boolean> {
  // Phone first, then BSUID — the same order and the same reasoning as
  // resolveManager. `.limit(2)` on BOTH, which is the part that matters:
  //
  // workers.whatsapp_user_id is non-unique by design (0022 takes each table's
  // existing uniqueness posture, and workers.phone has none because two
  // companies may legitimately share a crew member). It is also the one BSUID
  // column a tenant can populate — `authenticated` cannot UPDATE it after 0025,
  // but still holds a table-wide INSERT on workers, and workers_insert_company
  // constrains only company_id. So a tenant CAN create a crew row carrying
  // somebody else's BSUID.
  //
  // This guard is what makes that harmless: two matches means we answer
  // NEITHER. A forged row therefore costs its owner nothing and buys them
  // nothing except silencing one worker's acknowledgements — never an answer
  // recorded against a guessed tenant, and never a reply that reveals which one
  // we picked. Do not "improve" this into a tie-break.
  let matches: WorkerMatch[] | null = null;

  if (sender.from) {
    const { data, error } = await db
      .from('workers')
      .select(WORKER_COLUMNS)
      .eq('phone', `+${sender.from}`)
      .eq('active', true)
      .limit(2);
    if (error) {
      console.error('whatsapp: worker lookup failed:', error.message);
      return false;
    }
    matches = data;
  }

  if (!matches?.length && sender.bsuid) {
    const { data, error } = await db
      .from('workers')
      .select(WORKER_COLUMNS)
      .eq('whatsapp_user_id', sender.bsuid)
      .eq('active', true)
      .limit(2);
    if (error) {
      console.error('whatsapp: worker BSUID lookup failed:', error.message);
      return false;
    }
    matches = data;
  }

  if (!matches || matches.length === 0) return false;
  if (matches.length > 1) {
    // Same identifier on two companies' crews. Answering either would leak
    // which tenant we picked, and picking is guesswork.
    logEvent('whatsapp.worker_ambiguous', { sender: senderLabel(message), matches: matches.length });
    return true;
  }

  const worker = matches[0];

  // Above every branch below, so it covers all three of this function's
  // remaining exits — check-in tap, language switch, plain ack. Deliberately
  // NOT above the ambiguity guard: a number on two companies' crews would mean
  // guessing which tenant to write the BSUID into, which is the same guess the
  // guard exists to refuse.
  const workerTarget = { audience: 'worker' as const, id: worker.id, companyId: worker.company_id };
  await captureBsuid(db, message, workerTarget);
  // A SEPARATE write, awaited after it rather than merged into it: the two
  // record different things (identity vs recency), fail for different reasons,
  // and neither may take the other down. Both are already swallowed internally,
  // so neither can abort this reply.
  await stampLastInbound(db, workerTarget);

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
  //
  // The reply goes back on whichever identifier they wrote with — see
  // readSender. A worker who has adopted a username is answered on their BSUID,
  // in Meta's `recipient` field rather than `to`.
  const sendConfig: WhatsAppSendConfig = {
    accessToken: env.accessToken,
    phoneNumberId: env.phoneNumberId,
    recipient: sender.replyTo,
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

  // THE LANGUAGE KEYWORD FAST PATH — still in front of the agent, still zero
  // model calls, and byte-identical in behaviour to what it has always done
  // (including the case where the requested language is already the current
  // one: the confirmation is sent either way, because the worker asked and
  // deserves an answer). The `requested` branch returns, so nothing below runs.
  if (requested) {
    if (requested !== current) {
      const { error: updateError } = await db.from('workers').update({ language: requested }).eq('id', worker.id);
      if (updateError) {
        console.error('whatsapp: worker language update failed:', updateError.message);
        return true;
      }
    }
    // Confirmation is always in the language the worker will get from now on.
    const tl = getCatalog(requested).whatsapp;
    await sendWhatsAppText(tl.workerLanguageChanged, sendConfig).catch(err => {
      logEvent('whatsapp.worker_ack_failed', {
        companyId: worker.company_id,
        workerId: worker.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return true;
  }

  // ── the restricted agent (PRD 4) ──────────────────────────────────────────
  // BELOW every deterministic branch above, and that ordering is the design:
  // the check-in tap, STOP/START and the language keyword are free, instant and
  // already right, so a model must never be able to get at them first.
  //
  // Text and photos only. A voice note from a worker is deliberately NOT
  // transcribed here — that would add a second model call to every message and
  // double what the daily budget buys, for a path this PRD does not cover. It
  // falls to the ack below, as it always has.
  //
  // The emptiness checks mirror the manager triage below: a `text` message with
  // no body and an `image` with no media id are both things Meta can send and
  // neither is worth a model turn against a daily budget.
  const hasText = message.type === 'text' && !!message.text?.body?.trim();
  const hasPhoto = message.type === 'image' && !!message.image?.id;
  if (hasText || hasPhoto) {
    await runWorkerTurn(db, message, worker, current, sendConfig, env.accessToken);
    return true;
  }

  // Everything else — a sticker, a document, a video, a location. Acknowledged
  // so the worker is not met with silence, and never given to a model.
  const t = getCatalog(current).whatsapp;
  await sendWhatsAppText(t.workerAck, sendConfig).catch(err => {
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

  let body: WhatsAppWebhookEnvelope<WhatsAppMessage>;
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse('invalid payload', { status: 400 });
  }

  const db = getDb();

  // Meta batches, and not everything in a batch is a message. This used to
  // flat-map straight to `change.value?.messages` and ignore `change.field`
  // entirely, which meant a `user_id_update` — a change carrying no messages at
  // all — was dropped without a trace. routeWebhookChanges sorts a batch into
  // messages, rotations, and everything else; see @capo/core/channels/whatsapp,
  // where it lives so scripts/whatsapp-check.mts can assert it offline.
  const routed = routeWebhookChanges<WhatsAppMessage>(body);

  // One line each, deliberately. Today an unrecognised field vanishes entirely,
  // which is what would make Meta's NEXT addition invisible rather than merely
  // unhandled — the same class of silence this whole issue exists to end.
  for (const field of routed.unhandledFields) {
    logEvent('whatsapp.unhandled_field', { field });
  }
  if (routed.unreadableRotations > 0) {
    logEvent('whatsapp.bsuid_rotation_unreadable', { count: routed.unreadableRotations });
  }

  // Registered before the message loop so rotations are applied first where the
  // runtime allows it. after() gives no hard ordering guarantee, so a batch
  // containing BOTH a rotation and a message from the new BSUID could still
  // resolve that message against the old value. In practice the two arrive as
  // separate webhook deliveries, and the case self-heals on the next message —
  // stated rather than pretended away.
  if (routed.rotations.length > 0) {
    after(async () => {
      for (const rotation of routed.rotations) await applyBsuidRotation(db, rotation);
    });
  }

  for (const message of routed.messages) {
    // FIRST, above even the sender guard below, and the order is load-bearing.
    // A system message is Meta narrating a change, not a person writing — and a
    // BSUID rotation announcement is precisely the case where the identity on
    // the envelope may be one we can no longer resolve, or may be missing
    // altogether. Handled after the guard, it would be discarded as an unknown
    // sender: the rotation signal thrown away by the very branch that exists
    // because identities change. See handleSystemMessage.
    if (message.type === 'system') {
      handleSystemMessage(db, message);
      continue;
    }

    // Neither identifier on the wire: nothing to look up AND nothing to reply
    // to. The same silent no-op an unrecognised number gets, reached without
    // throwing — and the step that narrows both identifiers for everything
    // below.
    const sender = readSender(message);
    if (!sender) {
      logUnknownSender(message);
      continue;
    }

    // wa_id is digits-only; profiles.phone is E.164 with '+'. Phone first, then
    // BSUID — see resolveManager and this file's header.
    const profile = await resolveManager(db, sender);

    if (!profile) {
      // Not a manager — but it may be a worker replying to their 07:00
      // briefing, which is the one other identity we know. Runs after the ack so
      // the lookup and the ack send add no latency to Meta's webhook call.
      after(async () => {
        const handled = await handleWorkerReply(db, message, sender, { accessToken, phoneNumberId });
        // Safe no-op: don't reveal whether a sender is known, don't reply.
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

    // Placed beside it and for the same reasons — see stampLastInbound. Its own
    // after() callback rather than chained onto the one above, so a slow or
    // failing capture cannot delay or skip the stamp.
    after(() => stampLastInbound(db, { audience: 'manager', id: userId, companyId }));

    // Service role: auth.uid() is null on this path, so the locale cannot come
    // from RLS — it comes from the profile row matched by phone.
    const locales: LocaleContext = {
      user: coerceLocale(profile.language),
      company: coerceLocale(profile.company?.language),
    };
    // Same story as the two locales: no auth.uid() on this path, so the
    // confirmation posture comes off the profile row matched by phone/BSUID —
    // not from a session, and not from a second query.
    const confirmPosture = coerceConfirmPosture(profile.confirm_posture);

    const t = getCatalog(locales.user);
    // Replies go back on whichever identifier the manager wrote with, in the
    // envelope field that identifier requires — `to` for a phone, `recipient`
    // for a BSUID. See readSender.
    const sendConfig: WhatsAppSendConfig = {
      accessToken,
      phoneNumberId,
      recipient: sender.replyTo,
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
          confirmPosture,
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
