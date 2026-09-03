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
import {
  claimConversationTurn,
  finishConversationTurn,
  logTurnEvent,
  renewConversationTurn,
  TURN_MERGE_CAP,
  type TurnRef,
} from './turn-lock';

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
  // Where this manager's dashboard lives. Supplied by the app layer, because
  // this package reads no environment. Required for the same reason
  // confirmPosture is: see ToolContext.appUrl.
  appUrl: string;
  inbound: InboundMessage;
  sink: OutboundSink;
}

// Turn serialization (issue #125): a turn for a conversation may not begin
// while another runs for the same conversation. The lock lives in Postgres
// (0040) — see ./turn-lock for why and for the degrade posture. The shape
// here:
//
//   claimed  → run the turn; at finish, 'continue' means messages queued
//              behind it, answered by running ANOTHER full iteration over the
//              reloaded window — one merged turn instead of N racing ones.
//   queued   → return. The holder's merged turn answers this message; the
//              read receipt the route already sent is the feedback (#50's
//              typing indicator lapses on its own, a known shape).
//   unavailable → run unlocked, byte-for-byte the pre-0040 product.
export async function handleInbound(opts: HandleInboundOptions): Promise<void> {
  const { db, companyId, inbound } = opts;
  const conversationId = await ensureConversation(db, companyId);

  // The message is saved BEFORE the lock is consulted, no matter what happens
  // to the turn after it. Two things rest on that order: a queued message is
  // in the thread before its claim sets the queued mark, so the holder's
  // reloaded window always contains it; and a message whose turn dies is
  // still there for the next turn to answer (what made 31 Aug recoverable).
  await persistUserMessage(db, conversationId, inbound.text, inbound.channel);

  const ref: TurnRef = { conversationId, companyId, token: crypto.randomUUID() };
  const claim = await claimConversationTurn(db, ref);

  if (claim === 'queued') {
    logTurnEvent('agent.turn_queued', { conversationId, companyId, channel: inbound.channel });
    return;
  }

  if (claim === 'unavailable') {
    await runTurnIteration(opts, conversationId, null);
    return;
  }

  // 'claimed': the merge loop. Every exit that owns the lock releases it —
  // the finally is the backstop for throws, so a failed turn frees the
  // conversation BEFORE the route's catch sends the #126 apology.
  let iterations = 0;
  let finishRounds = 0;
  let settled = false;
  try {
    // Whether the next pass runs the agent, and the created_at of the newest
    // user row the last iteration's window held. A queued mark only proves a
    // message arrived AFTER THE CLAIM — it may still have landed before this
    // turn's window was loaded and be answered already; running the agent
    // again over nothing new would send the manager an answer to no question.
    let runAgent = true;
    let answeredThrough: string | null = null;
    while (true) {
      if (runAgent) {
        iterations += 1;
        answeredThrough = await runTurnIteration(opts, conversationId, ref);
      }

      const finish = await finishConversationTurn(db, ref);
      if (finish === 'released') {
        settled = true;
        return;
      }
      if (finish === 'lost') {
        // The lease expired mid-turn and another invocation owns the lock.
        // Stop — our context is stale by definition. Honestly: this
        // iteration's answer was already handed to the sink before finish
        // could learn the lease was gone; the TTL plus per-step renewal keeps
        // that window small, it does not close it.
        settled = true;
        logTurnEvent('agent.turn_lost', { conversationId, companyId, iterations });
        return;
      }
      if (finish === 'unavailable') {
        // The RPC itself failed; the lease lapses on its own within the TTL.
        // The finally still attempts a force-release in case only this call
        // was unlucky.
        return;
      }

      // 'continue': messages queued while the iteration ran. finishRounds
      // bounds the check-release ping-pong (each round is two cheap queries,
      // no model call); TURN_MERGE_CAP bounds the model spend.
      finishRounds += 1;
      if (iterations >= TURN_MERGE_CAP || finishRounds > 10) {
        await finishConversationTurn(db, ref, { force: true });
        settled = true;
        logTurnEvent('agent.turn_merge_capped', { conversationId, companyId, iterations });
        return;
      }

      runAgent = await hasUserMessageAfter(db, conversationId, answeredThrough);
      if (!runAgent) {
        // The mark was stale — the message it announced was already in the
        // window this turn answered. Loop back to finish: the mark is cleared
        // now, so the next round releases unless a genuinely new message
        // queued in the meantime.
        logTurnEvent('agent.turn_merge_noop', { conversationId, companyId, iterations });
      }
    }
  } finally {
    if (!settled) {
      // Throw path (or a failed finish): free the conversation now. The #126
      // apology composes with this — finally runs before the route's catch,
      // so by the time the apology goes out the next message can already
      // claim a fresh turn. finishConversationTurn never throws.
      await finishConversationTurn(db, ref, { force: true });
    }
  }
}

// Is there a user message the merged turn has not answered yet? Consulted only
// on 'continue', to avoid billing an agent iteration for a mark that arrived
// about a message the previous window already contained. Errs toward true —
// an unreadable table must not eat a real question; the iteration's own
// window read is the authority (and will surface the same failure loudly).
async function hasUserMessageAfter(
  db: Db,
  conversationId: string,
  answeredThrough: string | null,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversationId)
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return true;
    if (!data) return false;
    if (answeredThrough === null) return true;
    return new Date(data.created_at).getTime() > new Date(answeredThrough).getTime();
  } catch {
    return true;
  }
}

// One full agent iteration over the CURRENT thread window: load, run, stream
// to the sink, persist, maybe summarize. Both the lone-message turn and every
// merged-turn iteration go through here — one body, so the two cannot drift.
// Returns the created_at of the newest user row the window held (null when it
// held none), which is what the merge loop compares against to spot a stale
// queued mark. `lock` is null on the unlocked degrade path, where there is no
// lease to renew.
async function runTurnIteration(
  opts: HandleInboundOptions,
  conversationId: string,
  lock: TurnRef | null,
): Promise<string | null> {
  const { db, companyId, userId, locales, confirmPosture, appUrl, inbound, sink } = opts;

  const window = await loadWindow(db, conversationId);
  const thread = toThread(window);

  const ctx: ToolContext = {
    companyId,
    conversationId,
    db,
    actor: 'manager',
    recentUserTexts: thread.recentUserTexts,
    userId,
    confirmPosture,
    appUrl,
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
    // `userId` goes in so the prompt can carry the manager's CURRENT name as a
    // live fact (issue #62) instead of leaving the model to read one out of the
    // conversation summary, which freezes whatever name was current when it was
    // written.
    instructions: await buildSystemPrompt({ db, companyId, userId, appUrl, summary: thread.summary, locales }),
    tools: withToolCacheBreakpoint(toAiTools(ctx)),
    stopWhen: stepCountIs(12),
  });

  const result = await agent.stream({
    messages: await convertToModelMessages(thread.uiMessages),
    // Lease heartbeat (issue #125): fire-and-forget between model steps, so a
    // healthy turn outlives its TTL indefinitely while a dead one stops
    // renewing and self-clears. Never awaited — a slow renewal must not slow
    // the answer, and renewConversationTurn never rejects.
    onStepEnd: lock ? () => void renewConversationTurn(db, lock) : undefined,
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

  for (let i = window.rows.length - 1; i >= 0; i -= 1) {
    if (window.rows[i].role === 'user') return window.rows[i].created_at;
  }
  return null;
}
