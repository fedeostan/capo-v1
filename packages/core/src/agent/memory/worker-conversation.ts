import type { UIMessage } from 'ai';
import type { Db } from '@capo/db/client';
import type { Json } from '@capo/db/types';

// The worker thread: a SECOND, physically separate conversation store.
//
// Everything in this file is a deliberate near-duplicate of ./conversation.ts,
// and the duplication is the feature. The one-line alternative — a nullable
// `worker_id` on `messages` — puts worker-authored text on the path
//
//   loadWindow → toThread → thread.recentUserTexts → ToolContext →
//   runGuarded(), which authorizes a DIRECT manager-level write
//
// and hands a crew phone the ability to write the evidence that authorizes the
// manager's own agent. Not to argue for it: to WRITE it. Separate tables mean
// there is no filter to forget, because there is no query to filter.
//
// Two further absences, both on purpose:
//   - NO summarizer. A worker thread is episodic — one check-in in the evening,
//     a question about curing time — so it never grows to need one. A
//     summarizer would also be a model reading untrusted text unattended, and
//     writing its reading somewhere that outlives the conversation.
//   - NO role='event'. There are no approval cards on this path, which is the
//     only thing that role exists for.

const CONTENT_FORMAT = 'ui-message@7';

/**
 * Find-or-create this worker's thread.
 *
 * `worker_conversations.worker_id` is `unique` (0027), so the insert below is
 * the race-loser's problem rather than ours: a concurrent creation trips 23505
 * and the retry read finds the winner's row. Two rapid-fire WhatsApp messages
 * from the same phone are exactly the case, and they arrive on separate
 * invocations that cannot see each other.
 */
export async function ensureWorkerConversation(db: Db, companyId: string, workerId: string): Promise<string> {
  const existing = await db
    .from('worker_conversations')
    .select('id')
    .eq('company_id', companyId)
    .eq('worker_id', workerId)
    .maybeSingle();
  if (existing.data) return existing.data.id;

  const { data, error } = await db
    .from('worker_conversations')
    .insert({ company_id: companyId, worker_id: workerId })
    .select('id')
    .single();
  if (data) return data.id;

  // Lost the race (or something worse). One re-read tells the two apart: a
  // unique violation resolves, anything else genuinely failed.
  const retry = await db
    .from('worker_conversations')
    .select('id')
    .eq('company_id', companyId)
    .eq('worker_id', workerId)
    .maybeSingle();
  if (retry.data) return retry.data.id;
  throw new Error(`Failed to create worker conversation: ${error?.message ?? 'unknown'}`);
}

export interface WorkerMessageTarget {
  conversationId: string;
  companyId: string;
  /** Which evening's ask this belongs to; null for an unprompted message. */
  checkinId: string | null;
  channel: string;
}

/**
 * The worker's own words, stored verbatim.
 *
 * `photoCount` is the ONLY thing recorded about any images: how many arrived.
 * Nothing derived from their contents is written here or anywhere else, because
 * nothing ever looks at them but a person (0023).
 */
export async function persistWorkerUserMessage(
  db: Db,
  target: WorkerMessageTarget,
  text: string,
  photoCount: number,
): Promise<void> {
  const { error } = await db.from('worker_messages').insert({
    conversation_id: target.conversationId,
    company_id: target.companyId,
    checkin_id: target.checkinId,
    role: 'user',
    channel: target.channel,
    content: { parts: [{ type: 'text', text }] },
    content_format: CONTENT_FORMAT,
    photo_count: photoCount,
  });
  if (error) throw new Error(`Failed to persist worker message: ${error.message}`);
}

export async function persistWorkerAssistantMessage(
  db: Db,
  target: WorkerMessageTarget,
  message: UIMessage,
): Promise<void> {
  const { error } = await db.from('worker_messages').insert({
    conversation_id: target.conversationId,
    company_id: target.companyId,
    checkin_id: target.checkinId,
    role: 'assistant',
    channel: target.channel,
    content: { parts: message.parts } as unknown as Json,
    content_format: CONTENT_FORMAT,
  });
  if (error) throw new Error(`Failed to persist worker reply: ${error.message}`);

  // Best-effort ordering key for the manager's future thread list. A failure
  // here must not cost the worker their reply, which has already been sent.
  await db
    .from('worker_conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', target.conversationId);
}

