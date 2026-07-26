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
// 24-hour window note: this SINK only ever REPLIES to an inbound message, so
// it is always inside Meta's 24h customer-service window and free-form text is
// allowed. The daily reminder cron is the opposite case — it messages someone
// who has not written to us — so `sendWhatsAppTemplate` below exists for it.
//
// The window rule that catches people out: sending a template does NOT open
// the window. Only the RECIPIENT's reply does. A worker who never replies
// therefore needs a paid template every single day, which is why the webhook
// acknowledges worker replies (see apps/web/app/api/whatsapp/route.ts) —
// that ack is what converts them to free session messages.

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

export interface WhatsAppTemplate {
  name: string;
  /** Meta's locale format — 'pt_PT', 'es_ES', 'en_US'. Underscore, not hyphen. */
  languageCode: string;
  /** Positional {{1}}, {{2}}… body parameters, in order. */
  bodyParams: string[];
}

// Proactive send: the only path that can reach someone who has not messaged us
// first. The template and its language must already be approved in WhatsApp
// Manager — see docs/whatsapp-cloud-api-runbook.md.
export async function sendWhatsAppTemplate(
  template: WhatsAppTemplate,
  config: WhatsAppSinkConfig,
): Promise<{ providerMessageId: string | null }> {
  return await post(
    {
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.languageCode },
        components: [
          {
            type: 'body',
            parameters: template.bodyParams.map(text => ({ type: 'text', text: toTemplateParam(text) })),
          },
        ],
      },
    },
    config,
  );
}

// Public: the webhook needs a direct send for the voice-note failure path and
// for worker acknowledgements. It cannot reuse the sink there, because
// `delivery` only settles once mergeAssistantStream has been called — and on
// those paths the agent never runs, so it never would.
export async function sendWhatsAppText(
  body: string,
  config: WhatsAppSinkConfig,
): Promise<{ providerMessageId: string | null }> {
  let first: string | null = null;
  for (const chunk of splitForWhatsApp(body)) {
    const { providerMessageId } = await sendText(chunk, config);
    first ??= providerMessageId;
  }
  return { providerMessageId: first };
}

async function sendText(body: string, config: WhatsAppSinkConfig): Promise<{ providerMessageId: string | null }> {
  return await post({ type: 'text', text: { body } }, config);
}

async function post(
  payload: Record<string, unknown>,
  config: WhatsAppSinkConfig,
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
  await sendWhatsAppText(text, config);
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
