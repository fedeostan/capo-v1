import { getDb } from '@/src/db/client';
import { resolveProposal } from '@/src/capabilities/propose';

// Approve/reject a proposal. Execution is deterministic — the stored
// action_args run through the target tool after re-validation; no model is
// involved. The outcome is appended to the thread as a role='event' message.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { decision } = (await req.json()) as { decision?: string };

  if (decision !== 'approve' && decision !== 'reject') {
    return Response.json({ error: 'decision must be "approve" or "reject"' }, { status: 400 });
  }

  try {
    const resolution = await resolveProposal(getDb(), id, decision);
    return Response.json(resolution);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'unknown error' }, { status: 404 });
  }
}
