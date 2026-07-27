import { getApiAuth } from '@capo/db/session';
import { getBatchStatus } from '@capo/core/translation';

// Cheap status read. Separate from the run route so a second tab (or a reload
// mid-batch) can watch progress without kicking off more model work.
export async function GET(_req: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const auth = await getApiAuth();
  if (!auth) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const { batchId } = await params;
  const status = await getBatchStatus(auth.db, batchId);
  if (!status) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(status);
}
