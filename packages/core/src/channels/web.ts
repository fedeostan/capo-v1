import type { UIMessageStreamWriter } from 'ai';
import type { OutboundSink } from './types';

// Web channel: the sink merges the assistant stream into the open HTTP
// response. A WhatsApp sink later consumes the same chunks and posts via the
// Meta send API instead.
export function webSink(writer: UIMessageStreamWriter): OutboundSink {
  return {
    mergeAssistantStream: stream => writer.merge(stream),
  };
}
