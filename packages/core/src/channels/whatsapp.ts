import { isToolUIPart, readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import type { OutboundSink } from './types';
import { toWhatsAppMarkdown } from './whatsapp-markdown';
import { applyWhatsAppVoice, type VoiceRepair } from './voice';

// WhatsApp channel sink: consumes the assistant's UIMessageChunk stream and
// posts it via the Meta Graph API `messages` endpoint.
//
// This sink used to flatten the turn to `type === 'text'` parts only. That
// silently dropped every approval card, because a card is a TOOL OUTPUT part
// (`{ status: 'proposed', proposalId, renderedText }` — see
// capabilities/propose.ts, guard.ts and plan.ts). Combined with the prompt
// rule that forbids the model from restating a card in its own words, the
// manager on WhatsApp was told an approval card had appeared and then handed
// nothing at all. Cards now travel as native WhatsApp interactive reply
// buttons, resolved by the webhook with no model in the loop — the same
// deterministic path the web card uses.
//
// Config is injected by the caller (the webhook route reads env and the copy
// catalog); this package never touches process.env, and never imports
// @capo/i18n/catalog — UI strings must not enter the agent bundle.
//
// 24-hour window note: this SINK only ever REPLIES to an inbound message, so
// it is always inside Meta's 24h customer-service window, where free-form text
// AND interactive messages are both allowed. The daily reminder cron is the
// opposite case — it messages someone who has not written to us — so
// `sendWhatsAppTemplate` below exists for it.
//
// The window rule that catches people out: sending a template does NOT open
// the window. Only the RECIPIENT's reply does. A worker who never replies
// therefore needs a paid template every single day, which is why the webhook
// acknowledges worker replies (see apps/web/app/api/whatsapp/route.ts) —
// that ack is what converts them to free session messages.
// (See docs/whatsapp-cloud-api-runbook.md.)

/**
 * WHO a message is addressed to — and, structurally, WHICH ENVELOPE FIELD it
 * travels in. The two are not interchangeable on Meta's side.
 *
 * A phone goes in `to`. A BSUID goes in a separate sibling property `recipient`.
 * Put a BSUID in `to` and the send is simply rejected. Sending BOTH is legal and
 * `to` silently wins, which is exactly why post() emits one XOR the other: with
 * only one on the wire, the response tells us unambiguously which identity Meta
 * actually used.
 *
 * A discriminated union rather than a bare string ON PURPOSE. It makes the wrong
 * envelope unrepresentable at compile time, and `tsc --noEmit` runs per package
 * under "strict": true — which, in a repo with no test suite, is one of the few
 * places a mistake can be caught before production. The same shape is what keeps
 * apps/web/lib/whatsapp.ts's E.164 → wa_id digit surgery unreachable from the
 * BSUID branch: it is applied when CONSTRUCTING a `phone` recipient and there is
 * no code path from a `bsuid` one to it.
 */
export type WhatsAppRecipient =
  | { kind: 'phone'; waId: string }
  | { kind: 'bsuid'; userId: string };

/**
 * Everything needed to TALK to the Graph API, with no statement about who is
 * being addressed.
 *
 * Split out of WhatsAppSendConfig for one structural reason: a read receipt and
 * a typing indicator are addressed by the INBOUND MESSAGE ID, not by a
 * recipient, and carry no `to`/`recipient` field at all. Taking the narrower
 * type means those two calls have no access to a recipient they must not emit —
 * the same "make the wrong envelope unrepresentable" reasoning as
 * WhatsAppRecipient itself.
 */
export interface WhatsAppApiConfig {
  accessToken: string;
  phoneNumberId: string;
  /** Overridable for tests; defaults to the live Graph API. */
  graphApiBase?: string;
}

export interface WhatsAppSendConfig extends WhatsAppApiConfig {
  /** Who to send to, and which envelope field carries them. */
  recipient: WhatsAppRecipient;
}

// Localized approval copy. INJECTED rather than imported: @capo/core depends on
// @capo/i18n/locale only, never on the copy catalog (AGENTS.md).
export interface ApprovalLabels {
  /** Button label. Meta hard limit: 20 chars, and must differ from `reject`. */
  approve: string;
  /** See `approve`. */
  reject: string;
  /** Interactive body when the card itself was over Meta's 1024-char limit. */
  prompt: string;
  /** Sent as plain text when the interactive send itself fails, so a dead end
   *  becomes an instruction: the proposal row exists and is still resolvable
   *  in the web chat. */
  fallback: string;
}

export interface WhatsAppSinkConfig extends WhatsAppSendConfig {
  // Required, not optional-with-default: an optional field would let a caller
  // silently ship an empty button title, which Meta answers with a 400 at
  // runtime and nothing catches at build time.
  approval: ApprovalLabels;
}

/** One outbound WhatsApp message, decided before anything is sent. */
export type WhatsAppOutbound =
  | { kind: 'text'; body: string }
  | { kind: 'interactive'; body: string; buttons: { id: string; title: string }[] };

// WhatsApp rejects text bodies over 4096 chars; split on paragraph boundaries
// where possible, hard-slice as a last resort.
const MAX_BODY = 4000;
// Meta's limits on an interactive reply-buttons message. Both are enforced by
// clamping rather than by trusting a comment: a translator lengthening a
// button label must degrade to a truncated word, never to a failed delivery.
const MAX_INTERACTIVE_BODY = 1024;
const MAX_BUTTON_TITLE = 20;

export function splitForWhatsApp(text: string): string[] {
  if (text.length <= MAX_BODY) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of text.split('\n\n')) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= MAX_BODY) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = paragraph;
    while (current.length > MAX_BODY) {
      chunks.push(current.slice(0, MAX_BODY));
      current = current.slice(MAX_BODY);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ── proactive-send consent ──────────────────────────────────────────────────

/**
 * May Capo send this person a PROACTIVE message?
 *
 * Meta's business-messaging policy requires a recorded opt-in before a template
 * send, and requires opt-outs to be honoured. On the free test tier Meta's
 * five-number allow-list did this job by accident — a number nobody had
 * confirmed simply could not be reached. The production number has no
 * allow-list, so this predicate is the gate. See 0025_whatsapp_optin.sql.
 *
 * LATEST WINS. A withdrawal never deletes the original consent, it supersedes
 * it (no-DELETE posture, and the pair is the audit trail), so the timestamps
 * have to be COMPARED rather than merely tested for presence. Testing presence
 * would leave anyone who ever opted out permanently unreachable, including after
 * they asked to come back.
 *
 * Fails CLOSED on anything it cannot read — a missing opt-in, an unparseable
 * timestamp, or a row from a deploy that landed before its migration. Silence is
 * a recoverable mistake; messaging someone who never agreed is not.
 *
 * This governs PROACTIVE sends only. Replying inside the 24-hour window that a
 * person's own inbound message opens is a response to them, not an unsolicited
 * send, and is deliberately not gated — otherwise a worker who replies STOP
 * would never receive the confirmation that they had been unsubscribed.
 */
export function hasWhatsAppConsent(row: {
  whatsapp_opt_in_at?: string | null;
  whatsapp_opt_out_at?: string | null;
}): boolean {
  // PARSE the opt-in before trusting it, rather than merely testing that a
  // string is there. An earlier version returned true for any truthy opt_in_at
  // whenever opt_out_at was absent, so an unreadable timestamp read as consent —
  // the one direction this function must never fail in. scripts/whatsapp-check.mts
  // pins it.
  const optIn = row.whatsapp_opt_in_at ? Date.parse(row.whatsapp_opt_in_at) : Number.NaN;
  if (Number.isNaN(optIn)) return false;
  if (!row.whatsapp_opt_out_at) return true;
  // NaN from an unparseable opt-out makes this comparison false too, which is
  // again the fail-closed direction. A tie counts as withdrawal for the same
  // reason. Do not "fix" either by defaulting a side.
  return Date.parse(row.whatsapp_opt_out_at) < optIn;
}

// ── the 24-hour customer-service window ─────────────────────────────────────

/**
 * How long after an inbound message we are still willing to answer with FREE
 * TEXT rather than a paid template.
 *
 * Meta's window is 24 hours from the recipient's last inbound message. This is
 * 23, and the missing hour is a deliberate safety margin, not an approximation.
 * A send decided at the top of a run goes out some seconds or minutes later,
 * after a database claim and possibly after dozens of other recipients in the
 * same invocation; the stored timestamp is itself written by a best-effort
 * webhook stamp that can lag its message. Deciding "inside" at 23:59:50 and
 * posting at 24:00:10 earns a 131047 and the person gets nothing.
 *
 * The margin costs one paid template for anybody whose only inbound message of
 * the day landed between 23 and 24 hours ago. That is the cheap side.
 */
export const FREE_FORM_WINDOW_MS = 23 * 60 * 60 * 1000;

/**
 * Is this person inside their free-form window?
 *
 * FAILS CLOSED TOWARD THE TEMPLATE, which is the whole design of this
 * predicate. It returns true only on POSITIVE PROOF of an inbound message in
 * the last FREE_FORM_WINDOW_MS. Everything else — no column, null, empty
 * string, an unparseable timestamp, a value from a deploy that landed before
 * 0030, or a timestamp in the FUTURE (a clock disagreement between Postgres and
 * the runtime, or a rogue write) — returns false and the caller sends a
 * template.
 *
 * The asymmetry is not caution for its own sake. A template always arrives; it
 * merely costs money. Free-form text sent outside the window is rejected
 * wholesale by Meta with error 131047 and the recipient receives NOTHING, which
 * on the 07:00 briefing means a crew that hears nothing all morning and no
 * symptom anybody can see. Guessing "inside" is the expensive mistake and
 * guessing "outside" is the cheap one, so every ambiguity resolves outward.
 *
 * `now` is injected rather than read from Date.now() so this stays pure and
 * scripts/whatsapp-check.mts can pin the boundary exactly.
 */
export function withinFreeFormWindow(
  lastInboundAt: string | null | undefined,
  now: number,
  windowMs = FREE_FORM_WINDOW_MS,
): boolean {
  if (!lastInboundAt) return false;
  const at = Date.parse(lastInboundAt);
  if (Number.isNaN(at)) return false;
  return elapsedWithin(at, now, windowMs);
}

// The arithmetic half of the predicate above, shared with mayNarrateProgress so
// the two cannot drift. `elapsed >= 0` refuses a future timestamp. NaN in `at`
// or `now` (nothing should pass one, but the arithmetic would propagate it
// silently) fails both comparisons, which is again the closed direction.
function elapsedWithin(at: number, now: number, windowMs: number): boolean {
  const elapsed = now - at;
  return elapsed >= 0 && elapsed <= windowMs;
}

// ── working-on-it feedback ──────────────────────────────────────────────────
//
// Issue #50: a manager on WhatsApp sent a message and then watched nothing
// happen for thirty seconds. The web chat has "Capo está a escrever…" and tool
// chips; WhatsApp had a blank screen, which reads as "it broke" and provokes a
// second message that costs another agent turn.
//
// Meta's answer to this is NOT message editing. Editing a sent message does not
// exist in the Cloud API in any form — there is exactly one messages endpoint
// and it is send-only (see the runbook). What does exist is two *status*
// updates, and both are FREE by construction: Meta bills TEMPLATE messages
// only, and neither of these is a message at all — no `type`, no `template`, no
// recipient field, and no wamid in the response.

/**
 * How long Meta shows a typing indicator before dismissing it on its own.
 *
 * The indicator also disappears the moment we send the real reply, whichever
 * comes first — so on a turn that finishes quickly it behaves exactly like the
 * web chat's "Capo está a escrever…".
 *
 * DO NOT BUILD A KEEP-ALIVE AROUND THIS. A repeating timer on a serverless
 * function is a bug generator: the instance can freeze the moment the response
 * flushes, so the loop either dies mid-cycle or keeps a function billable for
 * no reason. The answer to a turn outlasting 25 seconds is ONE progress note
 * (below), not a heartbeat.
 */
export const TYPING_INDICATOR_MS = 25_000;

/**
 * When a turn that is still running earns one plain-text "still on it".
 *
 * Deliberately just under TYPING_INDICATOR_MS: the note exists to cover the
 * moment the indicator expires, so anything longer would leave a visible gap
 * and anything much shorter would talk over an indicator that is still showing.
 */
export const PROGRESS_NOTE_AFTER_MS = 20_000;

/**
 * May this turn spend a FREE-FORM message on a progress note?
 *
 * The answer is essentially always yes — a progress note is only ever sent
 * while answering someone whose own message arrived seconds ago, and that
 * message is what opened Meta's 24-hour window. So why ask at all?
 *
 * Because "it is obviously inside the window" is exactly the kind of reasoning
 * that stops being true after a refactor nobody connects to this file, and the
 * failure would be expensive in the one direction that matters: a free-form
 * send outside the window is refused with 131047, and the recovery path for
 * that (packages/core, isOutsideWindowError) is a PAID TEMPLATE. A status
 * update that quietly turns into a billable send is strictly worse than no
 * status update, so the window is asserted rather than assumed.
 *
 * `inboundAt` is when WE received the webhook, not a stored column — the proof
 * is the message we are answering, so it needs no database read and cannot be
 * stale. Fails closed for the same reasons withinFreeFormWindow does, and
 * shares its arithmetic so the two can never disagree.
 */
export function mayNarrateProgress(
  inboundAt: number,
  now: number,
  windowMs = FREE_FORM_WINDOW_MS,
): boolean {
  if (!Number.isFinite(inboundAt)) return false;
  return elapsedWithin(inboundAt, now, windowMs);
}

/**
 * Pure: an inbound message id in, the Graph body for "seen" (and optionally
 * "…and typing") out.
 *
 * THE SHAPE IS THE COST GUARANTEE, which is why this is a separate builder that
 * whatsapp-check pins rather than an inline object literal:
 *
 *   - No `type` and no `template`. Meta bills template messages; a body that
 *     cannot name a template cannot be billed as one.
 *   - No `to` and no `recipient`. This is addressed by `message_id`, so it
 *     never goes through buildSendBody and the `to`-silently-wins hazard that
 *     shape exists to prevent has no way to reach it.
 *   - The typing indicator RIDES the read receipt; it is not a second call.
 *     Meta's endpoint takes `status: 'read'` plus an optional
 *     `typing_indicator`, so showing "typing" always also marks the message
 *     read. There is no typing-without-read request to get wrong.
 *
 * `typing` is a required property rather than an optional one: every call site
 * has to decide out loud whether an answer is actually coming, because Meta
 * asks that an indicator only be shown when one is.
 */
export function buildReceiptBody(
  messageId: string,
  options: { typing: boolean },
): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
    ...(options.typing ? { typing_indicator: { type: 'text' } } : {}),
  };
}

