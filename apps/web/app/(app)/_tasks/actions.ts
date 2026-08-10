'use server';

import { revalidatePath } from 'next/cache';
import { requireAuth, type AuthContext } from '@capo/db/session';
import { getCatalog } from '@capo/i18n/catalog';
import { ensureConversation } from '@capo/core/conversation';
import { proposeReschedule } from '@capo/core/capabilities/reschedule-propose';
import { assertNotBlocked } from '@/lib/billing';
import { logEvent } from '@/lib/log';
import { TaskPhotoError, uploadTaskPhotos } from '@/lib/task-photos';
import { isUuid } from '@/app/(app)/tarefas/filters';

// Shared by /tarefas and /obras/[id] — hence the private `_tasks` folder
// (the underscore keeps App Router from treating it as a route) rather than
// one page reaching into the other's directory.
//
// A manager tapping "Concluir"/"Reabrir" IS an explicit manager command — a
// sanctioned non-chat write path (every other domain write only happens
// through Capo). Direct status update on the RLS-scoped client; company_id
// filter is belt-and-braces on top of RLS. Photos do not change that: the
// completion sheet is still the manager acting directly, so it must NOT be
// routed through a proposal.
//
// `completionProof` is written in the same UPDATE as the status, so a task can
// never be done-with-no-record-of-how. It is cleared on reopen: a task that is
// open again has no completion to describe, and a stale 'skipped' would keep
// counting against a manager who has since gone back to the job.
//
// Takes `ctx` rather than calling requireAuth() itself (which is how the
// cascade branch wrote it) because the photo path needs an authenticated
// context BEFORE this runs — the upload happens first, and resolving the
// session twice would be two round trips for one request. It returns the job
// id for the same reason that branch did: the cascade needs it, and re-reading
// the row to find it would be a second query for something this UPDATE already
// returned.
async function setTaskStatus(
  ctx: AuthContext,
  taskId: string,
  status: 'done' | 'pending',
  event: string,
  completionProof: 'photos' | 'skipped' | null,
  fields: Record<string, unknown> = {},
): Promise<string | null> {
  const { db, companyId } = ctx;
  const { data, error } = await db
    .from('tasks')
    .update({ status, completion_proof: completionProof, updated_at: new Date().toISOString() })
    .eq('id', taskId)
    .eq('company_id', companyId)
    .select('job_id')
    .single();
  if (error) throw new Error(`${event} failed: ${error.message}`);

  logEvent(event, { companyId, taskId, proof: completionProof, ...fields });

  revalidateTask(taskId, data.job_id);
  return data.job_id;
}

// ── completing a task ──────────────────────────────────────────────────────
// Two entry points rather than one with a flag, because they are two buttons
// the manager can tell apart and the record they leave behind must be equally
// unambiguous. Neither infers the other: a batch that happens to arrive empty
// is an error, not a silent "skipped".
//
// BOTH of them fire cascadeReschedule. That is the whole of what this merge
// had to get right: the cascade landed on main attached to a single
// `completeTask`, which the photo sheet then split in two. Taking either side
// of the conflict wholesale would have deleted a shipped feature in silence —
// keep mine and the cascade never fires again; keep theirs and there is no
// photo sheet. Nothing would have failed to compile either way. Any future
// third way of finishing a task has to be added here too.

/**
 * "Concluir com fotos". The FormData shape (rather than a plain argument) is
 * forced by the payload — File objects only cross to a Server Action inside
 * FormData. `taskId` rides along in the same form; it is a reference the
 * session is then checked against, never a claim of ownership (RLS plus the
 * explicit company_id filter decide that).
 *
 * Photos are uploaded and recorded BEFORE the task is marked done, so a
 * failure anywhere in the upload leaves the task open with a visible error
 * instead of closed with a proof set that never arrived.
 */
export async function completeTaskWithPhotos(formData: FormData): Promise<void> {
  const ctx = await requireAuth();
  await assertNotBlocked(ctx);

  const taskId = String(formData.get('taskId') ?? '');
  if (!isUuid(taskId)) throw new Error('dashboard.task_completed failed: bad task id');

  // Chrome submits an empty File for an untouched file input; drop those
  // before counting, or "no photos chosen" arrives here as one zero-byte file.
  const files = formData.getAll('photos').filter((f): f is File => f instanceof File && f.size > 0);
  const t = getCatalog(ctx.locale).screens.taskPhotos;
  if (files.length === 0) throw new Error(t.errors.empty);

  let uploaded: number;
  try {
    uploaded = await uploadTaskPhotos(ctx, taskId, files);
  } catch (e) {
    // Translate the machine-readable reason into the manager's own language.
    // The client component renders whatever message it catches verbatim, so an
    // untranslated 'upload_failed: 413' would reach a manager who reads none
    // of those words.
    if (e instanceof TaskPhotoError) {
      logEvent('dashboard.task_photos_rejected', {
        companyId: ctx.companyId,
        taskId,
        reason: e.reason,
        detail: e.message,
      });
      throw new Error(t.errors[e.reason]);
    }
    throw e;
  }

  const jobId = await setTaskStatus(ctx, taskId, 'done', 'dashboard.task_completed', 'photos', {
    photos: uploaded,
  });
  await cascadeReschedule(ctx, taskId, jobId);
}

