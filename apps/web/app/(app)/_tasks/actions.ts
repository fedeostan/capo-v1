'use server';

import { revalidatePath } from 'next/cache';
import { requireAuth } from '@capo/db/session';
import { assertNotBlocked } from '@/lib/billing';
import { logEvent } from '@/lib/log';

// Shared by /tarefas and /obras/[id] — hence the private `_tasks` folder
// (the underscore keeps App Router from treating it as a route) rather than
// one page reaching into the other's directory.
//
// A manager tapping "Concluir"/"Reabrir" IS an explicit manager command — a
// sanctioned non-chat write path (every other domain write only happens
// through Capo). Direct status update on the RLS-scoped client; company_id
// filter is belt-and-braces on top of RLS.
async function setTaskStatus(taskId: string, status: 'done' | 'pending', event: string): Promise<void> {
  const ctx = await requireAuth();
  await assertNotBlocked(ctx);
  const { db, companyId } = ctx;
  const { data, error } = await db
    .from('tasks')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', taskId)
    .eq('company_id', companyId)
    .select('job_id')
    .single();
  if (error) throw new Error(`${event} failed: ${error.message}`);

  logEvent(event, { companyId, taskId });

  revalidateTask(taskId, data.job_id);
}

export async function completeTask(taskId: string): Promise<void> {
  await setTaskStatus(taskId, 'done', 'dashboard.task_completed');
}

export async function reopenTask(taskId: string): Promise<void> {
  await setTaskStatus(taskId, 'pending', 'dashboard.task_reopened');
}

// ── the review control ─────────────────────────────────────────────────────
// Both RPCs move a review AND its task in one transaction. Doing it as two
// updates from here would let a crash or a lost round-trip leave the review
// approved with the task still open — the exact half-applied state the
// feature exists to prevent. See 0017_task_reviews.sql.
//
// Shared revalidation with setTaskStatus above: a task changing status drops
// in or out of task_board, and with it the materials outlook and the crew's
// load on /perfil.
function revalidateTask(taskId: string | null, jobId: string | null): void {
  if (jobId) revalidatePath(`/obras/${jobId}`);
  if (taskId) revalidatePath(`/tarefas/${taskId}`);
  revalidatePath('/tarefas');
  revalidatePath('/obras');
  revalidatePath('/materiais');
  revalidatePath('/perfil');
}

type Resolution = 'approved' | 'rejected' | 'dismissed';

async function resolveReview(reviewId: string, resolution: Resolution, event: string): Promise<void> {
  const ctx = await requireAuth();
  await assertNotBlocked(ctx);
  const { db, companyId } = ctx;

  const { data, error } = await db.rpc('resolve_task_review', {
    p_review: reviewId,
    p_resolution: resolution,
  });
  if (error) throw new Error(`${event} failed: ${error.message}`);

  const row = data?.[0] ?? null;
  logEvent(event, { companyId, reviewId, taskId: row?.out_task_id ?? null });
  revalidateTask(row?.out_task_id ?? null, row?.out_job_id ?? null);
}

/** Someone looked and it is fine. Review → approved, task → done. */
export async function approveReview(reviewId: string): Promise<void> {
  await resolveReview(reviewId, 'approved', 'dashboard.review_approved');
}

/** Not finished after all. Review → rejected, task → in_progress. */
export async function rejectReview(reviewId: string): Promise<void> {
  await resolveReview(reviewId, 'rejected', 'dashboard.review_rejected');
}

/** "Não precisa controlo" — closes both without a site visit. */
export async function dismissReview(reviewId: string): Promise<void> {
  await resolveReview(reviewId, 'dismissed', 'dashboard.review_dismissed');
}

/**
 * The manager opening a check on their own initiative, from the task detail
 * screen. declared_by_worker_id stays null, which is what the UI keys on to
 * show "A aguardar controlo:" instead of quoting a worker.
 *
 * The same RPC PRD 4's restricted worker agent will call, with p_worker set.
 */
export async function requestReview(taskId: string): Promise<void> {
  const ctx = await requireAuth();
  await assertNotBlocked(ctx);
  const { db, companyId } = ctx;

  // p_worker/p_note are omitted, not passed as null: the generated Args type
  // has them as optional `string | undefined` (their SQL defaults are NULL),
  // and passing `null` explicitly does not satisfy that type.
  const { error } = await db.rpc('open_task_review', { p_task: taskId });
  if (error) {
    // task_reviews_one_pending_idx allows at most one pending review per
    // task. Surface that as a clear message instead of the raw 23505 the
    // RPC would otherwise raise straight through to the client component.
    if (error.code === '23505') throw new Error('a review is already pending for this task');
    throw new Error(`dashboard.review_requested failed: ${error.message}`);
  }

  logEvent('dashboard.review_requested', { companyId, taskId });
  // No job_id from this RPC — it returns the review id. The task's own path
  // and the boards are what change; /obras/[id] is refreshed by the board
  // revalidation the next time it is visited.
  revalidateTask(taskId, null);
}