/**
 * Mark an inbound message read, and optionally show the typing indicator.
 *
 * Takes a WhatsAppApiConfig, not a WhatsAppSendConfig: there is no recipient in
 * this request and the narrower type is what stops one being added by accident.
 *
 * THROWS on a Graph failure, exactly like every other call here. Swallowing
 * belongs at the call site, which is where the log is — and swallowing it there
 * is mandatory: feedback that breaks the answer is worse than no feedback.
 */
export async function sendReadReceipt(
  messageId: string,
  config: WhatsAppApiConfig,
  options: { typing: boolean },
): Promise<void> {
  // Not post(): that one calls buildSendBody, which would add `to`. Meta's
  // response here is `{ "success": true }` with no wamid — there is no message,
  // so there is no id and nothing to record.
  await postRaw(buildReceiptBody(messageId, options), config);
}

/**
 * Meta's "re-engagement required": a free-form send that landed outside the
 * 24-hour window. The one send failure the briefing can RECOVER from, by
 * retrying the same recipient with a template.
 *
 * Recognised NARROWLY, by code, and never by a blanket catch. Every other
 * failure — 131026 (no WhatsApp), 131021 (messaging ourselves), a 500 from the
 * Graph API, a network reset — means the send is genuinely broken, and retrying
 * it as a template would either fail identically or spend money to no purpose.
 * Only this one code says "the envelope was wrong, the recipient is fine".
 */
export const OUTSIDE_WINDOW_ERROR_CODE = 131047;

export function isOutsideWindowError(err: unknown): boolean {
  return err instanceof WhatsAppSendError && err.code === OUTSIDE_WINDOW_ERROR_CODE;
}

// ── approval button ids ─────────────────────────────────────────────────────
// The proposal id travels in the button id and is the ONLY thing carrying the
// manager's decision back — no model, no message-id bookkeeping. ~52 chars,
// well under Meta's 256-char cap.

