import { isToolUIPart, readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import type { OutboundSink } from './types';
import { toWhatsAppMarkdown } from './whatsapp-markdown';

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

export interface WhatsAppSendConfig {
  accessToken: string;
  phoneNumberId: string;
  /** Who to send to, and which envelope field carries them. */
  recipient: WhatsAppRecipient;
  /** Overridable for tests; defaults to the live Graph API. */
  graphApiBase?: string;
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
  const elapsed = now - at;
  // `elapsed >= 0` refuses a future timestamp. NaN in `now` (nothing should
  // pass one, but the arithmetic would propagate it silently) fails both
  // comparisons, which is again the closed direction.
  return elapsed >= 0 && elapsed <= windowMs;
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

export interface WhatsAppWebhookEnvelope<M> {
  entry?: {
    changes?: {
      field?: string;
      value?: {
        messages?: M[];
        user_id_update?: unknown[];
      };
    }[];
  }[];
}

export interface RoutedWebhook<M> {
  messages: M[];
  rotations: BsuidRotation[];
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
  const unhandledFields: string[] = [];
  let unreadableRotations = 0;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      // The field-absent branch is a COMPATIBILITY guard, not tidiness. Meta
      // always sets `field`, but the route this replaces never read it, so any
      // payload that works today must keep working — including one from a test
      // harness that omits it. Dispatching on a missing field alone would drop
      // real messages, which is the one regression this change must not have.
      if (change.field === 'messages' || (change.field === undefined && change.value?.messages)) {
        messages.push(...(change.value?.messages ?? []));
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

  return { messages, rotations, unhandledFields, unreadableRotations };
}

// ── outbound planning ───────────────────────────────────────────────────────

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
export function planAssistantMessages(
  parts: UIMessage['parts'],
  labels: ApprovalLabels,
): WhatsAppOutbound[] {
  const out: WhatsAppOutbound[] = [];
  let prose: string[] = [];

  // Convert THEN split: splitting first could cut a `**` pair across a chunk
  // boundary, leaving a stray asterisk the converter can no longer pair up.
  const flush = () => {
    const joined = prose.join('\n\n').trim();
    prose = [];
    if (!joined) return;
    for (const chunk of splitForWhatsApp(toWhatsAppMarkdown(joined))) {
      out.push({ kind: 'text', body: chunk });
    }
  };

  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) prose.push(part.text);
      continue;
    }
    if (!isToolUIPart(part) || part.state !== 'output-available') continue;
    const proposal = asProposalOutput(part.output);
    if (!proposal) continue;

    // Flush first so the card lands where it occurred in the turn, not after
    // all the prose. Other tool outputs are ignored entirely: WhatsApp has no
    // room for "✓ Tarefas consultadas" chips and the web thread already shows
    // them.
    flush();

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

// Returns the provider message id so the reminder cron can record it in
// notification_log; the sink's own sends ignore it.
async function post(
  payload: Record<string, unknown>,
  config: WhatsAppSendConfig,
): Promise<{ providerMessageId: string | null }> {
  const base = config.graphApiBase ?? 'https://graph.facebook.com/v23.0';
  const res = await fetch(`${base}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildSendBody(payload, config.recipient)),
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

async function sendText(
  body: string,
  config: WhatsAppSendConfig,
): Promise<{ providerMessageId: string | null }> {
  return await post({ type: 'text', text: { body } }, config);
}

// No header (plain-text only on Meta's side, and it would just duplicate the
// card's first line) and no footer.
async function sendInteractive(
  message: Extract<WhatsAppOutbound, { kind: 'interactive' }>,
  config: WhatsAppSendConfig,
): Promise<void> {
  await post(
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

// Public: the webhook needs a direct send for the voice-note failure path and
// for the confirmation after a button press. It cannot reuse the sink there,
// because `delivery` only settles once mergeAssistantStream has been called —
// and on those paths the agent never runs, so it never would.
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

  for (const message of planAssistantMessages(final?.parts ?? [], config.approval)) {
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
export function whatsappSink(config: WhatsAppSinkConfig): { sink: OutboundSink; delivery: Promise<void> } {
  let settle!: { resolve: () => void; reject: (err: unknown) => void };
  const delivery = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const sink: OutboundSink = {
    mergeAssistantStream(stream) {
      deliver(stream, config).then(settle.resolve, settle.reject);
    },
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
export function planWorkerMessages(parts: UIMessage['parts']): WhatsAppOutbound[] {
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
  return splitForWhatsApp(toWhatsAppMarkdown(joined)).map(body => ({ kind: 'text' as const, body }));
}

async function deliverWorker(stream: ReadableStream<UIMessageChunk>, config: WhatsAppSendConfig): Promise<void> {
  let final: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream })) {
    final = message;
  }
  // Sequential and fail-fast, same as deliver() above: WhatsApp does not
  // guarantee the ordering of concurrent sends.
  for (const message of planWorkerMessages(final?.parts ?? [])) {
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
