import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { handleInbound } from '@/src/agent/core';
import { webSink } from '@/src/channels/web';

export const maxDuration = 120;

// Inbound web adapter. The server owns conversation history (loaded from the
// DB by the core), so only the newest user text is taken from the request.
function lastUserText(messages: UIMessage[]): string {
  const last = [...messages].reverse().find(m => m.role === 'user');
  return (
    last?.parts
      .filter(p => p.type === 'text')
      .map(p => p.text)
      .join('\n') ?? ''
  );
}

export async function POST(req: Request) {
  const { messages } = (await req.json()) as { messages?: UIMessage[] };
  const text = lastUserText(messages ?? []).trim();
  if (!text) return new Response('Empty message', { status: 400 });

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      await handleInbound({ channel: 'web', text }, webSink(writer));
    },
  });

  return createUIMessageStreamResponse({ stream });
}
