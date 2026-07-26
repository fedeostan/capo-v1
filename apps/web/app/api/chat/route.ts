import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { handleInbound } from '@capo/core/agent';
import { webSink } from '@capo/core/channels/web';
import { getApiAuth } from '@capo/db/session';
import { assertNotBlocked, BillingBlockedError } from '@/lib/billing';
import { logEvent } from '../../../lib/log';

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
  const auth = await getApiAuth();
  // No session means no profile means no locale — a 401 body cannot be
  // localized from the user, and no client renders it. English.
  if (!auth) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  try {
    await assertNotBlocked(auth);
  } catch (e) {
    if (e instanceof BillingBlockedError) return Response.json({ error: e.message }, { status: 402 });
    throw e;
  }

  const { messages } = (await req.json()) as { messages?: UIMessage[] };
  const text = lastUserText(messages ?? []).trim();
  if (!text) return new Response('Empty message', { status: 400 });

  logEvent('chat.inbound_handled', { companyId: auth.companyId });

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      await handleInbound({
        db: auth.db,
        companyId: auth.companyId,
        userId: auth.userId,
        locales: { user: auth.locale, company: auth.companyLocale },
        inbound: { channel: 'web', text },
        sink: webSink(writer),
      });
    },
  });

  return createUIMessageStreamResponse({ stream });
}
