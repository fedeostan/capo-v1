import { createHmac, timingSafeEqual } from 'node:crypto';
import { after, NextResponse, type NextRequest } from 'next/server';
import { getDb, type Db } from '@capo/db/client';
import { handleInbound } from '@capo/core/agent';
import { allPhotosSentText, handleWorkerInbound } from '@capo/core/agent/worker';
import type { PendingPhoto } from '@capo/core/capabilities/worker';
import { MAX_AUDIO_BYTES, transcribeAudio } from '@capo/core/transcription';
import { coerceConfirmPosture } from '@capo/db/posture';
import { coerceLocale, type Locale, type LocaleContext } from '@capo/i18n/locale';
import { getCatalog } from '@capo/i18n/catalog';
import {
  isBsuid,
  parseCheckinPayload,
  parsePhotoBatchPayload,
  parseProposalButtonId,
  parseWorkerMenuRowId,
  readSender,
  routeWebhookChanges,
  senderLabel,
  isHiTap,
  sendWhatsAppList,
  sendWhatsAppText,
  whatsappSink,
  workerSink,
  WhatsAppSendError,
  type BsuidRotation,
  type WhatsAppSendConfig,
  type WhatsAppSender,
  type WhatsAppStatus,
  type WhatsAppWebhookEnvelope,
} from '@capo/core/channels/whatsapp';
import { resolveProposal } from '@capo/core/capabilities/propose';
import { downloadMedia } from '@capo/core/channels/whatsapp-media';
import { loadInboxPhotos, type InboxPhoto } from '@capo/core/media/photo-inbox';
import {
  attachInboxPhotos,
  markTaskProofPhotos,
  storeWorkerTaskPhoto,
} from '@capo/core/media/task-photo-store';
import { getBillingState } from '../../../lib/billing';
import {
  checkinDoneAck,
  classifyClaimError,
  readTaskIds,
  type CheckinAck,
  type ClaimOutcome,
} from '../../../lib/checkin-claim';
import {
  claimedTaskIds,
  nextPhotoTaskId,
  photoRequestExpiry,
  photoRequestLive,
  photosSinceRequest,
  type ClaimResult,
} from '../../../lib/checkin-photo';
import { dayLinkUrl, mintDayLinks } from '../../../lib/day-link';
import { logEvent } from '../../../lib/log';
import { siteUrl } from '../../../lib/site-url';
import { handleProblemReportMessage } from '../../../lib/problem-report-flow';
import { consentCommand, detailCommand, keywordText, languageCommand, menuCommand } from '../../../lib/worker-keywords';
import { isWorkerAudioMessage, transcribeWorkerAudio, type WorkerAudioFailure } from '../../../lib/worker-audio';
import { askAboutMorePhotos, stageInboundPhoto, type StagedPhoto } from '../../../lib/worker-photo-inbox';
import {
  buildWorkerMenu,
  findWorkerTask,
  loadWorkerMenu,
  renderTaskDetail,
} from '../../notifications/worker-menu';
import { type WhatsAppEnv } from '../../../lib/whatsapp';
import { sendTurnFailureReply } from '../../../lib/turn-failure';
import { acknowledgeInbound, withProgressNote } from '../../../lib/whatsapp-feedback';
import {
  loadWorkerBriefing,
  renderCheckinAnswerEvent,
  renderWorkerFreeForm,
} from '../../notifications/briefing';
import { readThreadLocale, recordThreadEvent } from '../../notifications/thread';
import { pingManagersAboutRequests } from '../../notifications/worker-request-ping';
import { drainAssignmentNotices } from '../../notifications/task-assigned';
import { welcomeAnyoneNew } from '../../../lib/welcome-trigger';
import { answerManagerHi, answerWorkerHi } from '../../notifications/welcome-hi';
import { whatsappWorkerMessenger } from '../../notifications/worker-message';

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
//              — a second, restricted one (handleWorkerInbound) with five tools
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
    // A tap on a row of the GUIDED MENU's interactive list (issue #49). Only
    // ever arrives from a WORKER, and is handled on the worker path in
    // handleWorkerReply → handleWorkerMenuTap.
    //
    // The SAME `type: 'interactive'` envelope as button_reply above and a
    // DIFFERENT member of it, which is the shape most likely to be conflated in
    // this file. What actually keeps the two apart is not this branch: the
    // manager's card path is below sender resolution on the manager side, and
    // the two id prefixes (`capo:approve|reject:` and `capo:wm:`) are
    // non-overlapping, so neither parser can accept the other's value.
    list_reply?: { id: string; title: string; description?: string };
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

// ── THE DETERMINISTIC LAYER IN FRONT OF THE WORKER AGENT ────────────────────
// The three keyword tables — language, STOP/START, and the guided menu — used
// to be written out here. They moved to apps/web/lib/worker-keywords.ts when
// issue #49 added the third one: three sets that must stay pairwise disjoint
// cannot be checked by reading them, and a Next route cannot be imported by a
// credential-free check script. `pnpm whatsapp-check` now asserts the
// disjointness, and asserts that a bare "ES" still resolves to Spanish with
// zero model calls.
//
// What did NOT move is the ORDER they are consulted in. That lives in
// handleWorkerReply below, next to the branches it governs, and it is the order
// — not the tables — that keeps the model last.

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
// `name` is here for the check-in thread note (issue #47) and is safe to name
// in this list for a reason worth stating: unlike whatsapp_user_id, it is an
// original column of `workers` and has existed in every deployed schema, so it
// cannot couple sender resolution to a migration that has not landed yet. That
// is the whole hazard this file's header warns about — a 42703 here turns every
// crew member into an unknown sender — and an original column carries none of
// it. Do not extend this list with a column a pending migration adds.
const WORKER_COLUMNS = 'id, company_id, name, language, company:companies(language)';

