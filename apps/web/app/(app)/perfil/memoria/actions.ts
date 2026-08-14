'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAuth } from '@capo/db/session';
import { logEvent } from '@/lib/log';

// "Forget this" (issue #48).
//
// ── IT MARKS, IT DOES NOT DELETE ───────────────────────────────────────────
// `active = false`, uniform with everything else in this schema: the translation
// undo marks (0015), a resolved review marks (0018), a read notification marks
// (0024). `memories` has no DELETE policy and 0037 did not add one.
//
// From the manager's side the difference is invisible and the promise is total:
// the prompt read filters on `active` (agent/context.ts) and the screen filters
// on it too, so a forgotten memory reaches no model and appears on no page, ever
// again. What survives is the row, which is what keeps "why did Capo say that in
// March" answerable.
//
// ── WHAT STOPS THIS TOUCHING SOMEBODY ELSE'S MEMORY ───────────────────────
// Not the `.eq('company_id')` below, which is belt and braces. The real guard is
// 0037's UPDATE policy, which carries BOTH predicates — same company AND (it is
// a company memory OR it is mine) — and the column grant, which lets an
// authenticated client write `active`, `content` and `updated_at` and nothing
// else. A colleague's personal memory fails the policy and the statement matches
// zero rows.
//
// ── NOT BILLING-GATED, DELIBERATELY ───────────────────────────────────────
// `assertNotBlocked` guards writes that create future SPEND (scheduling a send,
// generating a plan). This one only ever reduces what Capo carries. A company
// whose subscription has lapsed must still be able to make Capo forget something
// about them.

export async function forgetMemory(formData: FormData): Promise<void> {
  const { db, companyId, userId } = await requireAuth();

  const id = String(formData.get('memoria') ?? '');
  if (!id) redirect('/perfil/memoria?erro=1');

  // `.select('id')` because Postgres reports a filter that matched nothing as a
  // fully successful statement — the same trap the Stripe webhook carries. A
  // silent zero-row update here would render as "Forgotten." over a memory that
  // is still in every prompt, which is the one failure this screen must not
  // have.
  const { data, error } = await db
    .from('memories')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('company_id', companyId)
    .select('id');

  if (error || (data ?? []).length === 0) {
    logEvent('memory.forget_failed', { companyId, userId, id, error: error?.message ?? 'no rows' });
    redirect('/perfil/memoria?erro=1');
  }

  logEvent('memory.forgotten', { companyId, userId, id });
  revalidatePath('/perfil/memoria');
  redirect('/perfil/memoria?esquecido=1');
}
