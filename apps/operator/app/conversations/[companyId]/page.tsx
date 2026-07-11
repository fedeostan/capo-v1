import Link from 'next/link';
import Markdown from '@capo/ui/markdown';
import { loadCompanyThread, type Message } from '../../data';

export const dynamic = 'force-dynamic';

const ROLE_STYLES: Record<string, string> = {
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
function partsOf(message: Message): MessagePart[] {
  const content = message.content as { parts?: MessagePart[] } | null;
  return Array.isArray(content?.parts) ? content.parts : [];
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Lisbon' });
}

export default async function CompanyThreadPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const { company, messages } = await loadCompanyThread(companyId);

  if (!company) {
    return (
      <p className="text-sm text-zinc-500">
        Unknown company. <Link href="/" className="underline">Back to overview</Link>
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold">{company.name} — conversation</h1>
      <p className="text-xs text-zinc-500">Last {messages.length} messages, read-only.</p>
      <div className="space-y-3">
        {messages.map(message => (
          <article key={message.id} className={`rounded-lg border-l-2 py-1 pl-3 ${ROLE_STYLES[message.role] ?? 'border-zinc-500/20'}`}>
            <p className="text-xs text-zinc-500">
              {message.role} · {message.channel} · {formatWhen(message.created_at)}
            </p>
            <div className="mt-1 text-sm">
              {partsOf(message).map((part, i) =>
                part.type === 'text' && part.text ? (
                  <Markdown key={i} text={part.text} />
                ) : (
                  <span key={i} className="mr-2 rounded bg-zinc-500/15 px-1 font-mono text-[0.85em]">
                    {part.type}
                  </span>
                ),
              )}
            </div>
          </article>
        ))}
        {messages.length === 0 && <p className="text-sm text-zinc-500">No messages yet.</p>}
      </div>
    </div>
  );
}
