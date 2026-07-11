import { loadDispatchLog } from '../data';

export const dynamic = 'force-dynamic';

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Lisbon' });
}

export default async function DispatchPage() {
  const { rows, companyNames } = await loadDispatchLog();

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold">Worker SMS dispatch log</h1>
      <p className="text-xs text-zinc-500">
        Written by the external n8n workflow (Twilio) — read-only here. Last {rows.length} sends.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-500/20 text-xs text-zinc-500">
              <th className="py-2 pr-4 font-normal">Sent</th>
              <th className="py-2 pr-4 font-normal">Company</th>
              <th className="py-2 pr-4 font-normal">Worker</th>
              <th className="py-2 pr-4 font-normal">Date</th>
              <th className="py-2 pr-4 font-normal">Tasks</th>
              <th className="py-2 font-normal">Provider id</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-500/10">
            {rows.map(row => (
              <tr key={row.id}>
                <td className="py-2 pr-4 whitespace-nowrap">{formatWhen(row.sent_at)}</td>
                <td className="py-2 pr-4">{row.workers ? (companyNames.get(row.workers.company_id) ?? '—') : '—'}</td>
                <td className="py-2 pr-4">{row.workers?.name ?? '—'}</td>
                <td className="py-2 pr-4 whitespace-nowrap">{row.dispatch_date}</td>
                <td className="py-2 pr-4">{Array.isArray(row.task_ids) ? row.task_ids.length : 0}</td>
                <td className="py-2 font-mono text-xs text-zinc-500">{row.provider_message_id ?? '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-4 text-zinc-500">No dispatches logged yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
