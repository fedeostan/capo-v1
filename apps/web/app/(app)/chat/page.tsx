import type { UIMessage } from 'ai';
import { requireAuthT } from '@/lib/i18n';
import { findConversation, loadWindow } from '@capo/core/conversation';
import Chat, { type PendingProposal } from '@/app/chat';

export const dynamic = 'force-dynamic';

// Display-level cutoff ONLY (issue #124): a pending card older than this stops
// being stacked above the conversation, but the row is untouched — nothing
// writes 'expired' yet (the real expiry system remains open; AGENTS.md records
// it as known-and-not-fixed). A card reached by id — the WhatsApp approve/
// reject buttons, or a card still inside the visible window — keeps working
// at any age.
const STALE_CARD_DISPLAY_DAYS = 14;
const STALE_CARD_DISPLAY_MS = STALE_CARD_DISPLAY_DAYS * 24 * 60 * 60 * 1000;

// An unparseable timestamp keeps the card visible: hiding is the new
// behaviour, so anything unexpected falls back to the old one.
function staleForDisplay(createdAt: string): boolean {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && Date.now() - t > STALE_CARD_DISPLAY_MS;
}

// Loads the visible window of the perpetual thread (messages after the latest
// summary watermark) so the UI survives reloads along with Capo's memory.
// Proposal card state is derived from proposals.status — never from stale
// client state — and pending proposals whose cards fell behind the summary
// watermark are surfaced separately so they can always be resolved (for the
// first STALE_CARD_DISPLAY_DAYS; after that they stop stacking here but stay
// pending and resolvable by id).
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const {
    ctx: { db, companyId },
    locale,
  } = await requireAuthT();

  // ?q= prefills the composer (the "Ask Capo about this task" link on a task
  // detail). Capped and single-valued: it lands in a textarea the manager
  // reads before sending, but it is still URL input, so it does not get to be
  // arbitrarily long.
  const sp = await searchParams;
  const rawQ = sp.q;
  const initialInput = (Array.isArray(rawQ) ? rawQ[0] : rawQ)?.slice(0, 500) ?? '';

  // PRESENCE, not value: these two are triggers rather than data, so a caller
  // does not have to agree with this page about what "1" means. They are what
  // the persistent top bar's microphone and + buttons link to — neither had a
  // destination before, because the recorder existed only as a control inside
  // the composer and nothing focused the composer.
  const autoVoice = sp.voice !== undefined;
  const autoFocus = sp.compose !== undefined;

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
      .select('id, status, rendered_text, created_at')
      .eq('company_id', companyId);
    for (const p of proposals ?? []) {
      if (inViewProposalIds.has(p.id)) {
        proposalStatuses[p.id] = p.status;
      } else if (p.status === 'pending' && !staleForDisplay(p.created_at)) {
        orphanedPending.push({ proposalId: p.id, renderedText: p.rendered_text });
      }
    }
  }

  return (
    <Chat
      initialMessages={initialMessages}
      locale={locale}
      proposalStatuses={proposalStatuses}
      orphanedPending={orphanedPending}
      initialInput={initialInput}
      autoVoice={autoVoice}
      autoFocus={autoFocus}
    />
  );
}