/**
 * "Concluir sem fotos" — the escape hatch. It never blocks and never nags; it
 * only records that proof was declined, which is the whole reason the extra
 * tap was worth adding.
 *
 * Declining proof changes nothing about the schedule: the task IS finished
 * either way, so it cascades exactly like the photo path.
 */
export async function completeTaskWithoutPhotos(taskId: string): Promise<void> {
  const ctx = await requireAuth();
  await assertNotBlocked(ctx);
  const jobId = await setTaskStatus(ctx, taskId, 'done', 'dashboard.task_completed', 'skipped');
  await cascadeReschedule(ctx, taskId, jobId);
}

export async function reopenTask(taskId: string): Promise<void> {
  const ctx = await requireAuth();
  await assertNotBlocked(ctx);
  // No cascade on reopening: nothing finished, so there is no new finish date
  // for anything downstream to be scheduled against.
  await setTaskStatus(ctx, taskId, 'pending', 'dashboard.task_reopened', null);
}

// ── the cascade ────────────────────────────────────────────────────────────
// A task finishing is the only moment the rest of a job's dependency graph has
// a reason to move. Dates are never moved here — this only ever produces ONE
// approval card, which lands in the chat thread for the manager to accept or
// throw away.
//
// Fired on every moment a task becomes finished-or-claimed-finished. That was
// two when this was written and is THREE now that the completion sheet split
// completeTask in half: completeTaskWithPhotos, completeTaskWithoutPhotos, and
// requestReview (which puts the task in pending_review). NOT on
// approveReview/dismissReview: those resolve a claim that already fired a
// cascade at the moment it was made, and a second identical card would just
// train the manager to ignore them.
//
// Everything in here is best-effort. A cascade that fails must never take the
// completion down with it — the manager tapped "Concluir", and that is the
// write they asked for.
async function cascadeReschedule(ctx: AuthContext, taskId: string, jobId: string | null): Promise<void> {
  if (!jobId) return;
  const { db, companyId } = ctx;
  try {
    // One clock. Never new Date(): the server is not in Lisbon.
    const { data: today } = await db.rpc('lisbon_today');
    if (!today) return;

    const outcome = await proposeReschedule(db, {
      companyId,
      jobId,
      taskId,
      completedOn: today,
      // Find-or-create, and only once there is actually a card to place: this
      // path has no thread of its own, and a card with no conversation is
      // still resolvable but the chat page never surfaces it.
      resolveConversationId: () => ensureConversation(db, companyId),
      locale: ctx.locale,
    });

    if (outcome.status === 'proposed') {
      logEvent('dashboard.reschedule_proposed', { companyId, taskId, jobId, proposalId: outcome.proposalId });
      // The card renders on the chat page as a pending proposal.
      revalidatePath('/');
    } else {
      // Logged rather than swallowed: "no card appeared" is otherwise an
      // unfalsifiable bug report. The dominant reason is no_dependents — a job
      // whose tasks were created one at a time has no edges to cascade along.
      logEvent('dashboard.reschedule_skipped', { companyId, taskId, jobId, reason: outcome.reason });
    }
  } catch (e) {
    logEvent('dashboard.reschedule_failed', {
      companyId,
      taskId,
      jobId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ── the review control ─────────────────────────────────────────────────────
// Both RPCs move a review AND its task in one transaction. Doing it as two
// updates from here would let a crash or a lost round-trip leave the review
// approved with the task still open — the exact half-applied state the
// feature exists to prevent. See 0018_task_reviews.sql.
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

  // The task is now pending_review: declared finished, not yet checked. That
  // is enough for the cascade to fire — and the card says out loud that it is
  // running on an unverified claim, which is exactly why it is a card.
  const { data: task } = await db.from('tasks').select('job_id').eq('id', taskId).eq('company_id', companyId).maybeSingle();
  await cascadeReschedule(ctx, taskId, task?.job_id ?? null);
}
