'use server';

import { revalidatePath } from 'next/cache';
import { requireAuth } from '@capo/db/session';
import { logEvent } from '@/lib/log';

// A manager tapping "Concluir"/"Reabrir" on the obra detail page IS an
// explicit manager command — a sanctioned non-chat write path (every other
// domain write only happens through Capo). Direct status update on the
// RLS-scoped client; company_id filter is belt-and-braces on top of RLS.
async function setTaskStatus(taskId: string, status: 'done' | 'pending', event: string): Promise<void> {
  const { db, companyId } = await requireAuth();
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
  revalidatePath('/hoje');
  revalidatePath('/amanha');
  revalidatePath('/atrasadas');
  revalidatePath('/obras');
}

export async function completeTask(taskId: string): Promise<void> {
  await setTaskStatus(taskId, 'done', 'dashboard.task_completed');
}

export async function reopenTask(taskId: string): Promise<void> {
  await setTaskStatus(taskId, 'pending', 'dashboard.task_reopened');
}