const BUTTON_ID =
  /^capo:(approve|reject):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function proposalButtonId(decision: 'approve' | 'reject', proposalId: string): string {
  return `capo:${decision}:${proposalId}`;
}

// The uuid shape is validated HERE rather than at the call site: proposalId
// goes straight into `.eq('id', …)` on a uuid column, where a malformed value
// surfaces as a Postgres 22P02 rather than as a clean "not one of ours".
export function parseProposalButtonId(
  id: string,
): { decision: 'approve' | 'reject'; proposalId: string } | null {
  const match = BUTTON_ID.exec(id);
  if (!match) return null;
  return { decision: match[1].toLowerCase() as 'approve' | 'reject', proposalId: match[2] };
}

// ── check-in quick-reply payloads ───────────────────────────────────────────
// The late-afternoon check-in's two template buttons. Same shape and the same reasoning
// as the approval button ids above, on a tighter budget: a TEMPLATE quick-reply
// payload gets far less room than an interactive reply id's 256 chars, so this
// is capped at 128. `capo:checkin:not_done:<uuid>` is 58.
//
// TWO DIFFERENT BUTTON SHAPES arrive on the webhook and they must not be
// conflated. An approval card is `type: 'interactive'` with
// `interactive.button_reply.id`, from a MANAGER. A check-in is
// `type: 'button'` with `button.payload`, from a WORKER. The two prefixes are
// deliberately non-overlapping so neither parser can ever accept the other's
// value — asserted in scripts/whatsapp-check.mts.
//
// The uuid is the notification_log row of the ASK — not the worker, not the
// date. That is what makes a tap on yesterday's still-tappable card record
// against yesterday, and it gives the webhook a single row to check ownership
// against.

const CHECKIN_PAYLOAD =
  /^capo:checkin:(done|not_done):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export type CheckinAnswer = 'done' | 'not_done';

export function checkinPayload(answer: CheckinAnswer, notificationId: string): string {
  return `capo:checkin:${answer}:${notificationId}`;
}

// Validated here for the same reason parseProposalButtonId validates there:
// notificationId goes straight into `.eq('id', …)` on a uuid column.
export function parseCheckinPayload(
  payload: string,
): { answer: CheckinAnswer; notificationId: string } | null {
  const match = CHECKIN_PAYLOAD.exec(payload);
  if (!match) return null;
  return { answer: match[1].toLowerCase() as CheckinAnswer, notificationId: match[2] };
}

// ── worker menu row ids (issue #49) ─────────────────────────────────────────
// The THIRD tappable shape in this file, and the one most likely to be confused
// with the other two. Read the three together once:
//
//   approval card   `interactive.button_reply.id`  `capo:approve|reject:<uuid>`  MANAGER
//   check-in        `button.payload`               `capo:checkin:done|not_done:` WORKER
//   worker menu     `interactive.list_reply.id`    `capo:wm:…`                   WORKER
//
// All three arrive on the same webhook and two of them arrive under
// `type: 'interactive'`. What keeps them apart is not the handler layout — it
// is that the three prefixes are pairwise non-overlapping, so no parser can
// ever accept another's value. scripts/whatsapp-check.mts asserts that in every
// direction, and a fourth codec must extend those assertions rather than
// assume them.
//
// A list row id gets 200 chars from Meta, far more than the 41 used here. It is
// still validated on the way IN, for the same reason parseProposalButtonId
// validates the uuid it returns: `taskId` goes straight into `.eq('id', …)` on
// a uuid column, where a malformed value is a Postgres 22P02 rather than a
// clean "not one of ours".

const WORKER_MENU_TASK =
  /^capo:wm:task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const WORKER_MENU_MANAGER = 'capo:wm:manager';

/**
 * One row of the crew menu.
 *
 * `manager` carries no id on purpose: "I need a person, not an answer" is not
 * about any particular task, and giving it one would invite a handler that
 * looked the task up and leaked whether it existed.
 */
export type WorkerMenuRow = { kind: 'task'; taskId: string } | { kind: 'manager' };

export function workerMenuRowId(row: WorkerMenuRow): string {
  return row.kind === 'manager' ? WORKER_MENU_MANAGER : `capo:wm:task:${row.taskId}`;
}

export function parseWorkerMenuRowId(id: string): WorkerMenuRow | null {
  if (id.toLowerCase() === WORKER_MENU_MANAGER) return { kind: 'manager' };
  const match = WORKER_MENU_TASK.exec(id);
  return match ? { kind: 'task', taskId: match[1] } : null;
}

// ── the welcome's "Say hi" payload (issue #45 follow-up) ────────────────────
// The FOURTH tappable shape, and the first that arrives under BOTH envelopes:
//
//   approval card   `interactive.button_reply.id`  `capo:approve|reject:<uuid>`  MANAGER
//   check-in        `button.payload`               `capo:checkin:done|not_done:` WORKER
//   worker menu     `interactive.list_reply.id`    `capo:wm:…`                   WORKER
//   say hi          `button.payload` (template)    `capo:hi`                     BOTH
//                   `interactive.button_reply.id` (free-form twin)
//
// The welcome goes out in two envelopes — the approved template capo_welcome_v2
// and, for anybody already inside their 24-hour window, an interactive
// reply-button message — so the SAME tap comes back on two different fields.
// One payload for both is what keeps "the person tapped hello" a single fact
// with a single handler; splitting it per envelope would give the two halves of
// one message two answers that could drift.
//
// It carries NO id, for workerMenuRowId('manager')'s reason: "hello" is not
// about any particular row, and giving it one would invite a handler that
// looked the row up and leaked whether it existed. Who tapped is already known
// from sender resolution, which is the only identity on this path that is not
// attacker-supplied.
//
// Disjoint from the other three by construction: it is an exact whole-string
// match with no third segment, so no parser here can accept another's value.
// scripts/whatsapp-check.mts asserts every direction.
const HI_PAYLOAD = 'capo:hi';

export function hiPayload(): string {
  return HI_PAYLOAD;
}

export function isHiPayload(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase() === HI_PAYLOAD;
}

/**
 * Did this inbound message carry the welcome's one button, in EITHER envelope?
 *
 * This two-line mapping is the load-bearing half of the feature, and it lives
 * here rather than in the webhook for the reason parseProposalButtonId and
 * isBsuid do: it is the only place `scripts/whatsapp-check.mts` can pin it with
 * no credentials and no network. The claim the whole button rests on is that
 * the same tap comes back on `button.payload` from the approved template and on
 * `interactive.button_reply.id` from the free-form twin — and the failure of
 * the second half is silent, because the template path would go on working.
 *
 * Structurally typed, deliberately: the webhook's own message type lives in the
 * route and importing it here would invert the dependency for nothing. Both
 * fields are optional on the wire and both can be absent.
 */
export function isHiTap(message: {
  type?: string;
  button?: { payload?: string };
  interactive?: { button_reply?: { id?: string } };
}): boolean {
  if (message.type === 'button') return isHiPayload(message.button?.payload);
  if (message.type === 'interactive') return isHiPayload(message.interactive?.button_reply?.id);
  return false;
}

// ── business-scoped user ids ────────────────────────────────────────────────
// Meta's answer to WhatsApp usernames. When a person adopts a username, the
// inbound message's `from` (their phone) is OMITTED entirely and `from_user_id`
// — a BSUID like PT.13491208655302741918 — is all we get. It is stable across
// username changes and scoped to our business portfolio.
//
// ISO-3166 alpha-2, a period, up to 128 alphanumerics. ONE dot, which is what
// rejects a PARENT BSUID (US.ENT.11815799212886844830): Meta issues those to
// multi-portfolio businesses, and we are a single portfolio. Storing one would
// look like an identity while pointing at no one in particular.
//
// This regex is duplicated as a CHECK constraint in
// supabase/migrations/0022_whatsapp_bsuid.sql, deliberately — one rule, two
// enforcement points. It lives here rather than in the webhook route so
// scripts/whatsapp-check.mts can assert it with no credentials and no network,
// the same reason parseProposalButtonId lives here.
const BSUID = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/;

export function isBsuid(value: string): boolean {
  return BSUID.test(value);
}

