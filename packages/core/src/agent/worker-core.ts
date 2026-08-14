import {
  ToolLoopAgent,
  convertToModelMessages,
  readUIMessageStream,
  stepCountIs,
  toUIMessageStream,
  type UIMessage,
} from 'ai';
import type { Db } from '@capo/db/client';
import type { Locale } from '@capo/i18n/locale';
import type { OutboundSink } from '../channels/types';
import { toWorkerAiTools } from '../capabilities/worker';
import type { PendingPhoto, WorkerContext } from '../capabilities/worker/types';
import { loadWorkerTasks } from '../capabilities/worker/tasks';
import { withToolCacheBreakpoint } from './cache';
import { buildWorkerSystemPrompt } from './worker-context';
import { getModel } from './models';
import {
  ensureWorkerConversation,
  loadWorkerWindow,
  persistWorkerAssistantMessage,
  persistWorkerUserMessage,
  readWorkerBudget,
  type WorkerMessageTarget,
} from './memory/worker-conversation';

// The restricted worker loop — the crew's counterpart to handleInbound().
//
// A SEPARATE ENTRY POINT, not a parameter on the existing one, and that is the
// whole architecture in one sentence. handleInbound() is untouched by this
// feature: same signature, same roster, same guard, same persistence. If a
// future change finds itself adding an `audience` flag to that function, the
// isolation has already failed — the two loops share a model provider and
// nothing else.
//
// What is different here, and why:
//   - a roster of four tools in their own type system, so a manager capability
//     is a compile error rather than a review comment
//   - its own conversation tables, so worker text can never become the evidence
//     the manager's write guard reads (0027)
//   - stepCountIs(6), half the manager's 12: nothing in this roster needs a
//     long chain, and the person who decides how many turns to spend is not the
//     person paying for them
//   - a daily budget, checked before the first token
//
// The honest test for all of it is not "can someone trick the model" — assume
// they can. It is "what does a fully-compromised turn get them", and the answer
// is: their own task list (already WhatsApp'd to that phone at 07:00), an
// answer from a public construction library, a false completion claim on their
// OWN task that lands visibly in the manager's review pile, and their own
// language switched. No other worker's work, no client names, no schedule
// changes, no money, and no way to put words in the manager's mouth.

/** Model turns per inbound message. Half the manager's 12 (core.ts:71). */
const WORKER_STEPS = 6;

/**
 * Inbound text is truncated before it reaches the model.
 *
 * WhatsApp allows ~4096 characters and this is the one path where somebody
 * hostile chooses the payload AND how often it arrives. A cap bounds both the
 * cost of a turn and the size of any single injection attempt. It is not a
 * defence on its own — a short sentence is quite enough to try something — it
 * just removes "very long" as a free variable.
 */
const MAX_INBOUND_CHARS = 1500;

/**
 * What a photo-only message says. WhatsApp sends an image with no caption as a
 * message with no text at all, and an empty user turn is both awkward for the
 * model and unreadable for a manager scrolling the thread later. Stored
 * verbatim, so what the thread shows is true: a photo arrived and nothing was
 * said.
 */
const PHOTO_ONLY_TEXT = '(photo, no message)';

export interface HandleWorkerInboundOptions {
  /** ALWAYS the service role. There is no session on this path. */
  db: Db;
  /** Both resolved from the crew row matched by phone/BSUID — never from input. */
  companyId: string;
  workerId: string;
  /** workers.language ?? companies.language, resolved by the caller. */
  locale: Locale;
  inbound: { channel: string; text: string; transcribed?: boolean };
  /** Downloaded in the webhook and held in memory for this turn only. */
  photos: readonly PendingPhoto[];
  sink: OutboundSink;
}

export type WorkerTurnOutcome =
  | { outcome: 'answered' }
  /** The daily cap was already spent. ZERO model calls were made. */
  | { outcome: 'budget_exhausted'; limit: 'worker' | 'company' };

