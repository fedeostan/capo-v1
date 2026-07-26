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

  // /tarefas covers every date/risk filter now, so this list shrank from five
  // paths to three: /hoje, /amanha and /atrasadas are next.config redirects,
  // not routes, and there is nothing there to revalidate.
  if (data.job_id) revalidatePath(`/obras/${data.job_id}`);
  revalidatePath('/tarefas');
  revalidatePath('/obras');
  // Completing a task drops it out of task_board entirely, so it also leaves
  // the materials outlook and the crew's load on /perfil.
  revalidatePath('/materiais');
  revalidatePath('/perfil');
}

export async function completeTask(taskId: string): Promise<void> {
  await setTaskStatus(taskId, 'done', 'dashboard.task_completed');
}

export async function reopenTask(taskId: string): Promise<void> {
  await setTaskStatus(taskId, 'pending', 'dashboard.task_reopened');
}
