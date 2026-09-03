'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { requireAuth } from '@capo/db/session';
import { assertNotBlocked } from '@/lib/billing';
import { logEvent } from '@/lib/log';
import { isUuid } from '@/app/(app)/tarefas/filters';
import { drainAssignmentNotices } from '@/app/notifications/task-assigned';

// Changing who does a task, straight from the task detail screen.
//
// Its own file rather than another export in _tasks/actions.ts because this is
// the only mutation that belongs to /tarefas/[id] alone — the board rows have
// no room for a picker and do not offer one.
//
// A manager tapping a name IS an explicit manager command, the same sanctioned
// non-chat write path as "Concluir"/"Reabrir": a direct UPDATE on the
// RLS-scoped client, never a proposal. Two things make the write safe without
// any app-level ownership check:
//   * RLS (tasks_update_company, 0007) scopes the row to the caller's company;
//     the explicit company_id filter here is belt-and-braces on top of it.
//   * tasks_company_guard (0009) rejects an assignee_worker_id belonging to
//     another company at the database, before the row is written — so a forged
//     worker id in the form payload cannot cross a tenant boundary even if
//     every line of this file were wrong.

/**
 * Assign the task to `workerId`, or clear the assignee when it is null.
 *
 * Returns nothing: the screen re-renders from the revalidated server tree, so
 * the name the manager sees afterwards is what the database actually holds,
 * not what this function believed it wrote.
 */
export async function assignTask(taskId: string, workerId: string | null): Promise<void> {
  const ctx = await requireAuth();
  await assertNotBlocked(ctx);

  if (!isUuid(taskId)) throw new Error('dashboard.task_assigned failed: bad task id');
  if (workerId !== null && !isUuid(workerId)) {
    throw new Error('dashboard.task_assigned failed: bad worker id');
  }

  const { db, companyId } = ctx;
  const { data, error } = await db
    .from('tasks')
    .update({ assignee_worker_id: workerId, updated_at: new Date().toISOString() })
    .eq('id', taskId)
    .eq('company_id', companyId)
    .select('job_id')
    .single();
  if (error) throw new Error(`dashboard.task_assigned failed: ${error.message}`);

  logEvent('dashboard.task_assigned', { companyId, taskId, workerId });

  // ── the crew hears about a new task now, not tomorrow at 07:00 (W7) ───────
  // The database trigger has already queued the notice; this only drains it,
  // after the response is on its way. One line, and it never throws — telling
  // the crew member must never cost the manager their tap.
  after(() => drainAssignmentNotices({ companyId }));

  // Reassignment changes who the 07:00 briefing names, the crew load on
  // /perfil, and the assignee shown on every board row for this task — the
  // same surfaces a status change touches, minus /materiais (the materials
  // outlook does not depend on who does the work).
  revalidatePath(`/tarefas/${taskId}`);
  revalidatePath('/tarefas');
  if (data.job_id) revalidatePath(`/obras/${data.job_id}`);
  revalidatePath('/obras');
  revalidatePath('/perfil');
}

/**
 * Set who ELSE is on this task, besides the assignee (issue #44).
 *
 * ── why one call with the whole list, and not add/remove ────────────────────
 * "Who is on this task" is a SET. An add-one/remove-one API turns editing it
 * into several round trips with no transaction around them, and a half-applied
 * crew — the new helper saved, the old one not removed — is a wrong WhatsApp
 * message to a real person at 07:00 the next morning. `set_task_collaborators`
 * (0035) replaces the set in one statement.
 *
 * ── the boundary ────────────────────────────────────────────────────────────
 * The RPC is SECURITY DEFINER, so RLS does NOT apply to it and its internal
 * `auth.uid()` check is the entire tenant boundary — the same shape as
 * `resolve_task_review` and `revert_translation_batch`, and attacked directly
 * by scripts/rls-isolation-matrix.mjs for that reason. Two things back it up at
 * the database rather than here: the RPC re-reads the task's own company, and
 * task_assignees' cross-company FK guard rejects a worker id from another
 * tenant before the row is written. So a forged uuid in the form payload
 * changes nothing even if every line of this file were wrong.
 *
 * The LEAD is never passed here. `tasks.assignee_worker_id` stays the only way
 * to change who is in charge, and the RPC silently drops the lead if they are
 * named — a manager listing everybody on the job is being sensible, not wrong.
 */
export async function setCollaborators(taskId: string, workerIds: string[]): Promise<void> {
  const ctx = await requireAuth();
  await assertNotBlocked(ctx);

  if (!isUuid(taskId)) throw new Error('dashboard.task_collaborators failed: bad task id');
  // Validated BEFORE the round trip, so a malformed id is a clear error rather
  // than a Postgres cast failure the manager cannot read. Deduped for the same
  // reason the RPC dedupes: the sheet is a toggle list and a double tap must
  // not produce two of the same person.
  const wanted = [...new Set(workerIds)];
  if (wanted.some(id => !isUuid(id))) {
    throw new Error('dashboard.task_collaborators failed: bad worker id');
  }

  const { db, companyId } = ctx;
  const { error } = await db.rpc('set_task_collaborators', { p_task: taskId, p_workers: wanted });
  if (error) throw new Error(`dashboard.task_collaborators failed: ${error.message}`);

  logEvent('dashboard.task_collaborators', { companyId, taskId, count: wanted.length });

  // ── the crew hears about a new task now, not tomorrow at 07:00 (W7) ───────
  // The database trigger has already queued the notice; this only drains it,
  // after the response is on its way. One line, and it never throws — telling
  // the crew member must never cost the manager their tap.
  after(() => drainAssignmentNotices({ companyId }));

  // The same surfaces a reassignment touches, and for the same reasons: who is
  // briefed at 07:00, the crew load on /perfil, and this task's own screen.
  // /materiais is again untouched — and that is the point of the whole issue.
  // Putting a second person on a task does not change one gram of what has to
  // be bought, because the materials belong to the task.
  revalidatePath(`/tarefas/${taskId}`);
  revalidatePath('/tarefas');
  revalidatePath('/perfil');
}
