import { loadBriefingLog, loadDispatchLog } from '../data';

export const dynamic = 'force-dynamic';

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Lisbon' });
}

// notification_log.kind. Both daily sends write this table, and the raw values
// are snake_case wire vocabulary shared with the cron routes — label them here
// rather than teaching the reader to translate.
const KIND_LABEL: Record<string, string> = {
  daily_briefing: '07:00 briefing',
  task_checkin: '16:30 check-in',
};

const STATUS_STYLE: Record<string, string> = {
  sent: 'text-emerald-600',
  failed: 'text-red-600 font-medium',
  // 'pending' means the claim row was written but the send never resolved —
  // i.e. the function died mid-run. Worth looking at, not just noise.
  pending: 'text-amber-600',
  skipped: 'text-zinc-500',
};

export default async function DispatchPage() {
  const [briefings, { rows: sms, companyNames }] = await Promise.all([loadBriefingLog(), loadDispatchLog()]);

  return (
    <div className="space-y-8">
      <section className="space-y-5">
        <h1 className="text-lg font-semibold">Daily briefing log</h1>
        <p className="text-xs text-zinc-500">
          Both Europe/Lisbon WhatsApp sends, written by the Vercel crons on <code>capo-v1</code> —
          the 07:00 briefing (<code>/api/cron/reminders</code>) and the 16:30 check-in (
          <code>/api/cron/checkin</code>) — read-only here. Last {briefings.length} rows, failures
          included.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-500/20 text-xs text-zinc-500">
                <th className="py-2 pr-4 font-normal">When</th>
                <th className="py-2 pr-4 font-normal">Kind</th>
                <th className="py-2 pr-4 font-normal">Company</th>
                <th className="py-2 pr-4 font-normal">To</th>
                <th className="py-2 pr-4 font-normal">Date</th>
                <th className="py-2 pr-4 font-normal">Status</th>
                <th className="py-2 pr-4 font-normal">Tasks</th>
                <th className="py-2 font-normal">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-500/10">
              {briefings.map(row => (
                <tr key={row.id}>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatWhen(row.created_at)}</td>
                  {/* Two daily sends land in this table now — the 07:00
                      briefing and the 16:30 check-in. Without this column they
                      are indistinguishable, and "did the briefing go out?"
                      becomes unanswerable by looking. */}
                  <td className="py-2 pr-4 whitespace-nowrap text-xs">{KIND_LABEL[row.kind] ?? row.kind}</td>
                  <td className="py-2 pr-4">{row.companies?.name ?? '—'}</td>
                  <td className="py-2 pr-4">
                    {row.audience === 'manager' ? 'Manager' : (row.workers?.name ?? 'Worker')}
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap">{row.notification_date}</td>
                  <td className={`py-2 pr-4 ${STATUS_STYLE[row.status] ?? ''}`}>{row.status}</td>
                  <td className="py-2 pr-4">{Array.isArray(row.task_ids) ? row.task_ids.length : 0}</td>
                  <td className="py-2 font-mono text-xs text-zinc-500">
                    {row.error ?? row.provider_message_id ?? '—'}
                  </td>
                </tr>
              ))}
              {briefings.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-4 text-zinc-500">
                    No briefings logged yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-5">
        <h2 className="text-base font-semibold">Worker SMS dispatch log (paused)</h2>
        <p className="text-xs text-zinc-500">
          Historical. Written by the external n8n workflow (Twilio), which is switched off — nothing new lands here.
          The <code>dispatch_tasks_today</code> view and this table are kept byte-identical so SMS can be switched back
          on. Last {sms.length} sends.
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
              {sms.map(row => (
                <tr key={row.id}>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatWhen(row.sent_at)}</td>
                  <td className="py-2 pr-4">{row.workers ? (companyNames.get(row.workers.company_id) ?? '—') : '—'}</td>
                  <td className="py-2 pr-4">{row.workers?.name ?? '—'}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{row.dispatch_date}</td>
                  <td className="py-2 pr-4">{Array.isArray(row.task_ids) ? row.task_ids.length : 0}</td>
                  <td className="py-2 font-mono text-xs text-zinc-500">{row.provider_message_id ?? '—'}</td>
                </tr>
              ))}
              {sms.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-zinc-500">
                    No dispatches logged.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
