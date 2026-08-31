import Link from 'next/link';
import { loadCompanyThread } from '../../data';
import { MessageBody, ROLE_STYLES } from '../../message-view';

export const dynamic = 'force-dynamic';

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
      <p className="text-xs text-zinc-500">
        Last {messages.length} messages, read-only.{' '}
        <Link href={`/companies/${company.id}`} className="underline hover:text-zinc-800">
          Company view →
        </Link>
      </p>
      <div className="space-y-3">
        {messages.map(message => (
          <article key={message.id} className={`rounded-lg border-l-2 py-1 pl-3 ${ROLE_STYLES[message.role] ?? 'border-zinc-500/20'}`}>
            <p className="text-xs text-zinc-500">
              {message.role} · {message.channel} · {formatWhen(message.created_at)}
            </p>
            <MessageBody content={message.content} />
          </article>
        ))}
        {messages.length === 0 && <p className="text-sm text-zinc-500">No messages yet.</p>}
      </div>
    </div>
  );
}