/**
 * Log-safe sender label. Never throws; never emits a full identifier.
 *
 * Both fields are optional and BOTH can be absent — `from` since Meta started
 * omitting it for username adopters, `from_user_id` on anything Meta sends that
 * is not a person's message. Every call site is a log line inside an `after()`
 * callback, where a TypeError is an unhandled rejection that bypasses the very
 * logEvent it was reaching for, so this must not be able to throw.
 *
 * `…1234` for a phone, `id:…1234` for the BSUID-only case, `'unknown'` for
 * neither. The `id:` prefix is what tells triage WHICH identifier got
 * truncated — without it the two shapes are indistinguishable in a log drain.
 *
 * Four trailing characters identify no one on their own. (A pathologically
 * short id — 4 chars or fewer — would be emitted whole, but nothing that short
 * is a real BSUID.)
 */
export function senderLabel(message: { from?: string; from_user_id?: string }): string {
  if (message.from) return `…${message.from.slice(-4)}`;
  if (message.from_user_id) return `id:…${message.from_user_id.slice(-4)}`;
  return 'unknown';
}

/**
 * Everything the webhook knows about who sent a message, decided once.
 *
 * Both identifiers are optional on the wire and BOTH can be absent, so this is
 * also the narrowing step: a message with neither is unresolvable AND
 * unanswerable.
 */
export interface WhatsAppSender {
  /** wa_id — digits, no '+'. Absent once the sender has adopted a username. */
  from?: string;
  /** A VALIDATED BSUID. Undefined when absent, malformed, or a parent BSUID. */
  bsuid?: string;
  /** Where a reply goes, and which envelope field carries it. */
  replyTo: WhatsAppRecipient;
}

/**
 * PHONE WINS. This one-line preference is the safety property of the whole
 * BSUID change: it is what makes today's payloads take today's path, byte for
 * byte, so nothing about reading a second identifier can regress the traffic
 * that already works. It lives here rather than in the route precisely so
 * scripts/whatsapp-check.mts can pin it with no credentials and no network —
 * the same reason parseProposalButtonId and isBsuid do.
 *
 * BSUID validation happens HERE, once, rather than at each lookup. A
 * `from_user_id` that fails isBsuid is treated as absent: it cannot match a
 * stored value anyway (the same regex is a CHECK constraint on both columns),
 * and refusing it at the boundary is what stops a PARENT BSUID ever being used
 * as a key.
 *
 * `replyTo` is built from `from` directly rather than through any E.164
 * conversion: `from` is already a wa_id. Replying is the one direction that
 * needs no conversion.
 *
 * Returns null when neither identifier is usable — the caller's silent no-op,
 * reached without a throw.
 */
export function readSender(message: { from?: string; from_user_id?: string }): WhatsAppSender | null {
  const bsuid =
    message.from_user_id && isBsuid(message.from_user_id) ? message.from_user_id : undefined;
  if (message.from) {
    return { from: message.from, bsuid, replyTo: { kind: 'phone', waId: message.from } };
  }
  if (bsuid) return { bsuid, replyTo: { kind: 'bsuid', userId: bsuid } };
  return null;
}

// ── the webhook change router ───────────────────────────────────────────────
// One person's BSUID is NOT permanent. Changing their phone number regenerates
// it, and Meta announces that on a webhook change whose `field` is
// 'user_id_update' — a change that carries NO `messages` array at all.
//
// The webhook route used to flat-map `change.value?.messages` and ignore
// `change.field` entirely, so a rotation was dropped without a trace: no error,
// no log, just a stored id that had quietly stopped pointing at anybody. That
// is the degradation this router exists to prevent, and the reason it lives in
// @capo/core rather than in the route — here scripts/whatsapp-check.mts can
// assert it with no credentials and no network, the same reason
// parseProposalButtonId and isBsuid live here.
//
// Generic in M so the WhatsAppMessage interface (and the substantial
// documentation attached to it) stays in the route that consumes it. This
// function's job is SORTING, not validating: `previous`/`current` are checked
// against isBsuid by the applier, so an invalid value produces a distinct log
// line instead of vanishing inside a sorter.

/** One announced BSUID rotation: this person's id changed from → to. */
export interface BsuidRotation {
  previous: string;
  current: string;
  /**
   * The phone Meta happens to include. Recorded for logs only and NEVER used as
   * a lookup key — the whole point of a rotation is that the phone changed, so
   * it is the one identifier guaranteed to be stale here.
   */
  waId?: string;
}

// ── delivery statuses ───────────────────────────────────────────────────────
// THE THIRD SHAPE ON THIS WEBHOOK, and it is deliberately none of the other
// two. A template quick reply is a MESSAGE with `type: 'button'` from a worker;
// an approval-card tap is a MESSAGE with `type: 'interactive'` from a manager;
// a delivery status is not a message at all. It arrives under
// `value.statuses` on a change whose `field` is still 'messages', which is
// exactly why the pre-#51 router — which read `value.messages` and nothing
// else — flat-mapped an absent array, found nothing, and dropped every one
// without a trace.
//
// The consequence was that `notification_log.status = 'sent'` could only ever
// mean "Meta accepted it", never "it arrived". On 13 August that ambiguity is
// what made a 49-minute-late briefing indistinguishable from a lost one.
//
// Meta sends several of these per message and they are NOT ordered: a `read`
// can arrive before its `delivered`. The applier therefore stamps one column
// per status and never derives one from another.

/** Meta's delivery lifecycle for one outbound message. */
export type WhatsAppDeliveryState = 'sent' | 'delivered' | 'read' | 'failed';

export interface WhatsAppStatus {
  /** The `wamid` we stored as notification_log.provider_message_id. */
  id: string;
  state: WhatsAppDeliveryState;
  /** Unix seconds, as Meta sends it. Null when unreadable. */
  timestamp: number | null;
  /** Present on `failed` only. */
  errorCode: number | null;
  errorTitle: string | null;
}

const DELIVERY_STATES = new Set<string>(['sent', 'delivered', 'read', 'failed']);

function readStatus(value: unknown): WhatsAppStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as { id?: unknown; status?: unknown; timestamp?: unknown; errors?: unknown };
  if (typeof entry.id !== 'string' || !entry.id) return null;
  if (typeof entry.status !== 'string' || !DELIVERY_STATES.has(entry.status)) return null;

  // Meta sends the timestamp as a STRING of unix seconds. Anything that does
  // not parse becomes null and the applier falls back to its own clock —
  // a delivery whose exact second is unknown is still a delivery.
  const raw = typeof entry.timestamp === 'string' ? Number(entry.timestamp) : entry.timestamp;
  const timestamp = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;

  // `errors` is an array; only the first is worth recording. A code with no
  // title is normal, a title with no code is not — both degrade to null rather
  // than to a guess.
  let errorCode: number | null = null;
  let errorTitle: string | null = null;
  if (Array.isArray(entry.errors) && entry.errors.length > 0) {
    const first = entry.errors[0] as { code?: unknown; title?: unknown; message?: unknown };
    if (typeof first?.code === 'number') errorCode = first.code;
    const text = typeof first?.title === 'string' ? first.title : first?.message;
    if (typeof text === 'string' && text) errorTitle = text;
  }

  return { id: entry.id, state: entry.status as WhatsAppDeliveryState, timestamp, errorCode, errorTitle };
}

export interface WhatsAppWebhookEnvelope<M> {
  entry?: {
    changes?: {
      field?: string;
      value?: {
        messages?: M[];
        statuses?: unknown[];
        user_id_update?: unknown[];
      };
    }[];
  }[];
}

export interface RoutedWebhook<M> {
  messages: M[];
  rotations: BsuidRotation[];
  /**
   * Delivery receipts for messages WE sent. Never a person writing to us, and
   * therefore never fed to a model, never routed to an agent, and never used to
   * resolve a sender — see readSender, which this deliberately does not touch.
   */
  statuses: WhatsAppStatus[];
  /**
   * Field names this router does not handle, in arrival order. A change with no
   * `field` at all and no messages is reported as '(missing)'. Duplicates are
   * kept: the caller logs one event per occurrence, and collapsing them would
   * hide a batch that is mostly one unknown thing.
   */
  unhandledFields: string[];
  /**
   * user_id_update entries whose shape we could not read. Counted rather than
   * dropped, because this payload is documented only in Meta's changelog — no
   * public source quotes it verbatim — so a shape surprise has to be findable.
   */
  unreadableRotations: number;
  /**
   * `statuses` entries whose shape we could not read. Same reasoning as
   * unreadableRotations: a status we silently drop is a delivery the product
   * then claims never happened.
   */
  unreadableStatuses: number;
}

