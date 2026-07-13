import { getApiAuth } from '@capo/db/session';
import { resolveProposal } from '@capo/core/capabilities/propose';
import { assertNotBlocked, BillingBlockedError } from '@/lib/billing';

// Approve/reject a proposal. Execution is deterministic — the stored
// action_args run through the target tool after re-validation; no model is
// involved. The outcome is appended to the thread as a role='event' message.
// Runs on the manager's RLS-scoped client: a proposal id from another company
// resolves to "not found", and finalize_proposal re-checks company in SQL.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiAuth();
  if (!auth) return Response.json({ error: 'Não autenticado' }, { status: 401 });

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
    const resolution = await resolveProposal(auth.db, id, decision);
    return Response.json(resolution);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'unknown error' }, { status: 404 });
  }
}
