import { getApiAuth } from '@capo/db/session';
import { runTranslationBatch } from '@capo/core/translation';
import { assertNotBlocked, BillingBlockedError } from '@/lib/billing';

// Advance a translation batch as far as one function invocation allows.
//
// This is the whole execution model. There is no cron and no queue in this
// repo, so the batch ROW is the cursor: each POST picks up whatever is still
// pending, works until it finishes or runs out of budget, and reports where it
// got to. The client loops it. That makes total tenant size unbounded while
// keeping per-request work bounded — a 5,000-task company is simply more
// round trips of the same loop, not a longer function.
export const maxDuration = 300;

// Stop translating with ~1 minute of headroom so the status write, the response
// and the client's next request all land inside the same 300s window.
const BUDGET_MS = 240_000;

export async function POST(_req: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const auth = await getApiAuth();
  if (!auth) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  try {
    // A batch is model spend, so a lapsed tenant cannot resume one. The dial
    // itself stays free — see the comment in perfil/actions.ts.
    await assertNotBlocked(auth);
  } catch (e) {
    if (e instanceof BillingBlockedError) return Response.json({ error: e.message }, { status: 402 });
    throw e;
  }

  const { batchId } = await params;

  try {
    // auth.db is the RLS-scoped client, so a batch belonging to another company
    // is simply not found — no id check needed here.
    const status = await runTranslationBatch(auth.db, batchId, { budgetMs: BUDGET_MS });
    return Response.json(status);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'unknown error' }, { status: 404 });
  }
}
