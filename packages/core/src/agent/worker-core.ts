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
import { loadInboxPhotos } from '../media/photo-inbox';
import { loadWorkerTasks } from '../capabilities/worker/tasks';
import { withToolCacheBreakpoint } from './cache';
import { buildWorkerSystemPrompt, loadWorkerIdentity } from './worker-context';
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
//   - a roster of five tools in their own type system, so a manager capability
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

/**
 * What a voice note we could not hear says, in the thread.
 *
 * OUR OWN copy, exactly like PHOTO_ONLY_TEXT above and for the same reason: the
 * crew member said something, so an empty row would be a lie and no row at all
 * would be a hole in the thread where a message plainly arrived.
 *
 * It is also what makes a failed transcription CONSUME a unit of the daily
 * budget. `readWorkerBudget` counts `role='user'` rows, so a failure that wrote
 * nothing would be free, for ever, on the one path where somebody hostile
 * chooses both the payload and how often it arrives. One unit is the honest
 * price: the Gemini call was made and paid for.
 */
const UNINTELLIGIBLE_AUDIO_TEXT = '(voice note, could not be heard)';

/**
 * What the "that is everything" tap says.
 *
 * A crew member who sends photos one at a time is asked, after each one,
 * whether more are coming (the deterministic branch in the WhatsApp route). The
 * tap that ends the batch carries no words at all, so the turn needs a sentence
 * to be about. Written by us, in English, exactly like PHOTO_ONLY_TEXT above,
 * and stored verbatim so a manager scrolling the thread later reads something
 * true: photos arrived, nothing was said.
 *
 * It is deliberately a plain statement of fact rather than an instruction. The
 * model still has to work out which task they mean, and ask if it cannot.
 */
export function allPhotosSentText(count: number): string {
  return `(${count} photo(s) sent, that is all of them)`;
}

export interface HandleWorkerInboundOptions {
  /** ALWAYS the service role. There is no session on this path. */
  db: Db;
  /** Both resolved from the crew row matched by phone/BSUID — never from input. */
  companyId: string;
  workerId: string;
  /** workers.language ?? companies.language, resolved by the caller. */
  locale: Locale;
  inbound: {
    channel: string;
    /** The typed text. Empty when `transcribe` below is what produces it. */
    text: string;
    transcribed?: boolean;
    /**
     * Produces the inbound text from something that COSTS MONEY to read - today
     * a WhatsApp voice note, downloaded and sent to Gemini.
     *
     * ── WHY THIS IS A CALLBACK AND NOT A STRING ───────────────────────────
     * Because the budget lives in here. The caller cannot know whether this
     * crew member has any allowance left without doing the two counted queries
     * below, so a caller that transcribed first and passed the text would spend
     * the money before anything could refuse it - and the refusal is the entire
     * point of the cap. Handing in the RECIPE instead of the RESULT lets the
     * budget read stay where it is and still gate the expensive part.
     *
     * Called exactly once, only after the budget has been found to have room,
     * and above every other read in this function.
     *
     * Returns null when nothing usable came back (a failed download, a failed
     * transcription, or a transcript that is silence). It must NOT throw: the
     * caller owns the classification and the message it sends.
     */
    transcribe?: () => Promise<string | null>;
  };
  /**
   * Meta's id (`wamid`) for the message being answered.
   *
   * REQUIRED, like `fallbackPhotos` is required on the context: the no-photo
   * waiver (0049) counts DISTINCT inbound messages, so a caller that stopped
   * passing this would make every tool call inside one turn look like a
   * separate ask. That fails closed — decidePhotoWaiver refuses to advance the
   * count on a blank id — but it fails silently, and a `tsc` error is better.
   */
  inboundMessageId: string;
  /**
   * How many photos arrived with THIS message, already staged into the inbox by
   * the caller. A count, not the photos: what the turn works with is every
   * unattached photo in `worker_photo_inbox`, loaded below, which is a superset
   * of this one and is the whole point of 0047.
   *
   * It is still needed for two things this number alone answers: whether an
   * empty message was a bare photo (PHOTO_ONLY_TEXT), and what the persisted
   * `worker_messages` row records about the message itself.
   */
  inboundPhotos: number;
  /**
   * Bytes the caller downloaded but could NOT stage (0047 unapplied, or a
   * Storage refusal). Normally empty.
   *
   * They are shown to the model alongside the staged ones and written by the
   * pre-0047 writer if a task claims them, so the window between deploying 0047
   * and applying it is not a window in which every crew photo is lost. Left
   * OPTIONAL here and required on `WorkerContext`: a caller with nothing to
   * fall back on is the normal case, while a TOOL that forgot the field would
   * drop photos silently.
   */
  fallbackPhotos?: readonly PendingPhoto[];
  sink: OutboundSink;
}

export type WorkerTurnOutcome =
  | { outcome: 'answered' }
  /** The daily cap was already spent. ZERO model calls were made. */
  | { outcome: 'budget_exhausted'; limit: 'worker' | 'company' }
  /**
   * `inbound.transcribe` produced nothing usable, so there was no message to
   * answer. The conversation agent was NOT called; the transcription was, and
   * it consumed one unit of the daily budget. The caller says so in one line.
   */
  | { outcome: 'unintelligible' };