/** How far back an unprompted conversation reaches. */
const UNPROMPTED_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Hard ceiling on rows loaded into a worker turn — small by design. */
const MAX_WORKER_WINDOW = 40;

/**
 * The episode, not the history.
 *
 * Bound to a check-in when there is one, and to the last 24 hours when there is
 * not. Either way the window is short and bounded, which is what makes the
 * absent summarizer safe rather than merely convenient: there is no growth
 * curve here that eventually needs compressing.
 *
 * Rows are mapped straight to UIMessages with no `<system-event>` translation,
 * because this thread has no events in it.
 */
export async function loadWorkerWindow(
  db: Db,
  conversationId: string,
  checkinId: string | null,
): Promise<UIMessage[]> {
  let query = db
    .from('worker_messages')
    .select('id, role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(MAX_WORKER_WINDOW);

  query = checkinId
    ? query.eq('checkin_id', checkinId)
    : query.gte('created_at', new Date(Date.now() - UNPROMPTED_WINDOW_MS).toISOString());

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load worker thread: ${error.message}`);

  return (data ?? []).map(row => {
    const content = row.content as { parts?: UIMessage['parts'] } | null;
    return {
      id: row.id,
      role: row.role as 'user' | 'assistant',
      parts: content?.parts ?? [],
    };
  });
}

// ── the daily budget ────────────────────────────────────────────────────────
//
// Two caps, and they answer different questions. The per-worker cap stops one
// person using Capo as a free chatbot; the per-company cap stops a whole crew
// doing it, and stops a BLOCKED company running up inference through its crew.
// WhatsApp is deliberately ungated by billing for managers during the pilot
// (see the route), and that must stay true — but "ungated" was never meant to
// mean "unbounded through a channel the payer does not control".
//
// Counted from `worker_messages` rather than from a counter table, for the same
// reason 0026 made the notifications row its own push queue: the row IS the
// ledger, so a spend cannot exist without a message that explains it, and there
// is no second thing to keep in step. `usage_date` is stamped by the database
// from lisbon_today() — the same clock task_board reads — so a caller cannot
// understate its own spend, because it never supplies a date at all.

/** Model turns one crew member may spend in a day. */
export const WORKER_DAILY_TURNS = 20;
/** Model turns a whole company's crew may spend in a day. */
export const COMPANY_DAILY_WORKER_TURNS = 120;

export interface WorkerBudget {
  /** Turns left for this worker today; 0 means refuse. */
  remaining: number;
  /** Which ceiling was hit, for the log line. Null when there is room. */
  exhausted: 'worker' | 'company' | null;
}

/**
 * Read BEFORE the inbound message is persisted and BEFORE any model call, so a
 * refusal costs one count and nothing else. That ordering is also what keeps
 * the count pinned at the cap instead of drifting upward with every rejected
 * message — an over-budget turn writes no row, so tomorrow's arithmetic is not
 * polluted by today's refusals.
 *
 * `head: true` with `count: 'exact'`: no rows come back, only the number.
 */
export async function readWorkerBudget(
  db: Db,
  companyId: string,
  conversationId: string,
  today: string,
): Promise<WorkerBudget> {
  const [mine, company] = await Promise.all([
    db
      .from('worker_messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .eq('usage_date', today)
      .eq('role', 'user'),
    db
      .from('worker_messages')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('usage_date', today)
      .eq('role', 'user'),
  ]);

  // FAIL CLOSED on an unreadable count. A budget that cannot be read is not a
  // budget of zero spend — it is no budget at all, and this is the one path in
  // the codebase where an attacker chooses how often it runs. The realistic
  // cause is a deploy landing before 0027, where the table does not exist yet;
  // silence there is exactly right.
  if (mine.error || company.error) return { remaining: 0, exhausted: 'company' };

  const mineUsed = mine.count ?? 0;
  const companyUsed = company.count ?? 0;
  if (companyUsed >= COMPANY_DAILY_WORKER_TURNS) return { remaining: 0, exhausted: 'company' };
  if (mineUsed >= WORKER_DAILY_TURNS) return { remaining: 0, exhausted: 'worker' };
  return {
    remaining: Math.min(WORKER_DAILY_TURNS - mineUsed, COMPANY_DAILY_WORKER_TURNS - companyUsed),
    exhausted: null,
  };
}
