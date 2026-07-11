import Link from 'next/link';
import { loadOverview } from './data';

// Reads the DB (service role, lazy env) per request — must never be
// prerendered at build time, when those secrets don't exist.
export const dynamic = 'force-dynamic';

const STATUS_ORDER = ['pending', 'in_progress', 'blocked', 'done', 'cancelled'];

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Lisbon' });
}

export default async function OverviewPage() {
  const overview = await loadOverview();

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold">All companies</h1>
      {overview.length === 0 && <p className="text-sm text-zinc-500">No companies yet.</p>}
      <div className="space-y-4">
        {overview.map(({ company, managers, workerCount, taskCounts, lastMessageAt }) => (
          <section key={company.id} className="rounded-lg border border-zinc-500/20 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-semibold">{company.name}</h2>
              <span className="text-xs text-zinc-500">last activity {formatWhen(lastMessageAt)}</span>
            </div>
            <p className="mt-1 text-sm text-zinc-500">
              {managers.length > 0
                ? managers.map(m => `${m.full_name} (${m.phone})`).join(', ')
                : 'no manager profile'}
              {' · '}
              {workerCount} active worker{workerCount === 1 ? '' : 's'}
            </p>
            <p className="mt-2 flex flex-wrap gap-3 text-sm">
              {STATUS_ORDER.filter(s => taskCounts[s]).map(s => (
                <span key={s} className="text-zinc-400">
                  {taskCounts[s]} {s.replace('_', ' ')}
                </span>
              ))}
              {Object.keys(taskCounts).length === 0 && <span className="text-zinc-500">no tasks</span>}
            </p>
            <p className="mt-3 text-sm">
              <Link href={`/conversations/${company.id}`} className="text-zinc-400 underline hover:text-zinc-200">
                View conversation →
              </Link>
            </p>
          </section>
        ))}
      </div>
    </div>
  );
}
