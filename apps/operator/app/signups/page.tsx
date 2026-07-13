import Link from 'next/link';
import { loadSignups } from '../data';

// Reads the DB (service role, lazy env) per request — must never be
// prerendered at build time, when those secrets don't exist.
export const dynamic = 'force-dynamic';

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Lisbon' });
}

export default async function SignupsPage() {
  const signups = await loadSignups();

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold">Signups</h1>
      {signups.length === 0 && <p className="text-sm text-zinc-500">No signups yet.</p>}
      <div className="space-y-2">
        {signups.map(s => (
          <div
            key={s.profileId}
            className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-zinc-500/20 p-3"
          >
            <div>
              <p className="text-sm font-medium">
                {s.fullName} <span className="text-zinc-500">({s.phone})</span>
              </p>
              <p className="text-xs text-zinc-500">
                <Link href={`/conversations/${s.companyId}`} className="underline hover:text-zinc-300">
                  {s.companyName}
                </Link>
                {' · '}
                {s.subscriptionStatus}
              </p>
            </div>
            <span className="text-xs text-zinc-500">{formatWhen(s.createdAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