// parent_user_id is deliberately never read, here or anywhere. Meta issues a
// parent BSUID (US.ENT.11815799212886844830) to businesses running several
// portfolios who want one shared id across them; Capo is a single portfolio.
// Storing one would look like an identity while pointing at nobody in
// particular, which is also why isBsuid's single-dot rule rejects the shape
// outright. Parse-and-drop, on purpose — do not add support speculatively.
function readRotation(value: unknown): BsuidRotation | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as { wa_id?: unknown; user_id?: unknown };
  if (typeof entry.user_id !== 'object' || entry.user_id === null) return null;
  const { previous, current } = entry.user_id as { previous?: unknown; current?: unknown };
  if (typeof previous !== 'string' || !previous) return null;
  if (typeof current !== 'string' || !current) return null;
  return {
    previous,
    current,
    waId: typeof entry.wa_id === 'string' ? entry.wa_id : undefined,
  };
}

export function routeWebhookChanges<M>(body: WhatsAppWebhookEnvelope<M>): RoutedWebhook<M> {
  const messages: M[] = [];
  const rotations: BsuidRotation[] = [];
  const statuses: WhatsAppStatus[] = [];
  const unhandledFields: string[] = [];
  let unreadableRotations = 0;
  let unreadableStatuses = 0;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      // The field-absent branch is a COMPATIBILITY guard, not tidiness. Meta
      // always sets `field`, but the route this replaces never read it, so any
      // payload that works today must keep working — including one from a test
      // harness that omits it. Dispatching on a missing field alone would drop
      // real messages, which is the one regression this change must not have.
      //
      // ⚠ A delivery status arrives on this SAME field, with `statuses` and no
      // `messages`. So both arrays are drained here, and the field-absent
      // compatibility branch tests both — a payload carrying only statuses and
      // no `field` would otherwise fall through to unhandledFields and be
      // reported as a surprise rather than recorded.
      if (
        change.field === 'messages' ||
        (change.field === undefined && (change.value?.messages || change.value?.statuses))
      ) {
        messages.push(...(change.value?.messages ?? []));
        for (const raw of change.value?.statuses ?? []) {
          const status = readStatus(raw);
          if (status) statuses.push(status);
          else unreadableStatuses += 1;
        }
        continue;
      }

      if (change.field === 'user_id_update') {
        for (const raw of change.value?.user_id_update ?? []) {
          const rotation = readRotation(raw);
          if (rotation) rotations.push(rotation);
          else unreadableRotations += 1;
        }
        continue;
      }

      unhandledFields.push(change.field ?? '(missing)');
    }
  }

  return { messages, rotations, statuses, unhandledFields, unreadableRotations, unreadableStatuses };
}

// ── Meta's numeric failure codes, for a screen that has to explain one ───────
//
// `notification_log.error` is `describeSendError(err)`, i.e. a
// WhatsAppSendError message of the shape
//   "WhatsApp send failed (400, code 132001): <detail>"
// so the code is already in the row — just buried in prose that means nothing
// to a manager. Extracted HERE rather than in the screen so scripts/
// whatsapp-check.mts can pin it offline, and so the two places that need a code
// (a send-time failure and a delivery-time failure) read it the same way.
//
// Returns null rather than guessing. An unrecognised message renders as its
// raw text, which is worse to read but never wrong.
export function readMetaErrorCode(message: string | null | undefined): number | null {
  if (!message) return null;
  const match = /\bcode (\d{3,7})\b/.exec(message);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) ? code : null;
}

// ── outbound planning ───────────────────────────────────────────────────────

/**
 * Told what the voice pass had to fix, if anything. Optional, and that is the
 * point: left out, planAssistantMessages and planWorkerMessages stay PURE,
 * which is what lets scripts/whatsapp-check.mts assert all of this with no
 * credentials and no network. The live sinks pass a logger. Same shape as the
 * agent loop's onStepEnd, and for the same reason.
 */
export type VoiceReporter = (repairs: VoiceRepair[]) => void;

// One counted line per message that needed correcting.
//
// This is the entire answer to the strongest objection against repairing
// instead of refusing: that a silent fix hides a prompt which has started
// drifting. The fix is silent to the READER, never to the log. If a prompt edit
// makes the model start emitting em dashes on a third of turns, that is a
// `voice.repaired` count rising rather than nothing at all.
//
// Rules only, deliberately: rule → detail is a static one-to-one map in
// ./voice.ts, so logging both would put a paragraph in every line. `detail`
// exists for a retry prompt, if one is ever added, and for an operator view.
//
// Same swallow-and-log posture as loadCompanySnapshot: a logging failure must
// never cost somebody their reply. Grep this event before concluding the model
// needs no correcting.
function logVoiceRepairs(repairs: VoiceRepair[]): void {
  if (repairs.length === 0) return;
  try {
    console.log(
      JSON.stringify({ evt: 'voice.repaired', ts: new Date().toISOString(), rules: repairs.map(r => r.rule) }),
    );
  } catch {
    // ignore
  }
}

// Recognises the shape returned identically by propose.ts, guard.ts and
// plan.ts. Mirrors the web client's check in apps/web/app/chat.tsx on purpose:
// the two channels must agree on what a card is. Reads `unknown` and narrows
// because `any` is an ESLint error under this config.
function asProposalOutput(value: unknown): { proposalId: string; renderedText: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const out = value as { status?: unknown; proposalId?: unknown; renderedText?: unknown };
  if (out.status !== 'proposed') return null;
  if (typeof out.proposalId !== 'string' || !out.proposalId) return null;
  if (typeof out.renderedText !== 'string' || !out.renderedText) return null;
  return { proposalId: out.proposalId, renderedText: out.renderedText };
}

// Pure: parts in, messages out. Everything hard about this channel — ordering,
// the 1024 boundary, splitting, markdown, button ids — lives here rather than
// in the send loop, so scripts/whatsapp-check.mts can assert all of it without
// credentials or a network.
//
// ── A CARD TRAVELS ALONE (issue: duplicate approval messages) ───────────────
// A turn that raises one or more approval cards sends ONLY those cards: every
// text part the model produced in that turn is dropped here. The card is a
// self-contained block — the deterministic sentence plus the two buttons — and
// the follow-up paragraph the model used to write after it ("Got a card up for
// that, boss… tap approve and you're set") said the same thing a second time,
// in worse words, in a second notification.
//
// This is the STRUCTURAL half of that rule. The prompt half lives in
// agent/prompts/orchestration.ts, which now tells the model to say nothing when
// a card is raised — but a prompt is a request, not a guarantee, and the model
// will sometimes talk anyway. This function is what makes the guarantee.
//
// The cost is real and deliberate: if the model ever raises a card AND asks a
// question in the same turn, the question is dropped and the manager sees only
// the card. That combination is already ruled out by the prompt (ambiguity
// about the SUBJECT is answered with a question INSTEAD of a card), and the
// predictable rule was chosen over one that depends on where in the turn the
// model happened to speak. If a future change makes that combination legitimate,
// this is the function to revisit — not the prompt.
export function planAssistantMessages(
  parts: UIMessage['parts'],
  labels: ApprovalLabels,
  onRepair?: VoiceReporter,
): WhatsAppOutbound[] {
  const out: WhatsAppOutbound[] = [];
  let prose: string[] = [];

  // First pass. Whether the turn carries a card decides what happens to every
  // text part, including the ones that came BEFORE the card — so it cannot be
  // discovered while walking the parts in order.
  const hasCard = parts.some(
    part => isToolUIPart(part) && part.state === 'output-available' && asProposalOutput(part.output) !== null,
  );

  // Convert THEN voice THEN split.
  //
  // Splitting first could cut a `**` pair across a chunk boundary, leaving a
  // stray asterisk the converter can no longer pair up. The voice pass sits
  // between the two: after the converter, because that has already normalised
  // every markdown dialect the model might emit down to one canonical form
  // (bullets are already `- `, bold is already a single `*`), so flattening it
  // is a handful of regexes rather than a second copy of the converter.
  //
  // ⚠ This is the PROSE branch, and the card branch below never reaches it.
  // That is what keeps `renderedText` byte-identical to the persisted approval
  // artifact: not a rule somebody has to remember, but a fact about which road
  // the two kinds of text travel down.
  const flush = () => {
    const joined = prose.join('\n\n').trim();
    prose = [];
    if (!joined) return;
    const voiced = applyWhatsAppVoice(toWhatsAppMarkdown(joined));
    onRepair?.(voiced.repairs);
    for (const chunk of splitForWhatsApp(voiced.text)) {
      out.push({ kind: 'text', body: chunk });
    }
  };

  for (const part of parts) {
    if (part.type === 'text') {
      // Dropped outright on a card turn — including prose the model wrote
      // BEFORE the card, which is why hasCard had to be known up front.
      if (part.text && !hasCard) prose.push(part.text);
      continue;
    }
    if (!isToolUIPart(part) || part.state !== 'output-available') continue;
    const proposal = asProposalOutput(part.output);
    if (!proposal) continue;

    // Other tool outputs are ignored entirely: WhatsApp has no room for
    // "✓ Tarefas consultadas" chips and the web thread already shows them.
    const buttons = [
      {
        id: proposalButtonId('approve', proposal.proposalId),
        title: labels.approve.slice(0, MAX_BUTTON_TITLE),
      },
      {
        id: proposalButtonId('reject', proposal.proposalId),
        title: labels.reject.slice(0, MAX_BUTTON_TITLE),
      },
    ];

    // renderedText is NEVER markdown-converted and never reworded. It is the
    // persisted approval artifact: resolveProposal embeds this exact string in
    // the role='event' thread message, the web card renders it, and the
    // operator app reads the same column. What the manager approved and the
    // audit record of it have to be byte-identical.
    if (proposal.renderedText.length <= MAX_INTERACTIVE_BODY) {
      out.push({ kind: 'interactive', body: proposal.renderedText, buttons });
    } else {
      // Every real plan card lands here. The card goes as text, then a short
      // interactive carries the buttons.
      for (const chunk of splitForWhatsApp(proposal.renderedText)) {
        out.push({ kind: 'text', body: chunk });
      }
      out.push({ kind: 'interactive', body: labels.prompt.slice(0, MAX_INTERACTIVE_BODY), buttons });
    }
  }

  // No-op on a card turn (nothing was ever buffered). On every other turn this
  // is the ordinary prose send — including the auto-do path, where the model's
  // one-line "done, boss" is the ONLY thing the manager receives, because an
  // executed write returns `status: 'executed'` and asProposalOutput rejects it.
  flush();
  return out;
}

