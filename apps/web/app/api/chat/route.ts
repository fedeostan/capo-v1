import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { handleInbound } from '@capo/core/agent';
import { webSink } from '@capo/core/channels/web';
import { getDb } from '@capo/db/client';
import { getApiAuth } from '@capo/db/session';
import { assertNotBlocked, BillingBlockedError } from '@/lib/billing';
import { whatsappSendEnv } from '@/lib/whatsapp';
import { whatsappWorkerMessenger } from '../../notifications/worker-message';
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
        // Straight off the AuthContext — the profile row was already read by
        // getApiAuth, so the posture costs no extra query and cannot disagree
        // with what /perfil shows.
        confirmPosture: auth.confirmPosture,
        // Reaching one crew member (issue #123). The SERVICE client, and
        // deliberately not `auth.db`: a WhatsApp send has to claim a row in
        // notification_log, which is deny-all for tenants (0016), and the paid
        // ledger is a system concern. What keeps it inside this tenant is
        // `companyId`, which the messenger scopes every read by, and which
        // comes off the session rather than off anything the model wrote.
        //
        // Env is read HERE, inside the handler, never at module scope: a
        // module-scope read of a secret breaks `next build` in CI. A missing
        // WhatsApp config yields null, and Capo says it cannot reach the crew
        // rather than pretending it did.
        messageWorker: whatsappWorkerMessenger(getDb, whatsappSendEnv()),
        locales: { user: auth.locale, company: auth.companyLocale },
        inbound: { channel: 'web', text },
        sink: webSink(writer),
      });
    },
  });

  return createUIMessageStreamResponse({ stream });
}
