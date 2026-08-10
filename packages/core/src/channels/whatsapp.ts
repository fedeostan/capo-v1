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

export interface WhatsAppSendConfig {
  accessToken: string;
  phoneNumberId: string;
  /** Recipient phone in Meta's wa_id format (digits, no '+'). */
  to: string;
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
// The 16:30 check-in's two template buttons. Same shape and the same reasoning
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
    body: JSON.stringify({ messaging_product: 'whatsapp', to: config.to, ...payload }),
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

async function sendText(body: string, config: WhatsAppSendConfig): Promise<void> {
  await post({ type: 'text', text: { body } }, config);
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
export async function sendWhatsAppText(body: string, config: WhatsAppSendConfig): Promise<void> {
  for (const chunk of splitForWhatsApp(body)) {
    await sendText(chunk, config);
  }
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

export { toWhatsAppMarkdown } from './whatsapp-markdown';