export async function handleWorkerInbound(opts: HandleWorkerInboundOptions): Promise<WorkerTurnOutcome> {
  const { db, companyId, workerId, locale, inbound, photos, sink } = opts;

  // One clock — the same lisbon_today() task_board reads and the same one the
  // database stamps onto worker_messages.usage_date. Reading it here rather
  // than computing a local date is what makes the budget's "today" and the
  // board's "today" the same day, including across a DST boundary.
  const { data: today, error: todayError } = await db.rpc('lisbon_today');
  if (todayError || !today) throw new Error(`worker turn: lisbon_today failed: ${todayError?.message ?? 'no value'}`);

  const conversationId = await ensureWorkerConversation(db, companyId, workerId);

  // ── the budget, BEFORE anything expensive ────────────────────────────────
  // Above the check-in lookup, above the task read, above the prompt build, and
  // far above the model. An exhausted worker costs two counted queries and
  // nothing else, which is the point: a cap that spent money to enforce itself
  // would be a cost amplifier rather than a limiter.
  const budget = await readWorkerBudget(db, companyId, conversationId, today);
  if (budget.exhausted) return { outcome: 'budget_exhausted', limit: budget.exhausted };

  // Which evening's ask this belongs to. The PRD names notification_log's
  // columns here (status='sent', notification_date); the FK on
  // worker_messages.checkin_id points at worker_checkins, so the binding is to
  // the worker's own ANSWER — which is also the better episode boundary, since
  // a tap is what actually starts a conversation. A worker who never tapped
  // gets checkinId = null and the 24-hour window instead, which covers the same
  // messages by a different route.
  //
  // `today - 1` in the same string arithmetic the rest of the repo uses on
  // lisbon_today()'s ISO date: yesterday's ask is still live (the buttons stay
  // tappable overnight), anything older is expired.
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const { data: checkin } = await db
    .from('worker_checkins')
    .select('id')
    .eq('company_id', companyId)
    .eq('worker_id', workerId)
    .gte('checkin_date', yesterday.toISOString().slice(0, 10))
    .order('checkin_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const checkinId = checkin?.id ?? null;

  // Computed BEFORE the model runs, and never widened by anything it or the
  // worker says. This list is `declare_task_done`'s entire notion of what
  // exists, which is why a valid uuid belonging to a colleague in the same
  // company is refused without a database round trip.
  const tasks = await loadWorkerTasks(db, companyId, workerId);
  const scope = { taskIds: tasks.map(t => t.id) as readonly string[] };

  const text = (inbound.text.trim() || (photos.length > 0 ? PHOTO_ONLY_TEXT : '')).slice(0, MAX_INBOUND_CHARS);
  const target: WorkerMessageTarget = { conversationId, companyId, checkinId, channel: inbound.channel };

  await persistWorkerUserMessage(db, target, text, photos.length);
  const uiMessages = await loadWorkerWindow(db, conversationId, checkinId);

  const ctx: WorkerContext = {
    db,
    companyId,
    workerId,
    conversationId,
    locale,
    scope,
    checkinId,
    pendingPhotos: photos,
    budget: budget.remaining,
  };

  // Prompt caching (issue #58), the worker's own two breakpoints — its own
  // roster and its own stable prompt half, never the manager's. Both loops
  // reach ../agent/cache.ts, which is provider plumbing in the same sense
  // ./models.ts is: it speaks only `string` and the AI SDK's `ToolSet`, so no
  // Capo tool type or context can travel through it.
  const agent = new ToolLoopAgent({
    model: getModel('conversation'),
    instructions: await buildWorkerSystemPrompt({ db, locale, today, tasks, pendingPhotos: photos }),
    tools: withToolCacheBreakpoint(toWorkerAiTools(ctx)),
    stopWhen: stepCountIs(WORKER_STEPS),
  });

  const result = await agent.stream({ messages: await convertToModelMessages(uiMessages) });

  const [forSink, forPersistence] = toUIMessageStream({ stream: result.stream }).tee();
  sink.mergeAssistantStream(forSink);

  let finalMessage: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream: forPersistence })) {
    finalMessage = message;
  }
  if (finalMessage) await persistWorkerAssistantMessage(db, target, finalMessage);

  // No summarizer call here, unlike handleInbound. See the header of
  // ./memory/worker-conversation.ts — a worker thread is episodic, and a
  // summarizer would be a model reading untrusted text unattended and writing
  // its reading somewhere that outlives the conversation.
  return { outcome: 'answered' };
}
