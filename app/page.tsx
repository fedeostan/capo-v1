import type { UIMessage } from 'ai';
import { getDb } from '@/src/db/client';
import { ensureRuntime, loadWindow } from '@/src/agent/memory/conversation';
import Chat, { type PendingProposal } from './chat';

export const dynamic = 'force-dynamic';

// Loads the visible window of the perpetual thread (messages after the latest
// summary watermark) so the UI survives reloads along with Capo's memory.
// Proposal card state is derived from proposals.status — never from stale
// client state — and pending proposals whose cards fell behind the summary
// watermark are surfaced separately so they can always be resolved.
export default async function Page() {
  let initialMessages: UIMessage[] = [];
  const proposalStatuses: Record<string, string> = {};
  const orphanedPending: PendingProposal[] = [];
  try {
    const db = getDb();
    const { companyId, conversationId } = await ensureRuntime(db);
    const { rows } = await loadWindow(db, conversationId);

    const inViewProposalIds = new Set<string>();
    initialMessages = rows.map(row => {
      const content = row.content as { parts?: UIMessage['parts'] } | null;
      const parts = content?.parts ?? [];
      for (const part of parts) {
        const proposalId = (part as { output?: { proposalId?: unknown } }).output?.proposalId;
        if (typeof proposalId === 'string') inViewProposalIds.add(proposalId);
      }
      return {
        id: row.id,
        // events render as centered system notes in the UI
        role: row.role === 'event' ? ('system' as const) : (row.role as 'user' | 'assistant'),
        parts,
      };
    });

    const { data: proposals } = await db
      .from('proposals')
      .select('id, status, rendered_text')
      .eq('company_id', companyId);
    for (const p of proposals ?? []) {
      if (inViewProposalIds.has(p.id)) {
        proposalStatuses[p.id] = p.status;
      } else if (p.status === 'pending') {
        orphanedPending.push({ proposalId: p.id, renderedText: p.rendered_text });
      }
    }
  } catch {
    // env not configured yet — start with an empty thread and let the API
    // route surface the real error
  }
  return (
    <Chat initialMessages={initialMessages} proposalStatuses={proposalStatuses} orphanedPending={orphanedPending} />
  );
}
