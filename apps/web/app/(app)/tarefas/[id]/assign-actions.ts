'use server';

import { revalidatePath } from 'next/cache';
import { requireAuth } from '@capo/db/session';
import { assertNotBlocked } from '@/lib/billing';
import { logEvent } from '@/lib/log';
import { isUuid } from '@/app/(app)/tarefas/filters';

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
