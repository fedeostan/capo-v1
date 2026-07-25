'use server';

import { revalidatePath } from 'next/cache';
import { requireAuth } from '@capo/db/session';
import { assertNotBlocked } from '@/lib/billing';
import { logEvent } from '@/lib/log';

// A manager tapping "Concluir"/"Reabrir" IS an explicit manager command — a
// sanctioned non-chat write path (every other domain write only happens
// through Capo). Direct status update on the RLS-scoped client; the
// company_id filter is belt-and-braces on top of RLS.
//
// Lives at the (app) root rather than under obras/[id] because every task list
// offers the same toggle: closing out a task from Hoje is the single most
// frequent thing a manager does, and making them navigate into the obra to do
// it was the difference between "used daily" and "used when I remember".
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

  if (data.job_id) revalidatePath(`/obras/${data.job_id}`);
  // Completing a task removes it from dashboard_tasks entirely, so it also
  // drops out of the materials outlook and the team load — revalidate both.
  for (const path of ['/hoje', '/amanha', '/atrasadas', '/obras', '/materiais', '/equipa']) {
    revalidatePath(path);
  }
}

export async function completeTask(taskId: string): Promise<void> {
  await setTaskStatus(taskId, 'done', 'dashboard.task_completed');
}

export async function reopenTask(taskId: string): Promise<void> {
  await setTaskStatus(taskId, 'pending', 'dashboard.task_reopened');
}
