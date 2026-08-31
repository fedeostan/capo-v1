import type { UIMessageChunk } from 'ai';

// The channel seam. The agent core receives an InboundMessage and pushes
// output to an OutboundSink — it never returns "the reply". The web adapter
// holds an HTTP stream open against the sink; a WhatsApp adapter later acks
// the webhook immediately and its sink posts via the Meta send API.

export interface InboundMessage {
  channel: string; // 'web' | 'whatsapp'
  text: string;
  // True when `text` came from a voice note rather than typing. Audio is
  // transcribed at the EDGE (in the channel adapter) and handed to the core as
  // plain text, so the core never learns about media — deliberately: widening
  // this type to carry bytes would push decoding, size limits, and provider
  // media APIs into the agent loop. The flag is for logging and a possible 🎙
  // affordance in the web thread, not for behavior.
  transcribed?: boolean;
}

export interface OutboundSink {
  // Deliver the assistant's output stream for this turn. UIMessageChunk is the
  // SDK's channel-neutral representation; non-web sinks can accumulate it into
  // plain text messages.
  //
  // Called once per turn ITERATION, which since issue #125 can be more than
  // once per handleInbound call (a merged turn answers queued messages by
  // running again) or zero times (a queued message returns without running —
  // the lock holder answers it). A sink must deliver multiple streams in call
  // order and must not treat "never called" as an error.
  mergeAssistantStream(stream: ReadableStream<UIMessageChunk>): void;
}
