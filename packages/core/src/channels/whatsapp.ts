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
// 24-hour window note: this sink only ever REPLIES to an inbound message, so
// it is always inside Meta's 24h customer-service window, where free-form text
// AND interactive messages are both allowed. Proactive/outside-window sends
// need an approved template — a template path is deliberately not implemented
// until a real need appears (see docs/whatsapp-cloud-api-runbook.md).

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

async function post(payload: Record<string, unknown>, config: WhatsAppSendConfig): Promise<void> {
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
    throw new Error(`WhatsApp send failed (${res.status}): ${await res.text()}`);
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
