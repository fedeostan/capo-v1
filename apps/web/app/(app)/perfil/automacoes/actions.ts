'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAuth } from '@capo/db/session';
import { assertNotBlocked } from '@/lib/billing';
import { isSendHour, JOB_KINDS, type JobKind } from '@/lib/schedule';
import { logEvent } from '@/lib/log';

// Moving the time of a scheduled send, or switching one off.
//
// ── WHY THIS IS AN UPSERT AND NOT AN UPDATE ────────────────────────────────
// 0036 deliberately backfills nothing: a company with no row uses the built-in
// default, which is byte-identical to the product before this feature. So the
// FIRST save for any company is an insert and every later one is an update, and
// the unique constraint on (company_id, job_kind) is what makes that one
// statement rather than a read-modify-write with a race in the middle.
//
// ── WHAT THE CLIENT MAY WRITE ──────────────────────────────────────────────
// Only `send_hour` and `enabled`, and that is enforced at the GRANT layer, not
// here: 0036 revokes the table-wide INSERT/UPDATE and re-grants column lists.
// `updated_by` is stamped by a trigger from auth.uid(), so "who moved the
// crew's morning" cannot be forged even by the tenant it belongs to. The
// validation below is UX — the CHECK constraint re-validates the hour.

export async function saveSchedule(formData: FormData): Promise<void> {
  const ctx = await requireAuth();
  const { db, companyId, userId } = ctx;
  // Unlike the profile forms, this IS a gated write: it changes what Capo sends
  // and therefore what the account spends. A lapsed subscription must not be
  // able to schedule new spend.
  await assertNotBlocked(ctx);

  const jobKind = String(formData.get('mensagem') ?? '') as JobKind;
  if (!JOB_KINDS.includes(jobKind)) redirect('/perfil/automacoes?erro=1');

  const sendHour = Number(formData.get('hora'));
  if (!isSendHour(sendHour)) redirect('/perfil/automacoes?erro=hora');

  // A checkbox absent from the payload means unchecked. Read as an explicit
  // boolean rather than a truthiness test, so "off" is a value we wrote and not
  // an absence we inferred.
  const enabled = formData.get('activa') === '1';

  const { error } = await db
    .from('company_schedules')
    .upsert(
      { company_id: companyId, job_kind: jobKind, send_hour: sendHour, enabled },
      { onConflict: 'company_id,job_kind' },
    );
  if (error) {
    console.error('saveSchedule failed:', error.message);
    redirect('/perfil/automacoes?erro=1');
  }

  logEvent('automations.schedule_saved', { companyId, userId, jobKind, sendHour, enabled });
  revalidatePath('/perfil/automacoes');
  redirect('/perfil/automacoes?guardado=1');
}
