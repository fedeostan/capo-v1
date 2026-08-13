'use server';

import { revalidatePath } from 'next/cache';
import { requireAuth } from '@capo/db/session';
import { assertNotBlocked } from '@/lib/billing';
import { logEvent } from '@/lib/log';
import { isUuid } from '@/app/(app)/tarefas/filters';

// Editing what a task needs on site, from /tarefas/[id] and from /materiais
// (issue #60). Shared by both screens, hence the private `_tasks` folder — the
// underscore keeps App Router from treating it as a route.
//
// Same shape and same reasoning as assign-actions.ts: a manager typing a
// material IS an explicit manager command, the same sanctioned non-chat write
// path as "Concluir"/"Reabrir", so it is a direct UPDATE on the RLS-scoped
// client and never a proposal. RLS (tasks_update_company, 0007) scopes the row
// to the caller's company; the explicit company_id filter is belt-and-braces on
// top of it.
//
// Two invariants about the column itself:
//   * `tasks.materials` is `text[]` and stays `text[]`. No comma-joined string,
//     no delimiter convention — 0015/0021 list ('tasks','materials') as a
//     translatable column and the undo path replays a text[] out of a jsonb
//     snapshot, so the element boundaries are load-bearing outside this file.
//   * What the manager types is stored VERBATIM. Storage language is
//     companies.language; the UI language is profiles.language. Nothing here
//     translates on write.

/** Longest single material we will store. A material is a line on a shopping
 *  list ("20 sacos de cimento"), not a paragraph — and it has to fit in a chip
 *  on a phone. */
const MAX_MATERIAL_LENGTH = 120;
/** Most materials on one task. A guard against a runaway paste, not a product
 *  limit; no real task comes close. */
const MAX_MATERIALS = 50;

/**
 * Normalise what came off the form into the array we are willing to store.
 *
 * Exported for nothing — kept separate purely so the rules are readable in one
 * place: trim, drop empties, drop exact duplicates (keeping first-typed order),
 * cap the length of each entry and the number of entries.
 */
function normalise(materials: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of materials) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim().slice(0, MAX_MATERIAL_LENGTH);
    if (!value) continue;
    // Case-insensitive de-dupe, but the ORIGINAL casing is what gets stored:
    // "Cimento" and "cimento" are the same item to a builder, and keeping both
    // would put two lines on the buy list for one trip to the supplier.
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_MATERIALS) break;
  }
  return out;
}

/**
 * Replace the whole material list of one task.
 *
 * Replace rather than add/remove verbs on purpose: the column is a single
 * `text[]`, so every write is a whole-array write anyway, and an "add one"
 * API would only hide a read-modify-write behind a name that promises it is
 * atomic when it is not.
 *
 * Returns nothing — the screen re-renders from the revalidated server tree, so
 * what the manager sees afterwards is what the database actually holds.
 */
export async function setTaskMaterials(taskId: string, materials: string[]): Promise<void> {
  const ctx = await requireAuth();
  await assertNotBlocked(ctx);

  if (!isUuid(taskId)) throw new Error('dashboard.task_materials_set failed: bad task id');
  // A server action's arguments cross a trust boundary like any other request
  // body — the type annotation above is erased at runtime.
  if (!Array.isArray(materials)) throw new Error('dashboard.task_materials_set failed: bad materials');

  const next = normalise(materials);

  const { db, companyId } = ctx;
  const { data, error } = await db
    .from('tasks')
    .update({ materials: next, updated_at: new Date().toISOString() })
    .eq('id', taskId)
    .eq('company_id', companyId)
    .select('job_id')
    .single();
  if (error) throw new Error(`dashboard.task_materials_set failed: ${error.message}`);

  logEvent('dashboard.task_materials_set', { companyId, taskId, count: next.length });

  // Materials show on the task itself, on the anticipation screen, and inside
  // the obra's task list; the amber "N materials for tomorrow" banner on the
  // board reads the same loader as /materiais, so /tarefas has to go too.
  revalidatePath('/materiais');
  revalidatePath(`/tarefas/${taskId}`);
  revalidatePath('/tarefas');
  if (data.job_id) revalidatePath(`/obras/${data.job_id}`);
  revalidatePath('/obras');
}