/** One resolved crew row, as both worker lookups return it. */
interface WorkerMatch {
  id: string;
  company_id: string;
  name: string;
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
 * Record what Meta says actually happened to a message we sent (issue #51, B4).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Until now `notification_log.status = 'sent'` meant "Meta accepted it" and
 * nothing more, because these callbacks were acked and dropped. On 13 August
 * that is what made a briefing which arrived 49 minutes late impossible to tell
 * apart from one that never arrived at all: the ledger said "sent" in both
 * cases, and there was no other record anywhere.
 *
 * ── SHAPE, AND WHAT IT IS NOT ──────────────────────────────────────────────
 * A status is not a message. It carries no sender, no text, nothing anybody
 * typed — so nothing here reaches a model, an agent, or readSender. It is
 * deliberately handled on its own path for exactly the reason AGENTS.md keeps
 * the template quick reply (`type: 'button'`) and the approval-card reply
 * (`type: 'interactive'`) non-overlapping: three shapes, three paths,
 * conflating any two of them is the mistake to watch for.
 *
 * ── THE UPDATE ─────────────────────────────────────────────────────────────
 * Blind, keyed on provider_message_id, one column per state and NEVER derived
 * from another. Meta sends several callbacks per message and does not order
 * them — a `read` genuinely can arrive before its `delivered` — so writing
 * `delivered_at` when a `read` lands would invent a timestamp. A missing
 * `delivered_at` next to a present `read_at` is honest; a fabricated one is not.
 *
 * `sent` is dropped on the floor: the send path already wrote that status
 * synchronously from the Graph response, and re-stamping it would only add
 * write traffic.
 *
 * NOT scoped by company, and it cannot be — a status callback carries no tenant
 * context. That is safe because provider_message_id is a `wamid` MINTED BY META
 * FOR A MESSAGE WE SENT: it is already ours, the row it matches is the row that
 * recorded that send, and nothing about the payload chooses which company it
 * lands on. The same argument applyBsuidRotation makes for a key rewrite.
 *
 * Swallows everything. A missing column (a deploy landing before 0036) or a
 * missing row (a send from before this shipped) must never cost the webhook its
 * 200 — Meta retries a non-200, which would replay the whole batch including
 * real inbound messages.
 */
async function recordDeliveryStatuses(db: Db, statuses: WhatsAppStatus[]): Promise<void> {
  for (const status of statuses) {
    if (status.state === 'sent') continue;

    // Meta's seconds → our timestamptz. A null falls back to now(), because a
    // delivery whose exact second we could not read is still a delivery.
    const stamp = status.timestamp
      ? new Date(status.timestamp * 1000).toISOString()
      : new Date().toISOString();

    const patch =
      status.state === 'delivered'
        ? { delivered_at: stamp }
        : status.state === 'read'
          ? { read_at: stamp }
          : {
              failed_at: stamp,
              delivery_error_code: status.errorCode,
              delivery_error: status.errorTitle,
            };

    try {
      const { data, error } = await db
        .from('notification_log')
        .update(patch)
        .eq('provider_message_id', status.id)
        .select('id');
      if (error) {
        logEvent('whatsapp.delivery_status_failed', {
          state: status.state,
          error: error.message,
          code: error.code,
        });
        continue;
      }
      // A zero-row update is a fully successful statement in Postgres, so it
      // has to be checked by hand — the same trap the billing webhook fell into
      // (AGENTS.md). It is not an error here: an unmatched wamid is an ordinary
      // outcome for any message sent outside the two crons (an agent reply, a
      // progress note), none of which have a ledger row at all.
      if ((data ?? []).length === 0) continue;
      logEvent('whatsapp.delivery_status', {
        state: status.state,
        errorCode: status.errorCode,
      });
    } catch (err) {
      logEvent('whatsapp.delivery_status_failed', {
        state: status.state,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
): Promise<ClaimResult[]> {
  // Paired with their task id AT THE SOURCE rather than returned as a bare list
  // to be zipped against `taskIds` by the caller. The photo follow-up (issue
  // #52) needs to know WHICH tasks were claimed, and "never zip two lists by
  // position" is a rule this codebase already paid for once, in the translation
  // applier — a single dropped element there silently attributes every later
  // item to the wrong row.
  const outcomes: ClaimResult[] = [];

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

    outcomes.push({ taskId, outcome });
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

// ── THE PHOTO FOLLOW-UP (issue #52) ─────────────────────────────────────────
// A tap files a claim; a claim with no proof is a claim the manager has to take
// on trust. The worker agent's `declare_task_done` has required at least one
// photo at the SCHEMA level since #22 — the button path required nothing, and
// that asymmetry is what this section closes.
//
// It closes it by INVITATION, never by requirement. The claim is already filed
// and stands whether or not a photo ever arrives; refusing to file one without
// proof would mean a worker who cannot photograph anything (no signal, phone
// dead, hands full) reports nothing at all, which is the state #54 existed to
// end. What the manager gets instead is the FACT, on the board and in their
// inbox: this claim has photos, or it does not.
//
// EVERY MESSAGE ON THIS PATH IS FREE-FORM TEXT inside the 24-hour window the
// worker's own tap opened seconds earlier. Never a template. A paid template to
// chase a photo would make proof cost money per attempt, on a channel where the
// worker controls how many attempts there are.

/** How the check-in photo request is scoped. Both fields are phone-derived. */
interface PhotoWorker {
  id: string;
  company_id: string;
}

/** One task a photo may still be filed against, with the title to name it by. */
interface PhotoTarget {
  index: number;
  id: string;
  title: string;
}

/**
 * Three outcomes, not two, and the third is the point: a transport failure is
 * NOT "there are no tasks left". Collapsing them would close a live request on
 * one blip, and the worker's next photo — the one they are standing there taking
 * — would have nowhere to go, permanently.
 */
type PhotoTargetSearch =
  | { kind: 'found'; target: PhotoTarget }
  | { kind: 'exhausted' }
  | { kind: 'error' };

/**
 * Walk forward from `from` until a task is found that is STILL this crew
 * member's own and still waiting for the manager.
 *
 * ── THE SECOND TENANT BOUNDARY ─────────────────────────────────────────────
 * Everything here runs on the SERVICE-ROLE client, so RLS enforces nothing. The
 * `checkin_photo_requests` row was already scoped by company_id and worker_id
 * (both phone-derived), which is the first boundary; this read is the second,
 * and it is the one that matters for the WRITE that follows. A photo's object
 * key is `{company_id}/{task_id}/…` and that path IS the tenant boundary
 * (0023), so a task id that reached the request row by any route other than the
 * intended one must still fail HERE, before a byte is written. Three filters,
 * two of them phone-derived, in ONE query — the same shape declare_task_done
 * and handleWorkerMenuTap both use, so a foreign id produces silence rather
 * than a timing difference to read as an existence oracle.
 *
 * `status = 'pending_review'` is the third condition and is not decoration: a
 * photo filed against a task the manager already approved, rejected or reopened
 * is proof of nothing anybody is waiting for.
 *
 * SKIPPING, not stalling. A task reassigned or closed between the tap and the
 * photo is an ordinary outcome for ONE task in a multi-task snapshot — exactly
 * as an already-`done` task is for the claim loop above — and it must never
 * strand the request on a task it can never satisfy.
 */
async function seekPhotoTarget(
  db: Db,
  worker: PhotoWorker,
  taskIds: readonly string[],
  from: number,
): Promise<PhotoTargetSearch> {
  for (let index = Math.max(0, from); ; index += 1) {
    const taskId = nextPhotoTaskId(taskIds, index);
    if (!taskId) return { kind: 'exhausted' };

    const { data, error } = await db
      .from('tasks')
      .select('id, title, status')
      .eq('id', taskId)
      .eq('company_id', worker.company_id)
      .eq('assignee_worker_id', worker.id)
      .maybeSingle();
    // A read failure is not "this task is unusable". Skipping on it would burn
    // through the whole snapshot on one transport blip and then close the
    // request as finished — after which the photo the worker is standing there
    // taking has nowhere to go, permanently. Reported as its own outcome so the
    // caller leaves the request alone and the next message tries again.
    if (error) {
      logEvent('whatsapp.checkin_photo_target_failed', {
        companyId: worker.company_id,
        workerId: worker.id,
        error: error.message,
      });
      return { kind: 'error' };
    }
    if (data && data.status === 'pending_review') {
      return { kind: 'found', target: { index, id: data.id, title: data.title } };
    }
  }
}

/** Mark a request finished. `next_index` is carried so the row records how far
 *  the walk actually got, which is the only way to read afterwards whether a
 *  request was satisfied or merely ran out of usable tasks. */
async function closePhotoRequest(
  db: Db,
  requestId: string,
  patch: { next_index: number; photos_received?: number },
  reason: 'complete' | 'abandoned',
): Promise<void> {
  const { error } = await db
    .from('checkin_photo_requests')
    .update({ ...patch, closed_at: new Date().toISOString(), close_reason: reason })
    .eq('id', requestId);
  if (error) logEvent('whatsapp.checkin_photo_close_failed', { requestId, reason, error: error.message });
}

/**
 * Open a photo request for the tasks this tap actually claimed, and ask about
 * the first of them.
 *
 * ONE TASK AT A TIME. An inbound image carries nothing that says which task it
 * shows, so a worker claiming three tasks is asked three times rather than
 * having one photo guessed onto one of them. A photo filed as proof of the
 * wrong job is worse than no photo at all: it is evidence, it cannot be
 * deleted (0023 has no DELETE policy anywhere), and it is wrong.
 *
 * Best-effort throughout. Every failure here — an unapplied migration (42P01),
 * a lost race, a send refused — costs the photo follow-up and nothing else. The
 * claim is already filed, `worker_checkins` already has the answer, and the
 * worker has already been acknowledged.
 */
async function openPhotoFollowUp(
  db: Db,
  worker: PhotoWorker,
  ask: { id: string; notification_date: string },
  results: readonly ClaimResult[],
  locale: Locale,
  sendConfig: WhatsAppSendConfig,
): Promise<void> {
  const taskIds = claimedTaskIds(results);
  if (taskIds.length === 0) return;

  try {
    // The row's ORDER is the snapshot's order, and the first target is resolved
    // before anything is written: a request whose every task is already
    // unusable is a request worth not opening at all.
    const first = await seekPhotoTarget(db, worker, taskIds, 0);
    if (first.kind !== 'found') return;

    // Close whatever this crew member had open before. Scoped by worker_id
    // ALONE, deliberately: checkin_photo_requests_open_idx is unique on
    // (worker_id) where closed_at is null, so an open row this UPDATE failed to
    // match would make the INSERT below a 23505. A worker_id belongs to exactly
    // one company row, so there is no tenant to widen here — company_id would
    // narrow the sweep without narrowing what it protects.
    const { error: sweepError } = await db
      .from('checkin_photo_requests')
      .update({ closed_at: new Date().toISOString(), close_reason: 'superseded' })
      .eq('worker_id', worker.id)
      .is('closed_at', null);
    if (sweepError) {
      logEvent('whatsapp.checkin_photo_open_failed', {
        companyId: worker.company_id,
        workerId: worker.id,
        stage: 'sweep',
        error: sweepError.message,
      });
      return;
    }

    const { error: insertError } = await db.from('checkin_photo_requests').insert({
      company_id: worker.company_id,
      worker_id: worker.id,
      notification_id: ask.id,
      checkin_date: ask.notification_date,
      task_ids: taskIds,
      // The FIRST usable task, not index 0: anything already skipped must not be
      // asked about again when the photo arrives.
      next_index: first.target.index,
      expires_at: photoRequestExpiry(Date.now()),
    });
    if (insertError) {
      // Expected, and harmless, on any deploy that lands before 0034 is
      // applied: "relation checkin_photo_requests does not exist".
      logEvent('whatsapp.checkin_photo_open_failed', {
        companyId: worker.company_id,
        workerId: worker.id,
        stage: 'insert',
        error: insertError.message,
      });
      return;
    }

    // Sent only once the row exists. Asking for a photo we have no way to
    // attach would be a promise the next message cannot keep.
    const t = getCatalog(locale).whatsapp;
    await sendWhatsAppText(t.checkinPhotoAsk(first.target.title), sendConfig);
    logEvent('whatsapp.checkin_photo_asked', {
      companyId: worker.company_id,
      workerId: worker.id,
      tasks: taskIds.length,
    });
  } catch (err) {
    logEvent('whatsapp.checkin_photo_open_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      stage: 'send',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Photos answering that request.
 *
 * Returns true when there was an open request AND the crew member has been
 * answered; false to fall through, which since 0047 means one of two things:
 * for a bare photo, the "more photos or is that everything?" prompt, and for
 * the "that is everything" tap, the agent working out which task they mean.
 * Everybody who never tapped a check-in reaches this and falls straight
 * through, exactly as they always have.
 *
 * NO MODEL IS INVOLVED, in either direction, and that is the point: which task
 * the photo belongs to was decided by the message Capo itself sent minutes
 * earlier, so there is nothing left to interpret. The BYTES are never shown to
 * a model either — an image can carry text and text is instructions, so a vision
 * pass here would be a prompt-injection surface with nothing in front of it
 * (0023, AGENTS.md).
 *
 * The photos are ALREADY downloaded and staged by the time this runs (0047),
 * which reverses the old ordering. That ordering existed because Meta's media
 * URL is short-lived and effectively single-use, so a download with nowhere to
 * put the result was wasted and unrepeatable; staging gives it somewhere to go
 * unconditionally, and the failure it guarded against (a photo downloaded and
 * then dropped) is exactly what this migration exists to stop.
 */
/**
 * Where the photos this request is about are sitting.
 *
 * `inbox` is the normal case since 0047: they are already in Storage and get
 * MOVED into the task's folder. `bytes` is the FALLBACK, and the pre-0047
 * behaviour: staging failed (0047 unapplied, or a Storage refusal) and the
 * caller still has what it downloaded, so the photo is written straight to the
 * task exactly as it was before this feature existed. A photo the old product
 * would have kept must never be lost by the change meant to stop losing photos.
 */
type CheckinPhotoSource =
  | { kind: 'inbox'; photos: readonly InboxPhoto[] }
  | { kind: 'bytes'; photo: PendingPhoto };

async function handleCheckinPhoto(
  db: Db,
  source: CheckinPhotoSource,
  worker: WorkerMatch,
  locale: Locale,
  sendConfig: WhatsAppSendConfig,
): Promise<boolean> {
  const t = getCatalog(locale).whatsapp;

  // ── the request, and the first half of the tenant boundary ────────────────
  // Scoped by worker_id AND company_id, both phone-derived. `.is('closed_at',
  // null)` plus the partial unique index means this is at most one row, so
  // there is nothing to pick between.
  const { data: request, error } = await db
    .from('checkin_photo_requests')
    .select('id, task_ids, next_index, photos_received, expires_at, created_at')
    .eq('worker_id', worker.id)
    .eq('company_id', worker.company_id)
    .is('closed_at', null)
    .maybeSingle();
  if (error) {
    // Expected on any deploy that lands before 0034: 42P01. Falling through
    // means a bare photo reaches the agent exactly as it did before this
    // feature existed, which is the right degradation.
    logEvent('whatsapp.checkin_photo_read_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      error: error.message,
    });
    return false;
  }
  if (!request) return false;

  const taskIds = readTaskIds(request.task_ids);

  // Expiry is enforced by the READER, because nothing sweeps this table. A
  // request still live at 07:00 tomorrow would attach a photo of TOMORROW's
  // work to yesterday's claim, silently and with a plausible timestamp.
  if (!photoRequestLive(request.expires_at, Date.now())) {
    await closePhotoRequest(db, request.id, { next_index: request.next_index }, 'abandoned');
    return false;
  }

  // ── ONLY PHOTOS THAT ARRIVED AFTER THIS REQUEST OPENED ────────────────────
  // Since 0047 a crew member can be holding photos from earlier in the day, and
  // "É tudo" tapped on an old message would otherwise file a 15:00 photo of
  // another job as proof of the task this 16:00 request happens to be asking
  // about. That is #52's own worst case: wrong evidence, permanent, with no
  // DELETE policy anywhere. The older photos stay in the inbox and the agent
  // path can still put them where the crew member says they go.
  //
  // Computed BEFORE seekPhotoTarget so an empty result changes nothing at all.
  const eligible = source.kind === 'inbox' ? photosSinceRequest(source.photos, request.created_at) : null;
  if (eligible && eligible.length === 0) return false;

  const search = await seekPhotoTarget(db, worker, taskIds, request.next_index);
  // A read failure leaves the request EXACTLY as it was and falls through: the
  // photo goes to the agent this once, and the next one tries again. Only
  // 'exhausted' — every remaining task reassigned, closed or resolved while we
  // waited — closes it.
  if (search.kind === 'error') return false;
  if (search.kind === 'exhausted') {
    await closePhotoRequest(db, request.id, { next_index: taskIds.length }, 'complete');
    return false;
  }
  const target = search.target;

  // The photo is already in the inbox. Attaching MOVES it into this task's
  // folder and writes the `task_photos` row that makes it evidence, through the
  // one writer that has always written those rows. The company and worker
  // filters inside it are both phone-derived, so a photo id that is not this
  // crew member's own resolves to nothing.
  // Two writers, one attribution: both end at the same row-insert helper inside
  // media/task-photo-store, so a `source: 'worker'` row means the same thing
  // whichever of them wrote it.
  let attached: number;
  if (source.kind === 'bytes') {
    const path = await storeWorkerTaskPhoto(db, {
      companyId: worker.company_id,
      taskId: target.id,
      workerId: worker.id,
      photo: source.photo,
    });
    attached = path ? 1 : 0;
  } else {
    ({ attached } = await attachInboxPhotos(db, {
      photoIds: (eligible ?? []).map(p => p.id),
      taskId: target.id,
      companyId: worker.company_id,
      workerId: worker.id,
    }));
  }
  if (attached === 0) {
    // The cursor does NOT move. The photo is still in the inbox and still
    // offered to the agent, so nothing is lost by asking them to try again
    // against the same task.
    logEvent('whatsapp.checkin_photo_store_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      taskId: target.id,
    });
    await sendWhatsAppText(t.workerPhotoFailed, sendConfig).catch(() => {});
    return true;
  }

  // The denormalised bit, written after the evidence rather than instead of it.
  // Never touches `status`: an update of status would fire tasks_supersede_review
  // (0020) and supersede the very claim this photo is proof for.
  await markTaskProofPhotos(db, worker.company_id, target.id);

  logEvent('whatsapp.checkin_photo_stored', {
    companyId: worker.company_id,
    workerId: worker.id,
    taskId: target.id,
  });

  const photosReceived = request.photos_received + attached;
  const next = await seekPhotoTarget(db, worker, taskIds, target.index + 1);
  if (next.kind === 'found') {
    const { error: moveError } = await db
      .from('checkin_photo_requests')
      .update({ next_index: next.target.index, photos_received: photosReceived })
      .eq('id', request.id);
    if (moveError) {
      logEvent('whatsapp.checkin_photo_move_failed', { requestId: request.id, error: moveError.message });
    }
    await sendWhatsAppText(t.checkinPhotoNext(next.target.title), sendConfig).catch(() => {});
    return true;
  }

  // 'error' lands here with 'exhausted', and that is the right call ONLY at this
  // point: the photo is already stored, so the worst case is a follow-up we
  // never send about a task that may still be open. Leaving the request pointing
  // at a task whose photo has just been filed would ask for the same photo again.
  await closePhotoRequest(
    db,
    request.id,
    { next_index: target.index + 1, photos_received: photosReceived },
    'complete',
  );
  // Never says "done". The photo is proof attached to a claim that is still
  // waiting for the manager — the same rule every other acknowledgement on this
  // path follows.
  await sendWhatsAppText(t.checkinPhotoThanks, sendConfig).catch(() => {});
  return true;
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
  worker: WorkerMatch,
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
  const taskIds = readTaskIds(ask.task_ids);
  const outcomes =
    parsed.answer === 'done' ? await claimCheckinTasks(db, worker, message.id, taskIds) : [];

  // Recorded either way; only the acknowledgement is suppressed, so Meta
  // retrying does not double-message the worker.
  if (redelivery) return true;

  await sendWhatsAppText(
    parsed.answer === 'done' ? doneAckBody(t, checkinDoneAck(outcomes.map(o => o.outcome))) : t.checkinNotDone,
    sendConfig,
  ).catch(err => {
    logEvent('whatsapp.checkin_ack_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // ── "…and a photo of it?" (issue #52) ──────────────────────────────────────
  // AFTER the acknowledgement, so the two messages arrive in the order a person
  // would say them, and inside the "done" branch only: "Ainda não" files
  // nothing and therefore has nothing to photograph. It sends AT MOST one extra
  // free-form message, and only when at least one task is genuinely waiting for
  // the manager — a tap that claimed nothing asks for nothing.
  //
  // Below the redelivery return above, deliberately. A Meta retry must not
  // re-ask (or re-open a request and reset the cursor) on a worker who is
  // already halfway through sending photos.
  if (parsed.answer === 'done') {
    await openPhotoFollowUp(db, worker, ask, outcomes, locale, sendConfig);
  }

  // ── the manager's thread (issue #47) ───────────────────────────────────────
  // The other half of the check-in. The cron writes "I asked these four people
  // whether they had finished"; this writes what came back, as it comes back.
  // Without it the manager gets an inbox row and a push for a claim Capo has
  // never heard of, and "did anyone report in today?" is answered from a board
  // read rather than from what actually happened.
  //
  // ── WHAT GOES IN, AND WHY IT IS NOT WORKER TEXT ──────────────────────────
  // Three inputs, and there is deliberately no fourth: the crew member's NAME
  // (typed by the manager on /perfil), which of two BUTTONS they tapped (an
  // enum minted by our own cron a few hours earlier, parsed by
  // parseCheckinPayload), and how many tasks were in the snapshot. A tap
  // carries no text at all, so nothing a worker wrote can reach `messages` here
  // — which matters because `messages` is the table thread.recentUserTexts
  // reads, and that is the evidence pool runGuarded matches a model's quote
  // against before executing a manager-level write directly (0027, AGENTS.md).
  // If this ever grows a `note` parameter, that boundary is gone.
  //
  // Placed AFTER the ack so the worker never waits on it, and after the
  // redelivery return above so Meta retrying a webhook cannot put two copies of
  // the same answer in the manager's thread. recordThreadEvent never throws.
  const eventLocale = await readThreadLocale(db, worker.company_id, coerceLocale(worker.company?.language));
  await recordThreadEvent(db, {
    companyId: worker.company_id,
    source: 'checkin_answer',
    text: renderCheckinAnswerEvent(
      { name: worker.name, answer: parsed.answer, tasks: taskIds.length },
      eventLocale,
    ),
  });
  return true;
}

/**
 * A tap on the GUIDED MENU — issue #49's "pre-made boxes".
 *
 * Returns true when this was a menu row AND the worker has been answered;
 * false to fall through to the ordinary path, which is where an interactive
 * reply of any other shape goes.
 *
 * ── NO MODEL IS INVOLVED, IN EITHER DIRECTION ──────────────────────────────
 * The row id is one this route minted itself, and the answer is rendered from
 * the task row. That is the whole point of the feature: "what am I doing on the
 * Casa de Paco?" is a database read, and paying a model to perform one is how
 * the crew channel became slow, expensive and occasionally wrong.
 *
 * ── THE TENANT BOUNDARY ON THIS PATH ───────────────────────────────────────
 * Everything runs on the SERVICE-ROLE client, so RLS enforces nothing.
 * findWorkerTask reads THIS worker's own open tasks — scoped by the company_id
 * and worker_id that the sender's phone/BSUID resolved to, never by anything on
 * the wire — and then looks for the tapped id IN that result. A guessed uuid,
 * including a colleague's real one, therefore never reaches the database as a
 * lookup and cannot be timed as an existence oracle. Same shape and same
 * reasoning as handleCheckinTap's notification_log read above; do not replace
 * it with a query on the tapped id.
 *
 * ── THE THREE BUTTON SHAPES ────────────────────────────────────────────────
 * This is the third tappable thing on this webhook and the second under
 * `type: 'interactive'`. An approval card's `button_reply` belongs to a
 * MANAGER and is handled far below, on a path sender resolution never routes a
 * worker to. What keeps them apart is that the id prefixes are pairwise
 * non-overlapping (`capo:approve|reject:`, `capo:checkin:`, `capo:wm:`), which
 * scripts/whatsapp-check.mts asserts in every direction.
 */
async function handleWorkerMenuTap(
  db: Db,
  message: WhatsAppMessage,
  worker: WorkerMatch,
  locale: Locale,
  sendConfig: WhatsAppSendConfig,
): Promise<boolean> {
  const listReply = message.interactive?.list_reply;
  if (!listReply) return false;

  const row = parseWorkerMenuRowId(listReply.id);
  if (!row) {
    logEvent('whatsapp.unknown_menu_row', {
      companyId: worker.company_id,
      workerId: worker.id,
      messageId: message.id,
    });
    return false;
  }

  const t = getCatalog(locale).whatsapp;

  // "Talk to the boss" — the deterministic answer to everything Capo cannot do
  // from here, and issue #49's "off-topic questions should get 'talk to your
  // manager', not an answer". It carries no id, so there is nothing to look up
  // and nothing to leak.
  if (row.kind === 'manager') {
    logEvent('whatsapp.menu_manager_row', { companyId: worker.company_id, workerId: worker.id });
    await sendWhatsAppText(t.workerMenuManagerReply, sendConfig).catch(() => {});
    return true;
  }

  let body: string;
  try {
    const task = await findWorkerTask(db, worker, row.taskId);
    // ONE sentence for "not yours" and for "no longer open" alike. Telling them
    // apart would answer a question the tapper is not entitled to ask, and a
    // crew member cannot act on the difference either way.
    body = task ? renderTaskDetail(task, locale) : t.workerMenuUnknownTask;
    logEvent('whatsapp.menu_task_opened', {
      companyId: worker.company_id,
      workerId: worker.id,
      found: !!task,
    });
  } catch (err) {
    logEvent('whatsapp.menu_task_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      error: err instanceof Error ? err.message : String(err),
    });
    body = t.workerAgentFailed;
  }

  // Silence after a tap reads as "Capo is broken" — the same rule the check-in
  // tap and the approval button both follow.
  await sendWhatsAppText(body, sendConfig).catch(err => {
    logEvent('whatsapp.menu_reply_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return true;
}

/**
 * "More photos" / "That is everything" — the two buttons Capo sends after a
 * bare photo (0047).
 *
 * Returns true when it was one of ours AND the crew member has been answered;
 * false to fall through, which is where a malformed or foreign payload goes.
 *
 * ── WHY THERE IS A DETERMINISTIC BRANCH HERE AT ALL ────────────────────────
 * A photo with no words used to reach the model, which had no way to know which
 * job it showed and so asked. The question was right and the timing was fatal:
 * the bytes lived for one turn, so the answer arrived after the photo had gone.
 * Now the photo is kept, and the question Capo asks first is the one it can act
 * on without a model at all: is another one coming.
 *
 * ── "THAT IS EVERYTHING" HAS TWO ENDINGS ───────────────────────────────────
 * If a check-in request is open, the task is already known (Capo named it
 * minutes ago) and every waiting photo is attached to it with no model
 * anywhere, exactly as a bare photo would have been. Otherwise the agent runs,
 * because working out which of this person's tasks they mean is the one part of
 * this that genuinely needs judgement, and it is now safe to spend a turn on:
 * the photos are not going anywhere.
 *
 * The payload carries no id. Which photos this settles comes from the crew
 * member's own phone-derived worker id and never from the tap.
 */
async function handlePhotoBatchTap(
  db: Db,
  message: WhatsAppMessage,
  worker: WorkerMatch,
  locale: Locale,
  sendConfig: WhatsAppSendConfig,
): Promise<boolean> {
  const buttonReply = message.interactive?.button_reply;
  if (!buttonReply) return false;
  const answer = parsePhotoBatchPayload(buttonReply.id);
  if (!answer) return false;

  const t = getCatalog(locale).whatsapp;

  if (answer === 'more') {
    // One line, nothing else. They are holding a phone in one hand on a
    // building site, and the next thing that should happen is another photo.
    logEvent('whatsapp.worker_photo_batch_more', { companyId: worker.company_id, workerId: worker.id });
    await sendWhatsAppText(t.photoBatchMoreAck, sendConfig).catch(() => {});
    return true;
  }

  const waiting = await loadInboxPhotos(db, worker.company_id, worker.id, Date.now());
  if (waiting.length === 0) {
    // Already attached, or expired. Says what to do rather than what went
    // wrong: the likeliest reader tapped an old message.
    logEvent('whatsapp.worker_photo_batch_empty', { companyId: worker.company_id, workerId: worker.id });
    await sendWhatsAppText(t.photoBatchNone, sendConfig).catch(() => {});
    return true;
  }

  // The whole waiting set is offered; handleCheckinPhoto narrows it to the
  // photos that arrived AFTER its request opened, and refuses the request
  // entirely when none did. An older batch therefore stays in the inbox for the
  // agent path rather than becoming proof of a task it has nothing to do with.
  if (await handleCheckinPhoto(db, { kind: 'inbox', photos: waiting }, worker, locale, sendConfig)) {
    logEvent('whatsapp.worker_photo_batch_claimed', {
      companyId: worker.company_id,
      workerId: worker.id,
      photos: waiting.length,
    });
    return true;
  }

  // No open request, so which task these are of is a real question. The turn
  // runs on a sentence of OUR own words rather than on the worker's, because a
  // tap carries none, and the model sees the same waiting photos in its
  // "# Photos received" block.
  logEvent('whatsapp.worker_photo_batch_to_agent', {
    companyId: worker.company_id,
    workerId: worker.id,
    photos: waiting.length,
  });
  await runWorkerTurn(db, message, worker, locale, sendConfig, {
    inboundPhotos: 0,
    overrideText: allPhotosSentText(waiting.length),
  });
  return true;
}

/**
 * Send the guided menu because the worker ASKED for it (AJUDA, MENU, ?).
 *
 * Free, and free by SHAPE rather than by policy: an interactive message is a
 * session message, so Meta bills nothing for it — but it is refused outright
 * outside the 24-hour window, which is why this only ever runs in reply to an
 * inbound message that opened one seconds ago.
 *
 * A worker with no open tasks gets a plain sentence instead of a list whose
 * only row is "talk to the boss".
 */
async function sendWorkerMenu(
  db: Db,
  worker: WorkerMatch,
  locale: Locale,
  sendConfig: WhatsAppSendConfig,
): Promise<void> {
  const t = getCatalog(locale).whatsapp;
  try {
    const menu = await loadWorkerMenu(db, worker, locale);
    if (!menu) {
      await sendWhatsAppText(t.workerMenuEmpty, sendConfig);
      return;
    }
    await sendWhatsAppList(menu.list, sendConfig);
    logEvent('whatsapp.menu_sent', {
      companyId: worker.company_id,
      workerId: worker.id,
      tasks: menu.tasks.length,
    });
  } catch (err) {
    logEvent('whatsapp.menu_send_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      error: err instanceof Error ? err.message : String(err),
    });
    await sendWhatsAppText(t.workerAgentFailed, sendConfig).catch(() => {});
  }
}

/**
 * Send the FULL free-form briefing because the worker answered the knock
 * (issue #108) — "OK", or DETALHE and friends.
 *
 * The same seams as the 07:00 in-window send, deliberately: loadWorkerBriefing
 * fans out the same task_board rows through the same BRIEFABLE filter,
 * renderWorkerFreeForm lays them out, and buildWorkerMenu wraps them in the
 * same tappable list where it fits — ONE fan-out, ONE renderer (AGENTS.md). A
 * second rendering of "your day" would eventually disagree with the morning
 * one, and a worker holding both messages could not tell which was right.
 *
 * ⚠ NO TEMPLATE FALLBACK, unlike the cron's deliverBriefing. This runs in
 * reply to inbound text, and a paid send triggered by inbound text is a
 * cost-amplification vector the sender controls — the same rule the agent
 * path's 131047 catch states. Out-of-window here means Meta and our clock
 * disagree about a window opened seconds ago: log it, send nothing.
 *
 * The /dia link rides along exactly as it does at 07:00. mintDayLinks is
 * idempotent per worker per Lisbon day, so answering the knock re-reads the
 * morning's token rather than minting a second live credential; a worker
 * whose 07:00 template could not carry the link (toTemplateParam flattens it,
 * AGENTS.md) gets it HERE, on their first reply — which is the follow-up the
 * /dia section of AGENTS.md left open.
 */
async function sendWorkerDayDetail(
  db: Db,
  worker: WorkerMatch,
  locale: Locale,
  sendConfig: WhatsAppSendConfig,
): Promise<void> {
  const t = getCatalog(locale).whatsapp;
  try {
    const briefing = await loadWorkerBriefing(db, {
      companyId: worker.company_id,
      workerId: worker.id,
      name: worker.name,
      recipient: sendConfig.recipient,
      locale,
      hasChosenLanguage: !!worker.language,
    });

    // One clock: the same lisbon_today() the cron and the /dia page read. A
    // failed clock costs the link line, never the reply — same posture as
    // mintDayLinks itself, which swallows every failure into a Map of nothing.
    const { data: today } = await db.rpc('lisbon_today');
    const links = today
      ? await mintDayLinks(db, { companyId: worker.company_id, workerIds: [worker.id], today })
      : new Map<string, string>();
    const token = links.get(worker.id);
    const body = renderWorkerFreeForm(briefing, {
      dayLinkUrl: token ? dayLinkUrl(token) : undefined,
    });

    // Lead tasks only behind the tappable rows, for the reason the cron gives:
    // a tap is answered by findWorkerTask, which knows only tasks this person
    // LEADS — offering a helper's task as a row would hand them a button that
    // answers "that task is not yours" about a task named two lines up.
    const menuTasks = briefing.tasks.filter(task => task.role === 'lead');
    const list = menuTasks.length === 0 ? null : buildWorkerMenu({ tasks: menuTasks, body, locale });

    if (list) {
      try {
        await sendWhatsAppList(list, sendConfig);
        logEvent('whatsapp.day_detail_sent', {
          companyId: worker.company_id,
          workerId: worker.id,
          tasks: briefing.tasks.length,
          path: 'menu',
        });
        return;
      } catch (err) {
        // Meta rejected OUR payload — a 4xx that is not the window. Plain text
        // carries more than the list could have, so fall through to it.
        // Anything else is rethrown: a socket reset may have delivered the
        // list already, and falling through would send the day twice. Same
        // narrowing, for the same reason, as deliverBriefing's.
        const rejected =
          err instanceof WhatsAppSendError && err.status >= 400 && err.status < 500 && err.code !== 131047;
        if (!rejected) throw err;
        logEvent('whatsapp.day_detail_list_rejected', {
          companyId: worker.company_id,
          workerId: worker.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await sendWhatsAppText(body, sendConfig);
    logEvent('whatsapp.day_detail_sent', {
      companyId: worker.company_id,
      workerId: worker.id,
      tasks: briefing.tasks.length,
      path: 'free_form',
    });
  } catch (err) {
    // 131047 = outside the free-form window. See the function comment: never
    // answered with a template, only logged — silence is the safe direction.
    if (err instanceof WhatsAppSendError && err.code === 131047) {
      logEvent('whatsapp.day_detail_window_expired', {
        companyId: worker.company_id,
        workerId: worker.id,
      });
      return;
    }
    logEvent('whatsapp.day_detail_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      error: err instanceof Error ? err.message : String(err),
    });
    // Silence after a reply the template itself asked for reads as "Capo is
    // broken" — the same rule every other tap and keyword follows.
    await sendWhatsAppText(t.workerAgentFailed, sendConfig).catch(() => {});
  }
}

/**
 * Did the photos this turn carried actually become evidence, or did nothing land?
 *
 * ── THE SIGNAL THAT DID NOT EXIST ──────────────────────────────────────────
 * `task_photos` held zero rows for the entire life of the product and no log
 * line anywhere said so. Every step that could lose a photo returned null in
 * silence, so "the crew never sends photos" and "the photo path is broken"
 * produced the identical empty log for a month, while a crew member sent four
 * photos in one morning and was told four times that nothing had arrived.
 *
 * ── WHAT IT MAY AND MAY NOT CALL A LOSS (0047) ─────────────────────────────
 * Before 0047 a photo lived for exactly one turn, so "nothing was attached"
 * meant "the bytes are gone". That is no longer true and this function must not
 * pretend it is: a staged photo waits in `worker_photo_inbox` for 24 hours and
 * is offered back on the next thing the crew member writes, which is the
 * DESIGNED path for a bare photo. Calling that a discard would fire an alarm on
 * the happy path and teach everybody to ignore the alarm.
 *
 * So the three outcomes are told apart rather than merged:
 *   attached  a `task_photos` row landed. The photo is evidence.
 *   waiting   nothing landed, and nothing needed to. The photos are staged and
 *             will be offered again. This is the ordinary bare-photo turn.
 *   discarded the turn carried bytes that were never staged (0047 unapplied, or
 *             Storage refused), so they were held in memory for this turn only
 *             and are now gone. The original bug, in the one window where it
 *             still happens.
 *
 * Counted from `task_photos` rather than taken from the tool result, because
 * the row is the only thing that settles the question, and scoped to this
 * worker and this turn so a colleague's photo cannot make a loss look like a
 * save. `created_at` is compared against a timestamp taken before the turn
 * began.
 *
 * Known and stated rather than hidden: `since` is this server's clock and
 * `created_at` defaults to the DATABASE's, so a few seconds of skew can read a
 * photo written by this turn as older than it. That errs toward `waiting` — the
 * quiet outcome — and never toward a false `attached`, which would mute the
 * alarm instead of raising a spurious one. Backdating `since` to cover the skew
 * would trade that the wrong way round: it could count the PREVIOUS turn's
 * photo and call a genuine loss a success.
 *
 * Never throws and never sends anything. One indexed count on a turn that has
 * already paid for a model call, and only on turns that carried a photo.
 */
async function reportPhotoOutcome(
  db: Db,
  worker: { id: string; company_id: string },
  message: WhatsAppMessage,
  counts: { inbound: number; unstaged: number },
  since: string,
): Promise<void> {
  const base = {
    companyId: worker.company_id,
    workerId: worker.id,
    messageId: message.id,
    // How many photos rode this message, and how many of those never reached
    // the inbox and therefore only existed for this turn.
    inbound: counts.inbound,
    unstaged: counts.unstaged,
  };
  try {
    const { count, error } = await db
      .from('task_photos')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', worker.company_id)
      .eq('worker_id', worker.id)
      .gte('created_at', since);
    if (error) {
      logEvent('whatsapp.worker_photo_outcome_unknown', { ...base, error: error.message });
      return;
    }
    const stored = count ?? 0;
    if (stored > 0) {
      logEvent('whatsapp.worker_photo_attached', { ...base, stored });
      return;
    }
    // Grep `whatsapp.worker_photo_discarded`. A run of these against a crew
    // that is plainly sending photos is bytes being thrown away, not a quiet
    // week — and it means 0047 is not doing its job on this deployment.
    logEvent(
      counts.unstaged > 0 ? 'whatsapp.worker_photo_discarded' : 'whatsapp.worker_photo_waiting',
      { ...base, stored },
    );
  } catch (err) {
    logEvent('whatsapp.worker_photo_outcome_unknown', {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    });
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
 * ── THE ONE-TURN PHOTO LIMIT IS GONE (0047) ─────────────────────────────────
 * This comment used to record a known limit: photos lived for exactly one turn,
 * so "photo, then a separate message saying which task" lost the photo and
 * three photos sent as three messages attached only the last. On 3 September a
 * crew member hit it and wrote "I tried 3 times now. Is not working".
 *
 * Every inbound image is now downloaded and STAGED before any branch decides
 * what it is (stageInboundPhoto, lib/worker-photo-inbox.ts), so what this turn
 * works with is every photo of theirs that no task has claimed yet, loaded
 * inside handleWorkerInbound from `worker_photo_inbox`. The bytes never come
 * near this function and never near a model.
 *
 * `checkin_photo_requests` (0034) is unchanged and still stages the
 * EXPECTATION rather than the bytes: which task the NEXT bare photo is of. The
 * two answer different questions and both are needed.
 */
async function runWorkerTurn(
  db: Db,
  message: WhatsAppMessage,
  worker: { id: string; company_id: string },
  locale: Locale,
  sendConfig: WhatsAppSendConfig,
  /**
   * How many photos arrived with THIS message and were staged, and the words to
   * run the turn on when the message itself carried none. The override exists
   * for the "that is all the photos" tap, which is a button and has no text at
   * all; everything else reads the message.
   */
  opts: {
    inboundPhotos: number;
    overrideText?: string;
    /** Bytes that could not be staged (0047 unapplied, or Storage refused).
     *  Normally empty; see StagedPhoto.photo. */
    fallbackPhotos?: readonly PendingPhoto[];
  },
): Promise<void> {
  const t = getCatalog(locale).whatsapp;

  // Taken BEFORE anything in this turn can write a row, so a photo attached at
  // any point inside it falls within the window reportPhotoOutcome asks about.
  const turnStartedAt = new Date().toISOString();

  const text =
    opts.overrideText ??
    (message.type === 'image' ? (message.image?.caption ?? '') : (message.text?.body ?? ''));

  // ── the voice note (W4) ────────────────────────────────────────────────────
  // Handed to handleWorkerInbound as a RECIPE rather than a result, so the
  // download and the Gemini call happen below its daily budget read instead of
  // in front of it. Transcribing here would spend real money on a crew member
  // who has no allowance left, on every voice note, for ever.
  //
  // The reason is captured in this closure so the log line below can name which
  // half failed without the failure classification leaving worker-audio.ts.
  const audio = isWorkerAudioMessage(message) ? message.audio : undefined;
  let audioFailure: WorkerAudioFailure | null = null;
  let audioError: string | undefined;
  const transcribe = audio
    ? async (): Promise<string | null> => {
        const heard = await transcribeWorkerAudio({
          db,
          companyId: worker.company_id,
          workerId: worker.id,
          locale,
          mediaId: audio.id,
          // The same token the caller staged this message's photos with: since
          // W5 the photo download moved out of this function, so there is no
          // longer a separate accessToken parameter to carry.
          accessToken: sendConfig.accessToken,
        });
        if (heard.ok) return heard.text;
        audioFailure = heard.reason;
        audioError = heard.error;
        return null;
      }
    : undefined;

  // Nothing said and nothing staged leaves nothing for the model to answer. A
  // photo that failed to arrive has already been answered by the caller, so
  // running a turn here would spend a slice of their daily budget to say
  // nothing.
  //
  // A voice note is exempt: its text does not exist yet, by design.
  if (!text.trim() && opts.inboundPhotos === 0 && !transcribe) return;

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
      inbound: { channel: 'whatsapp', text, transcribed: !!transcribe, transcribe },
      // Meta's own id for this message. It is what the no-photo waiver (0049)
      // counts with, so three tool calls inside one turn share it and count as
      // one ask.
      inboundMessageId: message.id,
      inboundPhotos: opts.inboundPhotos,
      fallbackPhotos: opts.fallbackPhotos,
      sink,
    });

    if (result.outcome === 'unintelligible') {
      // The transcription ran and produced nothing usable. It DID consume a
      // unit of the daily budget - see UNINTELLIGIBLE_AUDIO_TEXT in
      // worker-core.ts - so a failing voice note is not free to repeat.
      logEvent('whatsapp.worker_audio_failed', {
        companyId: worker.company_id,
        workerId: worker.id,
        messageId: message.id,
        reason: audioFailure ?? 'empty',
        // Never the transcript and never the audio, only our own error string.
        error: audioError,
      });
      // Silence after a voice note reads as "Capo is broken", which is the whole
      // bug. One line for all three causes, and it names the way out.
      await sendWhatsAppText(t.workerAudioFailed, sendConfig).catch(() => {});
      return;
    }

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
      photos: opts.inboundPhotos,
      // Whether this turn started life as a voice note. Never the transcript.
      transcribed: !!transcribe,
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
  } finally {
    // Inside the `finally`, so a turn that threw on its way to answering still
    // records what became of the photo. That is precisely the turn most likely
    // to have lost one.
    const unstaged = opts.fallbackPhotos?.length ?? 0;
    if (opts.inboundPhotos > 0 || unstaged > 0) {
      await reportPhotoOutcome(
        db,
        worker,
        message,
        { inbound: opts.inboundPhotos, unstaged },
        turnStartedAt,
      );
    }

    // ── the crew's requests reach the manager (issue #152) ──────────────────
    // AFTER the turn and OUTSIDE the try/catch, because a request already
    // written by `ask_manager` must be announced even if the turn then failed
    // on its way to answering the crew member — the row exists, the manager's
    // inbox entry exists, and only the announcement would be missing.
    //
    // A sweep over `manager_notified_at is null` rather than something the turn
    // hands back, for the reason /api/cron/welcome is a sweep: the tool result
    // does not reach this function, and a hook that has to remember an event is
    // a hook somebody eventually forgets. The partial index makes the query
    // proportional to what is unannounced, which on almost every turn is
    // nothing.
    //
    // Swallowed twice over (inside, and here): telling the manager must never
    // cost the crew member their reply.
    await pingManagersAboutRequests(
      db,
      worker.company_id,
      { accessToken: sendConfig.accessToken, phoneNumberId: sendConfig.phoneNumberId },
    ).catch(() => {});
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
  /** When the webhook arrived — the proof of the free-form window (issue #50). */
  inboundAt: number,
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
  // What this person actually TYPED, and undefined for everything else - a tap,
  // a photo, and since W4 a voice note. Every keyword table below is reached
  // through this one value rather than through five copies of the same
  // `type === 'text'` guard; see keywordText for why a transcript must never
  // become one of them.
  const typed = keywordText(message);
  const requested = languageCommand(typed);
  const consent = consentCommand(typed);
  // Computed here beside the other two rather than at its branch, for the two
  // reasons they are: the `type === 'text'` guard is written once, and the log
  // line below can record which of the three deterministic branches a message
  // took. Without that, "the agent answered a message that should have been a
  // menu" is invisible.
  const wantsMenu = menuCommand(typed);
  // The knock's answer (issue #108) — "OK", or asking for the detail in a word.
  const wantsDetail = detailCommand(typed);

  logEvent('whatsapp.worker_reply', {
    companyId: worker.company_id,
    workerId: worker.id,
    messageId: message.id,
    type: message.type,
    // The message body is deliberately NOT logged — it is third-party content.
    // These are the recognised keywords, not the text, so they are safe.
    languageCommand: requested ?? undefined,
    consentCommand: consent ?? undefined,
    menuCommand: wantsMenu || undefined,
    detailCommand: wantsDetail || undefined,
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

  // ── "seen", and "working on it" (issue #50) ────────────────────────────────
  // Above every branch below, because all of them answer: a crew member always
  // gets a reply of some kind, so the tick is always honest.
  //
  // The typing indicator is NOT always honest, which is why it is conditional.
  // A tap, a STOP or a language keyword is answered from a lookup in
  // milliseconds; only a text or a photo can start a model turn worth waiting
  // for. It is a slightly wider net than the branch that actually runs the
  // agent — STOP and the language keywords are text too — because an indicator
  // that flickers before an instant answer is ordinary chat behaviour, while
  // missing one on a slow turn is the bug being fixed.
  //
  // hasText/hasPhoto are computed HERE, once, and reused by that branch far
  // below rather than recomputed beside it: two copies of the same expression
  // would eventually disagree, and the symptom would be a turn that runs the
  // agent with no indicator (or an indicator with no turn behind it).
  //
  // The emptiness checks mirror the manager triage further down: a `text`
  // message with no body and an `image` with no media id are both things Meta
  // can send, and neither is worth a model turn against a daily budget.
  //
  // This stays entirely on the WORKER path. It sends nothing to a manager and
  // reads nothing a worker wrote; a read receipt carries only a message id.
  const hasText = message.type === 'text' && !!message.text?.body?.trim();
  const hasPhoto = message.type === 'image' && !!message.image?.id;
  // A voice note (W4). It joins the other two here rather than beside the agent
  // gate for the same reason they are computed here: one expression, one place.
  // It is the SLOWEST of the three by some distance - a download and a
  // transcription happen before the agent even starts - so the typing indicator
  // matters most on this one.
  const hasAudio = isWorkerAudioMessage(message);
  await acknowledgeInbound(message.id, sendConfig, {
    typing: hasText || hasPhoto || hasAudio,
    companyId: worker.company_id,
  });

  // ── THE PHOTO IS KEPT BEFORE ANYTHING DECIDES WHAT IT IS (0047) ───────────
  // Above every branch that could take an image, and that placement is the
  // whole fix. Before it, a bare photo with no open check-in request fell to
  // the agent, which asked which task it was for, and the bytes were gone by
  // the time the crew member answered. Meta's media URL lasts about five
  // minutes and is effectively single-use, so there is no second chance to
  // download it later.
  //
  // Staged into the company's own inbox prefix in the task-photos bucket, with
  // no `task_photos` row: a photo waiting is not evidence of anything yet. What
  // makes it evidence is being attached to a task, and that still happens in
  // exactly the two places it always did.
  //
  // The keyword branches below are all gated on `type: 'text'`, so nothing
  // between here and the photo branches can consume an image. This sits above
  // them anyway, because "the photo is kept first" is easier to keep true than
  // "the photo is kept before the branches that could eat it".
  const staged: StagedPhoto = hasPhoto
    ? await stageInboundPhoto(db, message, worker, env.accessToken)
    : { photoId: null, photo: null, failed: false };

  // ⚠ A STAGING FAILURE MUST NEVER LOSE A PHOTO THE OLD PRODUCT WOULD HAVE
  // KEPT. Staging fails on EVERY request between deploying 0047 and applying it
  // (42P01), and on this project a migration has sat merged and unapplied for
  // three weeks while the app half was live. If that window were also a window
  // in which nobody could attach a photo to anything, this branch would produce
  // the exact 3 September symptom it exists to end, on every crew member at
  // once.
  //
  // So the download is what matters, not the staging: when the bytes are here,
  // every branch below falls back to what it did before 0047 — the check-in
  // photo path writes them straight to the task, and the agent turn carries
  // them as this turn's photos. Only a failed DOWNLOAD is worth an apology,
  // because only then is there nothing to work with.
  if (staged.failed && !staged.photo) {
    await sendWhatsAppText(getCatalog(current).whatsapp.workerPhotoFailed, sendConfig).catch(() => {});
    // A CAPTIONED photo still falls through to the agent: they wrote something,
    // and it deserves an answer even though the image did not survive.
    if (!message.image?.caption?.trim()) return true;
  }

  // The welcome's "Say hi" tap. ABOVE the two taps below, and that position is
  // the whole reason it is here rather than beside them: it arrives under BOTH
  // `type: 'button'` and `type: 'interactive'` (the template and the free-form
  // twin carry the same payload in different envelope fields), so leaving it
  // below would make every hello log `whatsapp.unknown_checkin_payload` —
  // which is supposed to mean the check-in template lost its button component.
  // See notifications/welcome-hi.ts.
  if (isHiTap(message)) {
    await answerWorkerHi(db, worker, current, sendConfig);
    return true;
  }

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

  // The GUIDED MENU tap (issue #49). Sits beside the check-in tap because it is
  // the same kind of thing — a tap on something we sent, answered from a lookup
  // with no model anywhere in the loop — and below it because the two shapes
  // are disjoint (`type: 'button'` vs `type: 'interactive'`), so the order only
  // decides which check pays for the miss.
  //
  // ABOVE the agent branch far below, which is the whole design: "what am I
  // doing on the Casa de Paco?" is a database read, and a tap says which row.
  if (message.type === 'interactive' && (await handleWorkerMenuTap(db, message, worker, current, sendConfig))) {
    return true;
  }

  // The PHOTO BATCH tap (0047) — "more photos" / "that is everything". The
  // fourth tappable shape and the third under `type: 'interactive'`, beside the
  // menu tap because it is the same kind of thing: a tap on something we sent,
  // answered from a lookup, with no model in the loop unless the second button
  // needs one to work out which task the photos are of.
  //
  // Below the menu tap and above everything else, which is safe in both
  // directions: the two read DIFFERENT members of the same envelope
  // (`list_reply` vs `button_reply`) and the four payload prefixes are pairwise
  // non-overlapping, asserted by pnpm whatsapp-check.
  if (message.type === 'interactive' && (await handlePhotoBatchTap(db, message, worker, current, sendConfig))) {
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

  // ── "REPORT A PROBLEM" (issue #120) ────────────────────────────────────────
  // The fourth keyword table, plus the "your next message is the report"
  // capture it arms. Deterministic and in front of the agent like the three
  // around it, for the issue's own reason: a report that Capo is misbehaving
  // must never depend on Capo's model behaving.
  //
  // Its position in the order is load-bearing in both directions:
  //   - BELOW consent, because STOP must always unsubscribe (Meta requires
  //     opt-outs honoured) — the one message the armed capture does not get to
  //     keep, and the only carve-out from its promise.
  //   - ABOVE the language and menu keywords, because the prompt promised
  //     "your next message is registered", and honouring that promise — even
  //     for a message that happens to say "ajuda" or "ES" — is simpler and
  //     more honest than a list of exceptions the sender cannot see. The
  //     request expires after 30 minutes, so the cost of the promise is
  //     bounded.
  //
  // The text, when consumed, goes to `problem_reports` and NOWHERE else — in
  // particular never to `worker_messages`, because a report is mail to the
  // operator, not conversation with Capo.
  if (typed) {
    const consumed = await handleProblemReportMessage(
      db,
      { audience: 'worker', companyId: worker.company_id, workerId: worker.id },
      typed,
      current,
      sendConfig,
      message.id,
    );
    if (consumed) return true;
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

  // THE MENU KEYWORD — AJUDA / MENU / TAREFAS / ? (issue #49).
  //
  // BELOW the language keyword deliberately, even though the two sets are
  // disjoint and the order cannot change any outcome. Keeping `requested`
  // first is what makes the invariant visible where it is enforced: a bare
  // "ES" resolves to Spanish above this line, with zero model calls, and no
  // later branch can take it.
  //
  // ABOVE the agent, which is the change this issue is about. Before it, every
  // text a crew member sent bought a model turn — including "ajuda", which is
  // a request for a list we can render from a table.
  if (wantsMenu) {
    await sendWorkerMenu(db, worker, current, sendConfig);
    return true;
  }

  // THE KNOCK'S ANSWER — OK / DETALHE (issue #108). The paid morning template
  // can only carry one flat line, so since #108 it knocks ("3 tarefas hoje —
  // responde OK para veres o detalhe") and THIS is where the promised reply
  // lands. The worker's own message just opened Meta's free-form window, so
  // the full briefing — the same one an in-window worker gets at 07:00 — is
  // now legal and free. Zero model calls, same family as the menu keyword
  // above; disjoint from all three older tables, so the order between them
  // cannot change any outcome.
  if (wantsDetail) {
    await sendWorkerDayDetail(db, worker, current, sendConfig);
    return true;
  }

  // ── THE CHECK-IN PHOTO (issue #52) ─────────────────────────────────────────
  // A BARE photo — no caption — while Capo is waiting for one it asked for by
  // name. Which task it belongs to was decided by the message Capo itself sent
  // minutes ago, so this is a lookup and a write, with no model anywhere in the
  // loop. Same family as the check-in tap and the menu tap, and here for the
  // same reason: the deterministic thing happens in front of the model, never
  // instead of it.
  //
  // ⚠ A CAPTIONED photo is deliberately EXCLUDED and falls through to the
  // agent. A caption is words, and words can say something this branch cannot
  // read — "esta é da outra tarefa", "acabei mas falta o rodapé". The agent has
  // `declare_task_done`, which names its own task and attaches photos to it, so
  // the captioned flow already works and taking it over here would answer a
  // sentence by ignoring it.
  //
  // Returns false when there is no open request, which is every crew member who
  // never tapped — their photos reach the agent exactly as before.
  if ((staged.photoId || staged.photo) && !message.image?.caption?.trim()) {
    // Staged, or the pre-0047 fallback with the bytes still in hand.
    const source: CheckinPhotoSource = staged.photoId
      ? { kind: 'inbox', photos: [{ id: staged.photoId, receivedAt: new Date().toISOString() }] }
      : { kind: 'bytes', photo: staged.photo! };
    if (await handleCheckinPhoto(db, source, worker, current, sendConfig)) {
      return true;
    }
    // No open request, which is every crew member who never tapped. Before 0047
    // the photo went to the agent here and the conversation went wrong: the
    // model asked which task, and the answer arrived after the photo had gone.
    //
    // Now the photo is safe, so the cheap deterministic thing happens first.
    // Capo says how many it is holding and offers two buttons, which is the
    // question a bare photo actually raises. Working out which job they are of
    // waits until they say there are no more coming, when it can be asked once
    // instead of after every photo.
    if (staged.photoId) {
      await askAboutMorePhotos(db, worker, current, sendConfig);
      return true;
    }
    // Nothing was staged, so there is no batch to ask about and nothing that
    // survives this request. Fall through to the agent with the bytes, which is
    // precisely what a bare photo with no open request did before 0047.
  }

  // ── the restricted agent (PRD 4) ──────────────────────────────────────────
  // BELOW every deterministic branch above, and that ordering is the design:
  // the check-in tap, the menu tap, the menu keyword, STOP/START and the
  // language keyword are free, instant and already right, so a model must never
  // be able to get at them first.
  //
  // Text, photos and VOICE NOTES. The third one reverses PRD 4's explicit
  // decision to let a worker's audio fall to the generic ack below, and the
  // reason it reverses is not that the cost argument was wrong: it is that crew
  // on site talk far more than they type, so "one extra model call" was being
  // paid for by the people the channel exists for. See apps/web/lib/worker-audio.ts.
  //
  // The transcription happens INSIDE runWorkerTurn, below withProgressNote, so
  // the "still on it" note covers the download and the transcription too - the
  // turn that most needs the reassurance is exactly the one that spends ten
  // seconds before the model starts.
  //
  // ⚠ A TRANSCRIPT DOES NOT REACH THE KEYWORD TABLES ABOVE. All five of them
  // read `message.type === 'text'`, so a spoken "stop", "ajuda" or "ES" lands
  // here and is answered by the agent instead. That is the correct side of the
  // trade: those tables exist so a model can never intercept a tap, and a
  // transcript is already model output. The written STOP is still the
  // unsubscribe, and it is the one Meta requires and the one every message names.
  //
  // hasText/hasPhoto/hasAudio are computed once, up beside the read receipt — see
  // the note there for why they are not recomputed here.
  if (hasText || hasPhoto || hasAudio) {
    // Same single-shot progress note as the manager path, in the crew member's
    // own language, and free for the same reason: their message opened the
    // window seconds ago. A worker turn is usually quick, but a photo download
    // plus a knowledge-base lookup can outlast the 25-second indicator.
    await withProgressNote(
      () =>
        runWorkerTurn(db, message, worker, current, sendConfig, {
          inboundPhotos: staged.photoId || staged.photo ? 1 : 0,
          // Empty unless staging failed. The turn then behaves exactly as it
          // did before 0047: the bytes live for this turn, and
          // declare_task_done writes them with the pre-0047 writer.
          fallbackPhotos: !staged.photoId && staged.photo ? [staged.photo] : [],
        }),
      {
        inboundAt,
        send: async () => {
          await sendWhatsAppText(getCatalog(current).whatsapp.workerStillWorking, sendConfig);
        },
        report: (outcome, error) =>
          logEvent('whatsapp.progress_note', {
            companyId: worker.company_id,
            workerId: worker.id,
            messageId: message.id,
            audience: 'worker',
            outcome,
            error,
          }),
      },
    );
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

  // WHEN THIS WEBHOOK ARRIVED — and therefore the moment Meta's 24-hour
  // free-form window opened for whoever sent it (issue #50). Read once, here,
  // and passed down to every path that may spend a free-form message on a
  // progress note. Taken from the runtime rather than the message's own
  // `timestamp` field deliberately: the wire value is the SENDER's clock, and
  // the thing being bounded is how long OUR turn has been running.
  const inboundAt = Date.now();

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
  if (routed.unreadableStatuses > 0) {
    logEvent('whatsapp.delivery_status_unreadable', { count: routed.unreadableStatuses });
  }

  // Delivery receipts (issue #51, B4). After the response, like the rotations
  // above: nothing here answers anybody, and Meta retries a non-200, so a slow
  // ledger write must never hold up the ack.
  if (routed.statuses.length > 0) {
    after(() => recordDeliveryStatuses(db, routed.statuses));
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
        const handled = await handleWorkerReply(db, message, sender, { accessToken, phoneNumberId }, inboundAt);
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

    // ── The welcome's "Say hi" tap ─────────────────────────────────────────
    // A manager is welcomed too, with the same button. Above the approval
    // branch because a hello arriving as `interactive` would otherwise be read
    // as an unparseable proposal id and logged as `whatsapp.unknown_button`,
    // and above the triage because a hello arriving as `button` (the template
    // envelope) would be dropped as an unsupported type.
    //
    // Answered here rather than through handleInbound: it is a tap on something
    // we sent, and the answer is one sentence we already hold. See
    // notifications/welcome-hi.ts.
    if (isHiTap(message)) {
      after(async () => {
        await acknowledgeInbound(message.id, sendConfig, { typing: false, companyId });
        await answerManagerHi(companyId, locales.user, sendConfig);
      });
      continue;
    }

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
        // Blue ticks, and NO typing indicator (issue #50). The decision is
        // resolved from a lookup and answered in well under a second, so an
        // indicator would flash and vanish; the tick is the honest signal that
        // the tap registered. Never throws — a failed receipt must not cost the
        // manager their confirmation.
        await acknowledgeInbound(message.id, sendConfig, { typing: false, companyId });
        try {
          const resolution = await resolveProposal(db, button.proposalId, button.decision, locales, siteUrl());
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

        // ── the crew hears about a new task now, not tomorrow at 07:00 (W7) ─
        // The card path is a door too: `apply_plan` can assign a whole obra in
        // one tap. Symmetric with the web proposals route — without this line
        // a manager approving over WhatsApp waits for the fifteen-minute cron.
        // Outside the try/catch, because the write has already happened even
        // if the confirmation failed to send. It never throws.
        await drainAssignmentNotices({ companyId });
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
      // ── "Capo is working on it" (issue #50) ─────────────────────────────
      // FIRST, above the transcription and above the agent loop, because this
      // is the whole point: the manager has been staring at a blank screen
      // since they hit send. Two blue ticks plus a typing indicator, in ONE
      // Graph call, and it never throws — if it fails, the reply still goes.
      //
      // `typing: true` is honest here: an answer really is coming, and Meta
      // asks that the indicator only be shown when one is. It lapses after 25
      // seconds on its own; withProgressNote below covers what happens then.
      //
      // Free by construction — a status update is not a message, so there is
      // no template and nothing to bill. See lib/whatsapp-feedback.
      await acknowledgeInbound(message.id, sendConfig, { typing: true, companyId });

      // ── "REPORT A PROBLEM" (issue #120) ─────────────────────────────────
      // The same deterministic keyword flow the worker path runs, and the
      // first keyword table the MANAGER path consults at all. It sits ABOVE
      // handleInbound for the issue's stated reason, sharpened by 31 Aug
      // (issue #126): when the model provider is down or out of credit, "bug"
      // must still file — the message that says Capo is broken cannot be
      // routed through the broken part.
      //
      // A consumed message never reaches handleInbound and is therefore never
      // persisted to `messages`: a report is mail to the operator, not
      // conversation, and keeping the manager's own reports out of the thread
      // keeps the isolation story uniform with the crew's (#22's sweep stays
      // simple). Voice notes are deliberately excluded — recognising a spoken
      // "bug" needs a transcription model, which is exactly the dependency
      // this path exists to avoid; a dictated report reaches the agent as
      // always. One known wrinkle follows from that: a manager who is ARMED
      // and answers with a voice note gets an agent turn, and their next TEXT
      // within 30 minutes is still captured as the report.
      if (message.type === 'text') {
        const consumed = await handleProblemReportMessage(
          db,
          { audience: 'manager', companyId, profileId: userId },
          message.text!.body,
          locales.user,
          sendConfig,
          message.id,
        );
        if (consumed) return;
      }

      // The turn itself: media download, transcription, and the agent loop.
      // Extracted so withProgressNote below can wrap ALL of it. Wrapping only
      // the agent loop would start the clock after a voice note had already
      // spent ten seconds being transcribed — precisely the turn that needs the
      // reassurance most.
      const runTurn = async (): Promise<void> => {
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
              // Whose token spend this is (issue #53). This branch is the
              // MANAGER's voice note. A crew member's voice note is transcribed
              // too since W4, but on the worker path and through
              // apps/web/lib/worker-audio.ts, which files the spend against the
              // worker instead - it never reaches this call.
              profileId: userId,
              locale: locales.user,
              audio: media.bytes,
              mediaType: media.mediaType,
              // See VocabularyScope. The manager's own company's names, which
              // is what the worker path may NOT have.
              vocabulary: 'company',
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
            appUrl: siteUrl(),
            // Reaching one crew member (issue #123). `db` is already the
            // service client on this path, and `accessToken`/`phoneNumberId`
            // are the same pair this route sends every other message with, so
            // the messenger writes to the same ledger the crons do. See
            // notifications/worker-message.ts for the delivery ladder.
            messageWorker: whatsappWorkerMessenger(() => db, { accessToken, phoneNumberId }),
            inbound: { channel: 'whatsapp', text, transcribed },
            sink,
          });
          await delivery;
        } catch (err) {
          console.error(`whatsapp: failed handling message ${message.id}:`, err);
          // Two failures share this catch and the operator must be able to
          // grep them apart (issue #126): `turn_failed` is the agent breaking
          // — a model refusal leaves NO other trace, because `recordUsage`
          // only fires on success, so `ai_usage` going quiet reads as low
          // traffic — while `send_failure` stays what it always was, Meta
          // refusing a send we produced.
          logEvent(
            err instanceof WhatsAppSendError ? 'whatsapp.send_failure' : 'whatsapp.turn_failed',
            { companyId, messageId: message.id, error: err instanceof Error ? err.message : String(err) },
          );
          // 131047 = outside the 24h window. The apology is free-form and
          // would be refused the same way — same rule as the worker path.
          if (err instanceof WhatsAppSendError && err.code === 131047) return;
          // Silence here is the 31 Aug failure: ten messages, 75 minutes, no
          // reply and no error. Below sender resolution by construction — this
          // catch only exists inside the resolved-manager branch. Swallows its
          // own failures and suppresses repeats; see lib/turn-failure.
          await sendTurnFailureReply(db, {
            companyId,
            messageId: message.id,
            locale: locales.user,
            sendConfig,
          });
        }
      };

      // ONE "still working on it" if the turn outlasts the typing indicator.
      //
      // Free-form text inside the window THIS webhook opened, so it costs
      // nothing — and withProgressNote asserts that rather than assuming it,
      // because the recovery path for a free-form send that lands outside the
      // window is a PAID template. The timer is single-shot and always cleared;
      // see lib/whatsapp-feedback for why there is deliberately no keep-alive.
      await withProgressNote(runTurn, {
        inboundAt,
        send: async () => {
          await sendWhatsAppText(t.whatsapp.stillWorking, sendConfig);
        },
        report: (outcome, error) =>
          logEvent('whatsapp.progress_note', {
            companyId,
            messageId: message.id,
            audience: 'manager',
            outcome,
            error,
          }),
      });

      // Two follow-ups, and they are INDEPENDENT of each other: each is
      // wrapped so a throw in one can never cost the other its run. Both
      // already swallow and log their own failures, so neither catch is
      // expected to fire; it is here because they now share one after().

      // ── the crew hears about a new task now, not tomorrow at 07:00 (W7) ──
      // AFTER the turn, because the manager's "põe o Miguel na pintura de
      // hoje" only becomes a queued notice once the write has happened. One
      // line, and it never throws: announcing an assignment must never cost
      // the manager their answer. The fifteen-minute cron is the safety net
      // if this line is ever lost.
      await drainAssignmentNotices({ companyId }).catch(() => {});

      // A manager turn on WhatsApp can add a crew member and record their
      // consent in one sentence, exactly as the web chat can. One line, after
      // the turn, and it cannot throw — see lib/welcome-trigger.ts. It takes
      // only the company id: the sweep re-derives who is owed a welcome, so
      // nothing here has to know what the turn did.
      await welcomeAnyoneNew(companyId, 'whatsapp').catch(() => {});
    });
  }

  return NextResponse.json({ received: true });
}