// ── sending ─────────────────────────────────────────────────────────────────

// Meta answers a failed send with a structured error body. Keeping the numeric
// code is what makes a failed reminder diagnosable from notification_log.error
// instead of "it didn't arrive". The ones actually worth recognising:
//
//   131030  recipient not in the allow-list — the test-tier error you WILL hit
//           until every pilot number is added in WhatsApp Manager
//   132000  parameter count mismatch, or a parameter containing a newline/tab/
//           run of 4+ spaces (see toTemplateParam)
//   132001  template name/language does not exist or is not approved yet
//   131047  re-engagement required — a free-form send outside the 24h window
//   131026  message undeliverable (recipient has no WhatsApp, or blocked us)
//   131062  BSUID recipients are not supported for THIS message. Narrower than
//           it sounds and worth knowing before it scares anyone off the BSUID
//           send path: it is raised only for one-tap / zero-tap / copy-code
//           AUTHENTICATION templates. Both of Capo's templates
//           (capo_daily_briefing, capo_task_checkin) are UTILITY, so a BSUID
//           recipient is eligible for everything this codebase sends.
export class WhatsAppSendError extends Error {
  readonly status: number;
  readonly code: number | null;
  readonly subcode: number | null;

  constructor(status: number, body: string) {
    let code: number | null = null;
    let subcode: number | null = null;
    let detail = body;
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
      };
      if (parsed.error) {
        code = parsed.error.code ?? null;
        subcode = parsed.error.error_subcode ?? null;
        detail = parsed.error.error_data?.details ?? parsed.error.message ?? body;
      }
    } catch {
      // Not JSON (a gateway HTML error page, say) — keep the raw body.
    }
    super(`WhatsApp send failed (${status}${code === null ? '' : `, code ${code}`}): ${detail}`);
    this.name = 'WhatsAppSendError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
  }
}

// Template body parameters may not contain newlines, tabs, or runs of 4+
// spaces — Meta rejects the whole send with code 132000. This is the single
// easiest way to break the reminder path, because the natural way to render a
// task list is one per line. Every parameter goes through here, no exceptions.
//
// 1024 is Meta's per-parameter ceiling; we cut at 900 to leave room for the
// template's own surrounding text against the 4096-char body limit.
const MAX_PARAM = 900;

export function toTemplateParam(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_PARAM ? flat : `${flat.slice(0, MAX_PARAM - 1).trimEnd()}…`;
}

// Meta's cap on a template quick-reply payload.
//
// This THROWS rather than clamping, which is the opposite of what
// MAX_BUTTON_TITLE does above — deliberately. A truncated button TITLE is an
// ugly label the recipient can still act on; a truncated PAYLOAD comes back
// unparseable and the tap disappears with nothing but a log line to show for
// it. Fail the send instead, where the caller records it in notification_log.
const MAX_QUICK_REPLY_PAYLOAD = 128;

function assertQuickReplyPayload(payload: string): string {
  if (!payload || payload.length > MAX_QUICK_REPLY_PAYLOAD) {
    throw new Error(
      `quick-reply payload must be 1..${MAX_QUICK_REPLY_PAYLOAD} chars, got ${payload.length}`,
    );
  }
  return payload;
}

export interface TemplateQuickReply {
  /** Echoed back verbatim on `messages[].button.payload`. Max 128 chars. */
  payload: string;
}

export interface WhatsAppTemplate {
  name: string;
  /** Meta's locale format — 'pt_PT', 'es_ES', 'en_US'. Underscore, not hyphen. */
  languageCode: string;
  /** Positional {{1}}, {{2}}… body parameters, in order. */
  bodyParams: string[];
  /**
   * Quick-reply buttons the APPROVED template declares, in template order.
   *
   * Omit for a button-less template — the payload is then byte-identical to
   * what this function has always sent, which is why capo_daily_briefing needs
   * no change.
   *
   * The array INDEX is the contract: Meta addresses buttons positionally, so
   * reordering them in WhatsApp Manager without reordering these inverts every
   * answer, silently, with a 200 from the Graph API.
   *
   * Two ways this fails that do not look like failures:
   *   - a button component for an index the approved template does NOT declare
   *     → 132000 on every send;
   *   - NO button component for a template that DOES declare quick replies
   *     → Meta accepts the send and echoes the button's own LABEL as the
   *       payload, so the tap comes back as "Sim, terminei" and parses as null.
   */
  quickReplies?: TemplateQuickReply[];
}

// Pure: template in, Graph payload out. Split out of sendWhatsAppTemplate so
// scripts/whatsapp-check.mts can assert the component shape — the string
// indices, the sub_type, the backward-compatible single-component case —
// without credentials or a network, the same way planAssistantMessages is.
export function buildTemplatePayload(template: WhatsAppTemplate): Record<string, unknown> {
  const components: Record<string, unknown>[] = [
    {
      type: 'body',
      parameters: template.bodyParams.map(text => ({ type: 'text', text: toTemplateParam(text) })),
    },
  ];

  (template.quickReplies ?? []).forEach((button, index) => {
    components.push({
      type: 'button',
      sub_type: 'quick_reply',
      // A STRING, per Meta's schema. A number is accepted by some versions and
      // rejected by others; pinning it removes the question.
      index: String(index),
      parameters: [{ type: 'payload', payload: assertQuickReplyPayload(button.payload) }],
    });
  });

  return {
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.languageCode },
      components,
    },
  };
}

// Proactive send: the only path that can reach someone who has not messaged us
// first. The template and its language must already be approved in WhatsApp
// Manager — see docs/whatsapp-cloud-api-runbook.md.
export async function sendWhatsAppTemplate(
  template: WhatsAppTemplate,
  config: WhatsAppSendConfig,
): Promise<{ providerMessageId: string | null }> {
  return await post(buildTemplatePayload(template), config);
}

// Pure: recipient + message payload in, Graph request body out. Split out of
// post() for the same reason buildTemplatePayload is split out of
// sendWhatsAppTemplate — scripts/whatsapp-check.mts can then assert the ONE
// thing about this body that cannot be checked any other way without a live
// Meta account: that exactly one addressing field is present.
//
// `to` XOR `recipient`, never both and never neither. Meta accepts both and
// lets `to` win; that silent precedence is the failure this shape exists to
// prevent, because a BSUID send that quietly went to a stale phone number would
// look like a success in every log we keep.
export function buildSendBody(
  payload: Record<string, unknown>,
  recipient: WhatsAppRecipient,
): Record<string, unknown> {
  const address =
    recipient.kind === 'phone' ? { to: recipient.waId } : { recipient: recipient.userId };
  return { messaging_product: 'whatsapp', ...address, ...payload };
}

