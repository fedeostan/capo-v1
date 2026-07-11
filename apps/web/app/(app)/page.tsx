import type { UIMessage } from 'ai';
import { requireAuth } from '@capo/db/session';
import { findConversation, loadWindow } from '@capo/core/conversation';
import Chat, { type PendingProposal } from '@/app/chat';

export const dynamic = 'force-dynamic';

// Loads the visible window of the perpetual thread (messages after the latest
// summary watermark) so the UI survives reloads along with Capo's memory.
// Proposal card state is derived from proposals.status — never from stale
// client state — and pending proposals whose cards fell behind the summary
// watermark are surfaced separately so they can always be resolved.
export default async function Page() {
  const { db, companyId } = await requireAuth();

  let initialMessages: UIMessage[] = [];
  const proposalStatuses: Record<string, string> = {};
  const orphanedPending: PendingProposal[] = [];

  // Render is read-only: no conversation yet just means an empty thread — the
  // chat API creates it on the first message.
  const conversationId = await findConversation(db, companyId);
  if (conversationId) {
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
  }

  return (
    <Chat initialMessages={initialMessages} proposalStatuses={proposalStatuses} orphanedPending={orphanedPending} />
  );
}
