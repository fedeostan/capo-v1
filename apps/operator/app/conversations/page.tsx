import Link from 'next/link';
import { loadCompanies } from '../data';

export const dynamic = 'force-dynamic';

export default async function ConversationsIndexPage() {
  const companies = await loadCompanies();

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold">Conversations</h1>
      <ul className="space-y-2 text-sm">
        {companies.map(company => (
          <li key={company.id}>
            <Link href={`/conversations/${company.id}`} className="text-zinc-400 underline hover:text-zinc-200">
              {company.name}
            </Link>
          </li>
        ))}
        {companies.length === 0 && <li className="text-zinc-500">No companies yet.</li>}
      </ul>
    </div>
  );
}
