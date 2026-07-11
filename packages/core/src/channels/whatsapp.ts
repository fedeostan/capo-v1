import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import type { OutboundSink } from './types';

// WhatsApp channel sink: consumes the assistant's UIMessageChunk stream,
// accumulates it into plain text (tool/reasoning parts are persisted with
// full fidelity by the core — WhatsApp only ever sees the final prose), and
// posts it via the Meta Graph API `messages` endpoint.
//
// Config is injected by the caller (the webhook route reads the env lazily);
// this package never touches process.env.
//
// 24-hour window note: this sink only ever REPLIES to an inbound message, so
// it is always inside Meta's 24h customer-service window and free-form text
// is allowed. Proactive/outside-window sends need an approved template — a
// template path is deliberately not implemented until a real need appears
// (see docs/whatsapp-cloud-api-runbook.md).

export interface WhatsAppSinkConfig {
  accessToken: string;
  phoneNumberId: string;
  /** Recipient phone in Meta's wa_id format (digits, no '+'). */
  to: string;
  /** Overridable for tests; defaults to the live Graph API. */
  graphApiBase?: string;
}

// WhatsApp rejects bodies over 4096 chars; split on paragraph boundaries
// where possible, hard-slice as a last resort.
const MAX_BODY = 4000;

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

async function sendText(body: string, config: WhatsAppSinkConfig): Promise<void> {
  const base = config.graphApiBase ?? 'https://graph.facebook.com/v23.0';
  const res = await fetch(`${base}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: config.to,
      type: 'text',
      text: { body },
    }),
  });
  if (!res.ok) {
    throw new Error(`WhatsApp send failed (${res.status}): ${await res.text()}`);
  }
}

async function deliver(stream: ReadableStream<UIMessageChunk>, config: WhatsAppSinkConfig): Promise<void> {
  let final: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream })) {
    final = message;
  }
  const text = (final?.parts ?? [])
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('\n\n')
    .trim();
  if (!text) return;
  for (const chunk of splitForWhatsApp(text)) {
    await sendText(chunk, config);
  }
}

// The sink contract is push-based (mergeAssistantStream returns void), but a
// webhook needs to await the outbound send before the invocation ends — so
// this factory also returns `delivery`, which settles when the Graph API send
// completes (or rejects with the send error).
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
