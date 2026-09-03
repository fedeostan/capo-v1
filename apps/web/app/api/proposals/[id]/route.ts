import { after } from 'next/server';
import { getApiAuth } from '@capo/db/session';
import { resolveProposal } from '@capo/core/capabilities/propose';
import { runTranslationBatch } from '@capo/core/translation';
import { assertNotBlocked, BillingBlockedError } from '@/lib/billing';
import { siteUrl } from '@/lib/site-url';
import { drainAssignmentNotices } from '@/app/notifications/task-assigned';

// Raised for one proposal only: apply_company_translation queues a batch, and
// the after() hook below works it once the response has already gone out. Every
// other action here still finishes in milliseconds.
export const maxDuration = 300;

// Approve/reject a proposal. Execution is deterministic — the stored
// action_args run through the target tool after re-validation; no model is
// involved. The outcome is appended to the thread as a role='event' message.
// Runs on the manager's RLS-scoped client: a proposal id from another company
// resolves to "not found", and finalize_proposal re-checks company in SQL.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiAuth();
  // No session means no profile means no locale — a 401 body cannot be
  // localized from the user, and no client renders it. English.
  if (!auth) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const { id } = await params;
  const { decision } = (await req.json()) as { decision?: string };

  if (decision !== 'approve' && decision !== 'reject') {
    return Response.json({ error: 'decision must be "approve" or "reject"' }, { status: 400 });
  }

  try {
    await assertNotBlocked(auth);
  } catch (e) {
    if (e instanceof BillingBlockedError) return Response.json({ error: e.message }, { status: 402 });
    throw e;
  }

  try {
    const resolution = await resolveProposal(
      auth.db,
      id,
      decision,
      { user: auth.locale, company: auth.companyLocale },
      siteUrl(),
    );

    // apply_company_translation only snapshots and queues — it does no model
    // work, because resolveProposal must stay fast for every other action.
    // Kick the batch off here so an approved card starts translating straight
    // away instead of waiting for the manager to open /perfil. The chat client
    // never polls: the card resolves, and the work finishes behind it.
    const batchId =
      resolution.outcome === 'approved' && typeof resolution.result === 'object' && resolution.result !== null
        ? (resolution.result as { batchId?: unknown }).batchId
        : undefined;
    if (typeof batchId === 'string') {
      after(async () => {
        try {
          await runTranslationBatch(auth.db, batchId, { budgetMs: 240_000 });
        } catch (e) {
          // The batch row keeps its own status/error; a throw here would be an
          // unhandled rejection after the response has already been sent.
          console.error('translation batch failed:', e instanceof Error ? e.message : e);
        }
      });
    }

    // ── the crew hears about a new task now, not tomorrow at 07:00 (W7) ────
    // An approved card is one of the seven doors a task gains an assignee
    // through — apply_plan can assign a whole obra in one tap. The queue row
    // is already written by the trigger; this only drains it. One line, and it
    // never throws.
    after(() => drainAssignmentNotices({ companyId: auth.companyId }));

    return Response.json(resolution);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'unknown error' }, { status: 404 });
  }
}