// The transport, and nothing else: an already-complete Graph body goes on the
// wire. Split out of post() so a READ RECEIPT can reach the same endpoint
// without passing through buildSendBody — a receipt is addressed by
// `message_id` and must carry no `to`/`recipient` at all, so the addressing
// step is not merely unnecessary there, it would be wrong.
//
// Returns the provider message id so the reminder cron can record it in
// notification_log; the sink's own sends ignore it, and a status update has
// none (Meta answers `{ "success": true }`).
async function postRaw(
  body: Record<string, unknown>,
  config: WhatsAppApiConfig,
): Promise<{ providerMessageId: string | null }> {
  const base = config.graphApiBase ?? 'https://graph.facebook.com/v23.0';
  const res = await fetch(`${base}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new WhatsAppSendError(res.status, await res.text());
  }
  // A 200 with an unreadable body is not a failure — the message went out.
  // Losing the id only costs us a column in notification_log.
  try {
    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    return { providerMessageId: json.messages?.[0]?.id ?? null };
  } catch {
    return { providerMessageId: null };
  }
}

async function post(
  payload: Record<string, unknown>,
  config: WhatsAppSendConfig,
): Promise<{ providerMessageId: string | null }> {
  return await postRaw(buildSendBody(payload, config.recipient), config);
}

async function sendText(
  body: string,
  config: WhatsAppSendConfig,
): Promise<{ providerMessageId: string | null }> {
  return await post({ type: 'text', text: { body } }, config);
}

// No header (plain-text only on Meta's side, and it would just duplicate the
// card's first line) and no footer.
//
// Returns the provider message id for sendWhatsAppList's reason, which became a
// real one when the welcome's free-form envelope moved onto this shape: Meta's
// delivery and read callbacks are matched against notification_log by
// `provider_message_id`, so a proactive send that threw the id away could never
// be stamped delivered, read or failed. The sink's own sends still ignore it.
async function sendInteractive(
  message: Extract<WhatsAppOutbound, { kind: 'interactive' }>,
  config: WhatsAppSendConfig,
): Promise<{ providerMessageId: string | null }> {
  return await post(
    {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: message.body },
        action: { buttons: message.buttons.map(button => ({ type: 'reply', reply: button })) },
      },
    },
    config,
  );
}

// ── the interactive LIST (issue #49) ────────────────────────────────────────
//
// A different interactive subtype from the reply-buttons card above, and it
// exists for a different job: a card offers up to THREE buttons and is a
// decision, a list offers up to TEN rows behind a native "menu" affordance and
// is a choice. The crew menu — "which task do you want the details of?" — does
// not fit in three buttons and must not become a sentence asking them to type a
// number.
//
// ── FREE, AND ONLY INSIDE THE WINDOW ────────────────────────────────────────
// An interactive message is a session message, exactly like plain text: Meta
// bills templates and nothing else, so this can never turn a guided prompt into
// a paid send. The flip side is the same as text: outside the 24 hours the
// recipient's own inbound message opened, it is REFUSED (131047) rather than
// charged. Every caller must therefore have established the window first, and
// must have a template or a silence to fall back to.
//
// ── THE LIMITS ARE ENFORCED HERE, AND THEY SPLIT IN TWO ─────────────────────
// Cosmetic overruns CLAMP (a long task title becomes a shorter one; a worker
// can still tap it). Structural overruns THROW (a body that does not fit, no
// rows, eleven rows, an id Meta would truncate) — the same split
// toTemplateParam and assertQuickReplyPayload already make, and for the same
// reason: a truncated LABEL is ugly, a truncated ID comes back unparseable and
// the tap disappears with nothing but a log line.
//
// MAX_LIST_BODY is deliberately the CONSERVATIVE figure. Meta's own reference
// page currently reads 4096 for a list body while every third-party summary and
// every older revision of the same page says 1024. The cost of being wrong
// downward is a briefing that degrades to plain text; the cost of being wrong
// upward is a 400 at 07:00 and a crew that hears nothing. `listFits` exists so
// callers make that decision BEFORE sending rather than catching a throw.
const MAX_LIST_BODY = 1024;
const MAX_LIST_ROWS = 10;
const MAX_LIST_BUTTON = 20;
const MAX_LIST_SECTION_TITLE = 24;
const MAX_LIST_ROW_TITLE = 24;
const MAX_LIST_ROW_DESCRIPTION = 72;
const MAX_LIST_ROW_ID = 200;

export interface WhatsAppListRow {
  /** Echoed back verbatim on `interactive.list_reply.id`. Build with workerMenuRowId. */
  id: string;
  title: string;
  description?: string;
}

export interface WhatsAppList {
  body: string;
  /** The label on the native button that OPENS the list. Max 20 chars. */
  button: string;
  /** Section heading above the rows. Max 24 chars. */
  section: string;
  rows: WhatsAppListRow[];
}

/**
 * Does this body fit in a list message?
 *
 * Exported so a caller can choose the envelope up front. The 07:00 briefing
 * uses it exactly that way: a rich day that overruns is sent as ordinary text
 * with no menu rather than trimmed down to fit one.
 */
export function listFits(body: string): boolean {
  return body.length > 0 && body.length <= MAX_LIST_BODY;
}

function clampTo(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Pure: list in, Graph payload out. Split out for the same reason
 * buildTemplatePayload is — scripts/whatsapp-check.mts asserts the shape and
 * every limit with no credentials and no network.
 *
 * No header and no footer. A header would duplicate the body's first line, and
 * a footer is exactly the place a standing "reply PT/ES/EN" sentence would grow
 * back (issue #49's second complaint).
 */
export function buildListPayload(list: WhatsAppList): Record<string, unknown> {
  if (!listFits(list.body)) {
    throw new Error(`interactive list body must be 1..${MAX_LIST_BODY} chars, got ${list.body.length}`);
  }
  if (list.rows.length === 0 || list.rows.length > MAX_LIST_ROWS) {
    throw new Error(`interactive list needs 1..${MAX_LIST_ROWS} rows, got ${list.rows.length}`);
  }
  for (const row of list.rows) {
    if (!row.id || row.id.length > MAX_LIST_ROW_ID) {
      throw new Error(`list row id must be 1..${MAX_LIST_ROW_ID} chars, got ${row.id.length}`);
    }
    // Checked POST-clamp, because clampTo flattens whitespace: a title of three
    // spaces is truthy at the call site and empty by the time it reaches Meta,
    // which answers 400. That is a structural overrun even though it looks
    // cosmetic — there is no shorter valid title to degrade to.
    if (!clampTo(row.title, MAX_LIST_ROW_TITLE)) {
      throw new Error('list row title must not be empty');
    }
  }

  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: list.body },
      action: {
        button: clampTo(list.button, MAX_LIST_BUTTON),
        sections: [
          {
            title: clampTo(list.section, MAX_LIST_SECTION_TITLE),
            rows: list.rows.map(row => ({
              id: row.id,
              title: clampTo(row.title, MAX_LIST_ROW_TITLE),
              ...(row.description
                ? { description: clampTo(row.description, MAX_LIST_ROW_DESCRIPTION) }
                : {}),
            })),
          },
        ],
      },
    },
  };
}

/**
 * An interactive REPLY-BUTTONS message, sent directly rather than through the
 * sink (issue #45 follow-up).
 *
 * The sink already builds this shape for an approval card, but only as the tail
 * of an assistant STREAM. The welcome's free-form twin has no stream: it is a
 * sentence we already hold plus one button, decided before anything ran, which
 * is the same reason sendWhatsAppText is public.
 *
 * Session message, so it is FREE and, for the same reason, REFUSED outright
 * (131047) outside the 24 hours the recipient's own message opened. Every
 * caller must have established the window first and must have a template or a
 * silence to fall back to.
 *
 * Clamps rather than throws, matching what planAssistantMessages already does
 * with the same two constants: a translator lengthening a button label must
 * degrade to a truncated word, never to a failed delivery.
 *
 * Returns the provider message id, exactly as sendWhatsAppText and
 * sendWhatsAppTemplate do and for the same reason: a PROACTIVE send records it
 * in notification_log, and Meta's delivery/read callbacks are matched back to
 * that row by `provider_message_id` alone. A send that dropped the id would look
 * successful and then be permanently un-stampable.
 */
export async function sendWhatsAppButtons(
  message: { body: string; buttons: { id: string; title: string }[] },
  config: WhatsAppSendConfig,
): Promise<{ providerMessageId: string | null }> {
  return await sendInteractive(
    {
      kind: 'interactive',
      body: message.body.slice(0, MAX_INTERACTIVE_BODY),
      buttons: message.buttons.map(button => ({
        id: button.id,
        title: button.title.slice(0, MAX_BUTTON_TITLE),
      })),
    },
    config,
  );
}

/** Session message, never billable — and refused outright outside the window. */
export async function sendWhatsAppList(
  list: WhatsAppList,
  config: WhatsAppSendConfig,
): Promise<{ providerMessageId: string | null }> {
  return await post(buildListPayload(list), config);
}

// Public: the webhook needs a direct send for the voice-note failure path and
// for the confirmation after a button press. It does not reuse the sink there:
// the sink's contract is "deliver an assistant STREAM", and on those paths the
// agent never runs, so there is no stream — only a sentence we already hold.
// Returns the LAST chunk's provider message id, for the same reason
// sendWhatsAppTemplate returns one: the daily briefing records it in
// notification_log, and without it a free-form briefing would be less traceable
// than the template it replaces. Every existing caller ignores the value.
export async function sendWhatsAppText(
  body: string,
  config: WhatsAppSendConfig,
): Promise<{ providerMessageId: string | null }> {
  let last: { providerMessageId: string | null } = { providerMessageId: null };
  for (const chunk of splitForWhatsApp(body)) {
    last = await sendText(chunk, config);
  }
  return last;
}

// Sends are STRICTLY SEQUENTIAL and fail fast:
//
// - Sequential, never Promise.all: WhatsApp does not guarantee the ordering of
//   concurrent sends, and a card landing where it occurred is the whole point.
// - Fail fast: the first failing send rejects `delivery`, which the route logs
//   as whatsapp.send_failure. Pushing on would deliver a card whose buttons
//   never arrive AND a follow-up paragraph referring to them.
// - Partial delivery is survivable: the proposal row already exists, so the
//   web chat still surfaces it as pending. A failing INTERACTIVE send is the
//   one case worth narrating, because the manager has just been shown a card
//   with no way to act on it.
async function deliver(stream: ReadableStream<UIMessageChunk>, config: WhatsAppSinkConfig): Promise<void> {
  let final: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream })) {
    final = message;
  }

  for (const message of planAssistantMessages(final?.parts ?? [], config.approval, logVoiceRepairs)) {
    if (message.kind === 'text') {
      await sendText(message.body, config);
      continue;
    }
    try {
      await sendInteractive(message, config);
    } catch (err) {
      await sendText(config.approval.fallback, config).catch(() => {});
      throw err;
    }
  }
}

// The sink contract is push-based (mergeAssistantStream returns void), but a
// webhook needs to await the outbound send before the invocation ends — so
// this factory also returns `delivery`, which settles when the last Graph API
// send completes (or rejects with the first send error).
//
// Since issue #125 a MERGED turn can push more than one assistant stream
// through here — one per turn iteration — and a queued invocation can push
// none at all. That forces two properties on `delivery`:
//
//   - Streams are delivered on a CHAIN, never concurrently. WhatsApp does not
//     guarantee the ordering of concurrent sends, and iteration 2's answer
//     landing before iteration 1's would read as nonsense — the same rule
//     `deliver` applies to the sends inside one stream. A rejected chain
//     skips every later stream (fail fast, unchanged) and holds the first
//     error for the route to log.
//   - `delivery` is a THENABLE that subscribes to the chain AT AWAIT TIME,
//     not a promise created up front. The route awaits it after handleInbound
//     resolves, when every stream the turn will produce has been merged — so
//     one subscription covers them all. And when the turn merged nothing (the
//     queued path), it resolves immediately; the old promise, settled only by
//     the first merge, would have hung that invocation to the function
//     timeout.
export function whatsappSink(config: WhatsAppSinkConfig): { sink: OutboundSink; delivery: PromiseLike<void> } {
  let chain: Promise<void> = Promise.resolve();
  const sink: OutboundSink = {
    mergeAssistantStream(stream) {
      chain = chain.then(() => deliver(stream, config));
      // The route only subscribes once handleInbound returns; until then a
      // rejected chain would surface as an unhandled rejection. This marks it
      // handled without consuming it — later `then`s still see the rejection.
      chain.catch(() => {});
    },
  };
  const delivery: PromiseLike<void> = {
    then: (onFulfilled, onRejected) => chain.then(onFulfilled, onRejected),
  };
  return { sink, delivery };
}

// ── the worker sink ─────────────────────────────────────────────────────────
//
// A crew member's turn is prose and nothing else. It cannot produce an approval
// card, because a worker's roster has no `propose`, no guarded write, and no
// way to construct the ToolContext createProposal demands — the absence is
// enforced by the type checker, not by this file.
//
// So why does this exist at all, rather than reusing whatsappSink?
// WhatsAppSinkConfig REQUIRES `approval: ApprovalLabels`, and there is no
// honest value to pass. Dummy labels would be a lie waiting to be rendered, and
// the caller would have to import the copy catalog to invent them.
//
// And why does it THROW on a proposal part instead of quietly skipping one?
// Because "the sink silently dropped the card" is the exact bug this file's
// header documents as already fixed once: the manager was told an approval card
// had appeared and handed nothing at all. Reintroducing that behaviour on the
// worker path would be worse, not better — it would be invisible until the day
// a proposal appeared somewhere it never should have, and the throw is the only
// thing that would tell us the isolation had been breached.

/**
 * Pure: parts in, plain-text messages out. Split from the sink for the same
 * reason planAssistantMessages is — scripts/whatsapp-check.mts asserts the
 * throw with no credentials and no network.
 *
 * @throws if the turn contains a proposal part. See above; this is not
 *         defensive coding, it is the alarm.
 */
export function planWorkerMessages(parts: UIMessage['parts'], onRepair?: VoiceReporter): WhatsAppOutbound[] {
  const prose: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) prose.push(part.text);
      continue;
    }
    if (!isToolUIPart(part) || part.state !== 'output-available') continue;
    if (asProposalOutput(part.output)) {
      throw new Error(
        'workerSink: a worker turn produced an approval card. The worker roster cannot create proposals — this means the isolation between the two rosters has been broken.',
      );
    }
    // Every other tool output is ignored, exactly as on the manager path:
    // WhatsApp has no room for "✓ Tarefas consultadas" chips.
  }

  const joined = prose.join('\n\n').trim();
  if (!joined) return [];
  // Same order and same reasoning as the manager path above. A crew member gets
  // the identical treatment: there is no reading of this channel on which a
  // bulleted list is right for the manager and wrong for a worker, or vice
  // versa, which is why both call one function from one file.
  const voiced = applyWhatsAppVoice(toWhatsAppMarkdown(joined));
  onRepair?.(voiced.repairs);
  return splitForWhatsApp(voiced.text).map(body => ({ kind: 'text' as const, body }));
}

async function deliverWorker(stream: ReadableStream<UIMessageChunk>, config: WhatsAppSendConfig): Promise<void> {
  let final: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream })) {
    final = message;
  }
  // Sequential and fail-fast, same as deliver() above: WhatsApp does not
  // guarantee the ordering of concurrent sends.
  for (const message of planWorkerMessages(final?.parts ?? [], logVoiceRepairs)) {
    await sendText(message.body, config);
  }
}

/**
 * The worker channel's sink. Takes a plain WhatsAppSendConfig — no approval
 * labels, because there are no approvals here.
 */
export function workerSink(config: WhatsAppSendConfig): { sink: OutboundSink; delivery: Promise<void> } {
  let settle!: { resolve: () => void; reject: (err: unknown) => void };
  const delivery = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const sink: OutboundSink = {
    mergeAssistantStream(stream) {
      deliverWorker(stream, config).then(settle.resolve, settle.reject);
    },
  };
  return { sink, delivery };
}

export { toWhatsAppMarkdown } from './whatsapp-markdown';
export { applyVoice, applyWhatsAppVoice, type VoiceRepair, type VoiceResult, type VoiceRule } from './voice';
