import type { Db } from '@capo/db/client';
import type { PhotoWaiverAttempt } from './photo-waiver';

// The two database calls behind the no-photo waiver (0049), kept out of
// ./photo-waiver.ts so that file stays pure and `pnpm waiver-check` can assert
// the whole rule with no credentials and no network. Same split as
// capabilities/reschedule.ts and capabilities/reschedule-load.ts.
//
// Both run on the SERVICE ROLE, like everything else on the worker path: there
// is no auth.uid() on the WhatsApp webhook, so RLS enforces nothing here and
// the `conversation_id` filter below is the boundary rather than defence in
// depth. That id is `ctx.conversationId`, resolved from the crew row matched by
// phone, and nothing the model or the worker says can move it.

/**
 * Every attempt already recorded for this conversation and this task.
 *
 * NEVER THROWS, and an empty list on any failure is the SAFE direction: "never
 * asked" makes Capo ask again, which is the product exactly as it stands today.
 * That is also what happens on every deploy that lands before 0049 is applied,
 * where this read answers 42P01.
 */
export async function loadWaiverAttempts(
  db: Db,
  conversationId: string,
  taskId: string,
): Promise<PhotoWaiverAttempt[]> {
  try {
    const { data, error } = await db
      .from('task_photo_waiver_attempts')
      .select('inbound_message_id')
      .eq('conversation_id', conversationId)
      .eq('task_id', taskId);
    if (error) return [];
    return (data ?? []).map(row => ({ inboundMessageId: row.inbound_message_id }));
  } catch {
    return [];
  }
}

export interface RecordWaiverAttemptInput {
  companyId: string;
  workerId: string;
  taskId: string;
  conversationId: string;
  attemptNo: number;
  inboundMessageId: string;
}

/**
 * Write down that we asked.
 *
 * NEVER THROWS, and the failure it most expects is a UNIQUE VIOLATION: 0049
 * carries `unique (conversation_id, task_id, attempt_no)` and
 * `unique (conversation_id, task_id, inbound_message_id)`, so a second tool
 * call in the same turn that somehow got past the in-process check is refused
 * by the database instead of quietly advancing the count. Losing the write in
 * the other direction (a genuine failure) costs an ask: the crew member is
 * asked once more, which is the safe way to be wrong.
 *
 * Deliberately no `.select()`. This is a write-only table for the reason
 * `ai_usage` is — chaining a select asks for the row back, and RETURNING needs
 * a SELECT privilege that a deny-all table does not grant to anybody but the
 * service role.
 */
export async function recordWaiverAttempt(
  db: Db,
  input: RecordWaiverAttemptInput,
): Promise<boolean> {
  try {
    const { error } = await db.from('task_photo_waiver_attempts').insert({
      company_id: input.companyId,
      worker_id: input.workerId,
      task_id: input.taskId,
      conversation_id: input.conversationId,
      attempt_no: input.attemptNo,
      inbound_message_id: input.inboundMessageId,
    });
    return !error;
  } catch {
    return false;
  }
}
