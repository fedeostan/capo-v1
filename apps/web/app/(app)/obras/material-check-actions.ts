'use server';

import { revalidatePath } from 'next/cache';
import { requireAuth } from '@capo/db/session';
import { assertNotBlocked } from '@/lib/billing';
import { logEvent } from '@/lib/log';
import { isUuid } from '@/app/(app)/tarefas/filters';

// Ticking today's materials as on site or missing (issue #154).
//
// Same shape and same reasoning as materials-actions.ts: a manager tapping a
// chip IS an explicit manager command — the sanctioned non-chat write path —
// so it is a direct write on the RLS-scoped client and never a proposal. RLS
// (material_checks_*_company, 0044) scopes the row to the caller's company; the
// explicit company_id filter is belt-and-braces on top of it.
//
// THIS IS A CHECK LIST, NOT AN INVENTORY. Nothing here records a quantity, a
// delivery or a consumption, and nothing should be added that does — see the
// header of 0044 for why that is a product decision rather than a backlog item.

/** Same cap as MAX_MATERIAL_LENGTH in _tasks/materials-actions.ts, and the same
 *  cap as the CHECK constraint on the column. A material longer than this
 *  cannot exist, so a tick naming one is a bad request rather than a new row. */
const MAX_MATERIAL_LENGTH = 120;

/** The three states the column allows. 'unknown' is what tapping an active chip
 *  again produces: the manager withdraws an answer they gave in error. It is a
 *  state change rather than a deletion, uniform with "forget this memory" and
 *  the translation undo — 0044 has no DELETE policy. */
//
// Not EXPORTED, and neither is the union it implies: this file is `'use
// server'`, where every export is compiled into a callable HTTP endpoint. The
// caller spells the three values out instead.
const STATES = ['on_site', 'missing', 'unknown'] as const;
type MaterialCheckStatus = (typeof STATES)[number];

/**
 * Record (or withdraw) one answer about one material on one obra, for today.
 *
 * `obraId` may be null — that is the "Sem obra" group, which is a real case
 * because `tasks.job_id` is nullable. 0044's unique index is `nulls not
 * distinct` so it collapses to one row per material like every other group.
 *
 * THE DATE IS NEVER SENT. It comes from the `check_date` column default,
 * lisbon_today(), and the column is absent from the tenant's INSERT grant — a
 * client that could name the day is a client that could tick tomorrow. The
 * same clock is read here only to FIND today's existing row.
 *
 * Returns nothing: the screen re-renders from the revalidated server tree, so
 * what the manager sees afterwards is what the database actually holds.
 */
export async function setMaterialCheck(
  obraId: string | null,
  material: string,
  status: MaterialCheckStatus,
): Promise<void> {
  const ctx = await requireAuth();
  await assertNotBlocked(ctx);

  // A server action's arguments cross a trust boundary like any other request
  // body — the type annotations above are erased at runtime.
  if (obraId !== null && !isUuid(obraId)) throw new Error('dashboard.material_check failed: bad obra id');
  if (typeof material !== 'string') throw new Error('dashboard.material_check failed: bad material');
  const name = material.trim().slice(0, MAX_MATERIAL_LENGTH);
  if (!name) throw new Error('dashboard.material_check failed: empty material');
  if (!STATES.includes(status)) throw new Error('dashboard.material_check failed: bad status');

  const { db, companyId } = ctx;

  // One clock. The date is read from SQL rather than from this machine, so the
  // row this write lands on is the row the list was rendered from.
  const { data: today, error: clockError } = await db.rpc('lisbon_today');
  if (clockError || !today) throw new Error('dashboard.material_check failed: no clock');

  // Read, then insert or update by id, rather than an upsert. PostgREST
  // compiles an upsert to `do update set` over EVERY payload column including
  // the conflict target, which would force `check_date` into the INSERT grant —
  // i.e. it would make the client able to name the day. Two statements keep the
  // grant as narrow as the invariant needs.
  let query = db
    .from('material_checks')
    .select('id')
    .eq('company_id', companyId)
    .eq('material', name)
    .eq('check_date', today);
  query = obraId === null ? query.is('job_id', null) : query.eq('job_id', obraId);
  const { data: existing, error: readError } = await query.maybeSingle();
  if (readError) throw new Error(`dashboard.material_check failed: ${readError.message}`);

  if (existing) {
    const { error } = await db
      .from('material_checks')
      .update({ status })
      .eq('id', existing.id)
      .eq('company_id', companyId);
    if (error) throw new Error(`dashboard.material_check failed: ${error.message}`);
  } else {
    // `check_date`, `checked_by` and `checked_at` are deliberately absent:
    // the column default and the 0044 triggers own them, and the grant refuses
    // a client that names any of the three.
    const { error } = await db
      .from('material_checks')
      .insert({ company_id: companyId, job_id: obraId, material: name, status });
    if (error) throw new Error(`dashboard.material_check failed: ${error.message}`);
  }

  logEvent('dashboard.material_check', { companyId, obraId, status });

  // The ticks show on the materials view (behind the switch on /obras) and the
  // today card on Home reads the same list.
  revalidatePath('/obras');
  revalidatePath('/');
}
