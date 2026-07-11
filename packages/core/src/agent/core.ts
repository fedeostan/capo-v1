import {
  ToolLoopAgent,
  convertToModelMessages,
  readUIMessageStream,
  stepCountIs,
  toUIMessageStream,
  type UIMessage,
} from 'ai';
import { toAiTools } from '../capabilities';
import type { Db } from '@capo/db/client';
import type { ToolContext } from '../capabilities/types';
import type { InboundMessage, OutboundSink } from '../channels/types';
import { buildSystemPrompt } from './context';
import { getModel } from './models';
import {
  ensureConversation,
  loadWindow,
  persistAssistantMessage,
  persistUserMessage,
  toThread,
} from './memory/conversation';
import { maybeSummarize } from './memory/summarizer';

// The Interaction Agent loop: context → model → tools → sink. Channel-agnostic
// by contract — message in, output pushed to the sink, nothing returned. The
// core also owns persistence: the assistant stream is tee'd so the channel
// gets chunks live while the final message is accumulated for the DB.
//
// The caller supplies the tenant: web passes the logged-in manager's
// RLS-scoped client + companyId (so even a misbehaving tool physically cannot
// cross tenants); a future system channel (WhatsApp inbound) would resolve
// the company by sender phone and pass the service client instead.
export async function handleInbound(
  db: Db,
  companyId: string,
  inbound: InboundMessage,
  sink: OutboundSink,
): Promise<void> {
  const conversationId = await ensureConversation(db, companyId);

  await persistUserMessage(db, conversationId, inbound.text, inbound.channel);
  const thread = toThread(await loadWindow(db, conversationId));

  const ctx: ToolContext = {
    companyId,
    conversationId,
    db,
    actor: 'manager',
    recentUserTexts: thread.recentUserTexts,
  };

  const agent = new ToolLoopAgent({
    model: getModel('conversation'),
    instructions: await buildSystemPrompt(db, companyId, thread.summary),
    tools: toAiTools(ctx),
    stopWhen: stepCountIs(12),
  });

  const result = await agent.stream({
    messages: await convertToModelMessages(thread.uiMessages),
  });

  const [forSink, forPersistence] = toUIMessageStream({ stream: result.stream }).tee();
  sink.mergeAssistantStream(forSink);

  let finalMessage: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream: forPersistence })) {
    finalMessage = message;
  }
  if (finalMessage) {
    await persistAssistantMessage(db, conversationId, finalMessage, inbound.channel);
  }

  await maybeSummarize(db, conversationId);
}