export async function handleWorkerInbound(opts: HandleWorkerInboundOptions): Promise<WorkerTurnOutcome> {
  const { db, companyId, workerId, locale, inbound, inboundMessageId, inboundPhotos, sink } = opts;
  const fallbackPhotos = opts.fallbackPhotos ?? [];

  // One clock — the same lisbon_today() task_board reads and the same one the
  // database stamps onto worker_messages.usage_date. Reading it here rather
  // than computing a local date is what makes the budget's "today" and the
  // board's "today" the same day, including across a DST boundary.
  const { data: today, error: todayError } = await db.rpc('lisbon_today');
  if (todayError || !today) throw new Error(`worker turn: lisbon_today failed: ${todayError?.message ?? 'no value'}`);

  const conversationId = await ensureWorkerConversation(db, companyId, workerId);

  // ── the budget, BEFORE anything expensive ────────────────────────────────
  // Above the check-in lookup, above the TRANSCRIPTION of a voice note, above
  // the task read, above the prompt build, and far above the model. An
  // exhausted worker costs two counted queries and nothing else, which is the
  // point: a cap that spent money to enforce itself would be a cost amplifier
  // rather than a limiter.
  //
  // The transcription is in that list because of W4 and it is the reason
  // `inbound.transcribe` is a callback rather than a string. Transcribing in
  // the caller and passing the text would have spent a Gemini call per voice
  // note for a crew member with no allowance left, for ever, with this line
  // still claiming otherwise.
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
  const target: WorkerMessageTarget = { conversationId, companyId, checkinId, channel: inbound.channel };

  // ── the expensive read of the inbound message itself ──────────────────────
  // A voice note: downloaded from Meta and sent to Gemini. It happens HERE and
  // nowhere else, which is the fix for the obvious version of this feature.
  //
  // BELOW the budget read above, so an exhausted crew member costs two counted
  // queries and a conversation upsert, exactly as the comment there has always
  // promised. ABOVE the task and identity reads below, so a voice note that
  // turns out to be silence does not pay for those either.
  //
  // A failure is a normal outcome, not an error: it writes the marker line
  // (which consumes a unit of the budget - see UNINTELLIGIBLE_AUDIO_TEXT) and
  // returns without ever constructing the agent.
  let spoken: string | null = null;
  if (inbound.transcribe) {
    spoken = await inbound.transcribe();
    if (spoken === null) {
      await persistWorkerUserMessage(db, target, UNINTELLIGIBLE_AUDIO_TEXT, 0);
      return { outcome: 'unintelligible' };
    }
  }

  // Computed BEFORE the model runs, and never widened by anything it or the
  // worker says. This list is `declare_task_done`'s entire notion of what
  // exists, which is why a valid uuid belonging to a colleague in the same
  // company is refused without a database round trip.
  //
  // Who this crew member is (the prompt's identity block) is loaded ALONGSIDE
  // it rather than after: the two reads are independent, and this is already
  // the slowest path in the product. It resolves to null on any failure, and a
  // null simply drops the block.
  const [tasks, identity] = await Promise.all([
    loadWorkerTasks(db, companyId, workerId),
    loadWorkerIdentity(db, { workerId, companyId }),
  ]);
  const scope = { taskIds: tasks.map(t => t.id) as readonly string[] };

  // Every photo this person has sent that no task has claimed yet, read fresh
  // from the inbox (0047). NOT this message's photos: that was the old shape,
  // and it is why a photo sent on its own and explained a minute later was
  // already gone. Ids and times only; the bytes are never loaded and never
  // shown to a model.
  const staged = await loadInboxPhotos(db, companyId, workerId, Date.now());
  // Unstaged bytes join the SAME list, at the end, so the model sees one set of
  // photos and cannot tell which mechanism is holding them. They carry this
  // turn's clock as their arrival time, which is true: they arrived with this
  // message and they do not outlive it.
  const pendingPhotos = [
    ...staged,
    ...fallbackPhotos.map(p => ({ id: p.id, receivedAt: new Date().toISOString() })),
  ];

  // The spoken transcript when this was a voice note (W4), the typed text
  // otherwise. Either way it is the message this turn is about.
  const text = (spoken ?? inbound.text).trim();
  const body = (text || (inboundPhotos > 0 ? PHOTO_ONLY_TEXT : '')).slice(0, MAX_INBOUND_CHARS);

  await persistWorkerUserMessage(db, target, body, inboundPhotos);
  const uiMessages = await loadWorkerWindow(db, conversationId, checkinId);

  const ctx: WorkerContext = {
    db,
    companyId,
    workerId,
    conversationId,
    inboundMessageId,
    locale,
    scope,
    checkinId,
    pendingPhotos,
    unstagedPhotos: fallbackPhotos,
    budget: budget.remaining,
  };

  // Prompt caching (issue #58), the worker's own two breakpoints — its own
  // roster and its own stable prompt half, never the manager's. Both loops
  // reach ../agent/cache.ts, which is provider plumbing in the same sense
  // ./models.ts is: it speaks only `string` and the AI SDK's `ToolSet`, so no
  // Capo tool type or context can travel through it.
  const agent = new ToolLoopAgent({
    // Usage accounting (issue #53), attributed to THIS crew member. The
    // attribution type is a union, so `{ kind: 'worker', workerId }` has no
    // profileId field to fill in — the worker loop cannot file its spend
    // against a manager even by mistake, the same way WorkerContext has no
    // userId. ./usage.ts may serve both loops for the reason ./models.ts and
    // ./cache.ts may: it is plumbing, and speaks only Db, strings and numbers.
    model: getModel('conversation', {
      db,
      companyId,
      surface: 'worker_chat',
      actor: { kind: 'worker', workerId },
    }),
    instructions: await buildWorkerSystemPrompt({ db, locale, today, tasks, pendingPhotos, identity }),
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
