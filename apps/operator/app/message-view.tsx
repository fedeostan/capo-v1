import Markdown from '@capo/ui/markdown';

// Shared renderer for a stored chat message, used by the Conversations page
// (manager `messages`) and the per-company view (manager AND `worker_messages`
// — both stores write ui-message@7). Worker-authored text is DISPLAYED here on
// purpose: the operator is cross-tenant support tooling, not the manager's
// agent context. It must never be routed anywhere that feeds `messages`,
// `memories` or `proposals` — this file only ever renders.

export const ROLE_STYLES: Record<string, string> = {
  user: 'border-zinc-500/40',
  assistant: 'border-emerald-500/40',
  tool: 'border-amber-500/30',
  event: 'border-sky-500/30',
};

interface MessagePart {
  type: string;
  text?: string;
}

// content is ui-message@7: { parts: [{type: 'text', text}, {type: 'tool-…'}] }.
// Text parts render as markdown; anything else shows as a typed chip so tool
// activity stays visible without replaying it.
function partsOf(content: unknown): MessagePart[] {
  const c = content as { parts?: MessagePart[] } | null;
  return Array.isArray(c?.parts) ? c.parts : [];
}

export function MessageBody({ content }: { content: unknown }) {
  return (
    <div className="mt-1 text-sm">
      {partsOf(content).map((part, i) =>
        part.type === 'text' && part.text ? (
          <Markdown key={i} text={part.text} />
        ) : (
          <span key={i} className="mr-2 rounded bg-zinc-500/15 px-1 font-mono text-[0.85em]">
            {part.type}
          </span>
        ),
      )}
    </div>
  );
}
