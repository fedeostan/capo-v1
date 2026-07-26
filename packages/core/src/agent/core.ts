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
import type { LocaleContext } from '@capo/i18n/locale';
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
// cross tenants); the WhatsApp channel resolves the company by sender phone
// and passes the service client instead.
//
// An options object rather than positionals: this grew past the point where a
// call site reads unambiguously, and every caller is in this repo.
export interface HandleInboundOptions {
  db: Db;
  companyId: string;
  // The human on the other end. Web reads it from the session; WhatsApp from
  // the profiles row it matched by phone. See ToolContext.userId for why it is
  // not optional.
  userId: string;
  // Both dials, resolved by the caller — core never guesses a language.
  locales: LocaleContext;
  inbound: InboundMessage;
  sink: OutboundSink;
}

export async function handleInbound(opts: HandleInboundOptions): Promise<void> {
  const { db, companyId, userId, locales, inbound, sink } = opts;
  const conversationId = await ensureConversation(db, companyId);

  await persistUserMessage(db, conversationId, inbound.text, inbound.channel);
  const thread = toThread(await loadWindow(db, conversationId));

  const ctx: ToolContext = {
    companyId,
    conversationId,
    db,
    actor: 'manager',
    recentUserTexts: thread.recentUserTexts,
    userId,
    locales,
  };

  const agent = new ToolLoopAgent({
    model: getModel('conversation'),
    instructions: await buildSystemPrompt(db, companyId, thread.summary, locales),
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

  // ctx.locales.user, not the parameter: set_language may have changed it
  // mid-loop, and the summary should be written in the language the manager
  // ended the turn in.
  await maybeSummarize(db, conversationId, ctx.locales.user);
}
