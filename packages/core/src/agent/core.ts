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
import type { ConfirmPosture } from '@capo/db/posture';
import type { LocaleContext } from '@capo/i18n/locale';
import type { ToolContext } from '../capabilities/types';
import type { InboundMessage, OutboundSink } from '../channels/types';
import { withToolCacheBreakpoint } from './cache';
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
  // profiles.confirm_posture for THAT person (0031, issue #57). Required for
  // the same reason userId is: every caller has already read the profile row
  // this comes from, and a defaulted optional would let a new channel ship with
  // the riskier posture by omission. See ToolContext.confirmPosture.
  confirmPosture: ConfirmPosture;
  inbound: InboundMessage;
  sink: OutboundSink;
}

export async function handleInbound(opts: HandleInboundOptions): Promise<void> {
  const { db, companyId, userId, locales, confirmPosture, inbound, sink } = opts;
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
    confirmPosture,
    locales,
  };

  // Prompt caching (issue #58): the tool schemas and the stable half of the
  // system prompt each carry a cache breakpoint. This matters most HERE rather
  // than across turns — stopWhen(12) means one manager message can cost twelve
  // API requests seconds apart, every one of them re-sending that identical
  // prefix. The roster is applied through the wrapper rather than inside
  // toAiTools so ../capabilities stays unaware of the provider.
  const agent = new ToolLoopAgent({
    // Usage accounting (issue #53): attributed to THIS manager, on the client
    // the caller already handed us. Every step of the loop below writes its own
    // ai_usage row — a twelve-step turn is twelve rows, which is the point.
    model: getModel('conversation', {
      db,
      companyId,
      surface: 'manager_chat',
      actor: { kind: 'manager', profileId: userId },
    }),
    instructions: await buildSystemPrompt(db, companyId, thread.summary, locales),
    tools: withToolCacheBreakpoint(toAiTools(ctx)),
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
  //
  // The summarizer's tokens are billed to the manager whose turn triggered it,
  // not to 'system'. Nobody asks for a summary, but it is caused by exactly one
  // person's traffic and a per-person cost figure that hid it would understate
  // a chatty manager by a whole model call every ~40 messages.
  await maybeSummarize(db, conversationId, ctx.locales.user, { companyId, profileId: userId });
}
