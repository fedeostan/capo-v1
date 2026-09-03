import { after } from 'next/server';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { handleInbound } from '@capo/core/agent';
import { webSink } from '@capo/core/channels/web';
import { getApiAuth } from '@capo/db/session';
import { assertNotBlocked, BillingBlockedError } from '@/lib/billing';
import { siteUrl } from '@/lib/site-url';
import { logEvent } from '../../../lib/log';
import { drainAssignmentNotices } from '../../notifications/task-assigned';
import { welcomeAnyoneNew } from '../../../lib/welcome-trigger';

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
        // The address of this deployment, so Capo can hand the manager his own
        // dashboard at the end of the setup conversation. Read here rather than
        // in @capo/core, which touches no environment by contract.
        appUrl: siteUrl(),
        locales: { user: auth.locale, company: auth.companyLocale },
        inbound: { channel: 'web', text },
        sink: webSink(writer),
      });

      // A manager turn can have added a crew member and recorded their consent
      // in the same breath ("põe o Zé, 912 345 678, ele já disse que sim"), and
      // until this line that person waited for the next */15 sweep — up to
      // fifteen minutes, or until 09:00 tomorrow if the conversation happened
      // in the evening.
      //
      // It takes only the company id: the sweep re-derives who is owed a
      // welcome from the database, so this route never has to inspect what the
      // turn actually did, and a tool added next year needs no hook here. See
      // lib/welcome-trigger.ts, which cannot throw.
      after(() => welcomeAnyoneNew(auth.companyId, 'chat'));
    },
  });

  // ── the crew hears about a new task now, not tomorrow at 07:00 (W7) ───────
  // after() runs once the stream has finished, so the turn's writes are on
  // disk by the time the queue is read. One line, and it never throws:
  // announcing an assignment must never cost the manager their answer. The
  // fifteen-minute cron (/api/cron/task-assigned) is what makes this line an
  // optimisation rather than the mechanism.
  after(() => drainAssignmentNotices({ companyId: auth.companyId }));

  return createUIMessageStreamResponse({ stream });
}
