import type { UIMessageChunk } from 'ai';

// The channel seam. The agent core receives an InboundMessage and pushes
// output to an OutboundSink — it never returns "the reply". The web adapter
// holds an HTTP stream open against the sink; a WhatsApp adapter later acks
// the webhook immediately and its sink posts via the Meta send API.

export interface InboundMessage {
  channel: string; // e.g. 'web', later 'whatsapp'
  text: string;
}

export interface OutboundSink {
  // Deliver the assistant's output stream for this turn. UIMessageChunk is the
  // SDK's channel-neutral representation; non-web sinks can accumulate it into
  // plain text messages.
  mergeAssistantStream(stream: ReadableStream<UIMessageChunk>): void;
}
