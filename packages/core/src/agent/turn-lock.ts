import type { Db } from '@capo/db/client';

// ── Turn serialization (issue #125) ─────────────────────────────────────────
//
// Two messages seconds apart are two serverless invocations racing through
// handleInbound: the second loads the thread while the first turn is
// mid-flight and answers without seeing that turn's answer or tool results —
// which is how three crew members got proposed twice (#124) and one obra got
// planned twice. A debounce was rejected by the product owner: no fixed delay
// on the lone uncontended message that is the common case.
//
// The lock lives in Postgres (0040) because a warm serverless instance shares
// no memory with the invocation racing it. These wrappers are the only
// callers of the three RPCs, and every one of them DEGRADES instead of
// throwing: a deploy landing before 0040 answers PGRST202/42883, and the
// product that must survive that is yesterday's — an unlocked turn, never a
// dead chat. Same posture as readCompanySchedules (0036).
//
// This file is provider-free plumbing in the models.ts/cache.ts sense: its
// whole vocabulary is Db, strings and numbers. It knows nothing about tools,
// contexts or rosters, which is why it may sit beside both agents.

/**
 * Lease length. A dead turn stops renewing and the lock self-clears within
 * this window — a conversation must never jam shut (#126 held a turn open for
 * 75 minutes; the lease bounds that failure at two minutes). Renewed between
 * model steps, so a healthy turn outlives it indefinitely. Clamped in SQL to
 * 10..600 so no caller mistake can turn the bound into a jam.
 */
export const TURN_LOCK_TTL_SECONDS = 120;

/**
 * Agent iterations one invocation may run, the first turn included. The merge
 * loop answers queued messages by running again, and each iteration is up to
 * twelve model requests — unbounded, a chatty burst could outrun the route's
 * own execution ceiling mid-model-call. Past the cap the lock is
 * force-released and the next inbound message picks the thread up.
 */
export const TURN_MERGE_CAP = 3;

export type TurnClaim = 'claimed' | 'queued' | 'unavailable';
export type TurnFinish = 'released' | 'continue' | 'lost' | 'unavailable';

export interface TurnRef {
  conversationId: string;
  companyId: string;
  /** Fresh random uuid per invocation; the row's bearer credential. */
  token: string;
}

// PGRST202 is PostgREST failing to find the function in its schema cache;
// 42883 is Postgres itself saying "function does not exist". Both mean one
// thing here — 0040 is not applied yet — and both are survivable by design.
const MISSING_RPC = new Set(['PGRST202', '42883']);

// Same JSON-line shape as apps/web's logEvent, so the Vercel log drain greps
// these beside the route's own events. Local because @capo/core must not
// import from an app.
function logTurnEvent(evt: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ evt, ts: new Date().toISOString(), ...fields }));
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
}

/**
 * Try to take the turn lock. 'queued' means another turn is running and its
 * holder will answer this message as part of a merged turn — the caller must
 * simply return. 'unavailable' means the lock itself could not be consulted
 * (0040 unapplied, or any other claim failure) — the caller runs unlocked,
 * which is the pre-0040 product.
 */
export async function claimConversationTurn(db: Db, ref: TurnRef): Promise<TurnClaim> {
  try {
    const { data, error } = await db.rpc('claim_conversation_turn', {
      p_conversation: ref.conversationId,
      p_token: ref.token,
      p_ttl_seconds: TURN_LOCK_TTL_SECONDS,
    });
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    if (data === 'claimed' || data === 'queued') return data;
    throw new Error(`unexpected claim outcome: ${String(data)}`);
  } catch (err) {
    logTurnEvent('agent.turn_lock_unavailable', {
      conversationId: ref.conversationId,
      companyId: ref.companyId,
      missingMigration: MISSING_RPC.has(errorCode(err) ?? ''),
      error: err instanceof Error ? err.message : String(err),
    });
    return 'unavailable';
  }
}

/**
 * Report the turn done. 'continue' = messages queued while it ran; the lease
 * was renewed and the caller answers them as another iteration of the same
 * merged turn. 'lost' = the lease expired and somebody else owns the lock;
 * stop, touch nothing. `force` clears the lock unconditionally (token
 * permitting) and never reports 'continue' — the error path and the merge
 * cap, where the conversation must be left immediately free.
 *
 * 'unavailable' (the RPC itself failed) is deliberately not retried: the
 * lease lapses on its own within the TTL, which beats wedging a delivered
 * turn on its bookkeeping.
 */
export async function finishConversationTurn(
  db: Db,
  ref: TurnRef,
  opts?: { force?: boolean },
): Promise<TurnFinish> {
  try {
    const { data, error } = await db.rpc('finish_conversation_turn', {
      p_conversation: ref.conversationId,
      p_token: ref.token,
      p_force: opts?.force ?? false,
    });
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    if (data === 'released' || data === 'continue' || data === 'lost') return data;
    throw new Error(`unexpected finish outcome: ${String(data)}`);
  } catch (err) {
    logTurnEvent('agent.turn_finish_failed', {
      conversationId: ref.conversationId,
      companyId: ref.companyId,
      force: opts?.force ?? false,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'unavailable';
  }
}

/**
 * Heartbeat, fired between model steps. Never throws and is never awaited on
 * the hot path — a failed renewal costs at most a lease that lapses early,
 * which the next finish reports as 'lost'.
 */
export async function renewConversationTurn(db: Db, ref: TurnRef): Promise<void> {
  try {
    const { error } = await db.rpc('renew_conversation_turn', {
      p_conversation: ref.conversationId,
      p_token: ref.token,
      p_ttl_seconds: TURN_LOCK_TTL_SECONDS,
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    logTurnEvent('agent.turn_renew_failed', {
      conversationId: ref.conversationId,
      companyId: ref.companyId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export { logTurnEvent };
