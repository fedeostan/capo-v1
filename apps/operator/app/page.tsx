import Link from 'next/link';
import { ACTIVATION_STAGES, loadHealth, type ActivationRow, type Alert } from './data';

// Reads the DB (service role, lazy env) per request — must never be
// prerendered at build time, when those secrets don't exist.
export const dynamic = 'force-dynamic';

// The operator home. Deliberately NOT a metrics dashboard: Federico runs this
// alone, so the home screen answers "does anything need me today, and is
// anyone stuck?" — and only then shows numbers. The company list moved to
// /companies, which is where you go once you already know who to look at.

function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Lisbon' });
}

const ALERT_STYLE = {
  critical: 'border-red-500/50 bg-red-500/10',
  warning: 'border-amber-500/50 bg-amber-500/10',
} as const;

const ALERT_LABEL = { critical: 'text-red-500', warning: 'text-amber-500' } as const;

function AlertCard({ alert }: { alert: Alert }) {
  const body = (
    <>
      <p className={`text-xs font-semibold uppercase tracking-wide ${ALERT_LABEL[alert.level]}`}>{alert.level}</p>
      <p className="mt-0.5 text-sm font-medium">{alert.title}</p>
      <p className="mt-0.5 text-sm text-zinc-500">{alert.detail}</p>
    </>
  );
  return (
    <div className={`rounded-lg border p-3 ${ALERT_STYLE[alert.level]}`}>
      {alert.href ? (
        <Link href={alert.href} className="block hover:opacity-80">
          {body}
        </Link>
      ) : (
        body
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-lg border border-zinc-500/20 p-3">
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-zinc-500">{label}</p>
      {hint && <p className="mt-0.5 text-[11px] text-zinc-600">{hint}</p>}
    </div>
  );
}

// A five-dot funnel per company. The point is not the count — it is seeing at
// a glance WHICH step each company died at, because the fix is different for
// each one (onboarding vs. plan quality vs. missing phone numbers vs. n8n).
function StageTrack({ row }: { row: ActivationRow }) {
  const reachedIndex = ACTIVATION_STAGES.findIndex(s => s.key === row.stage);
  return (
    <div className="flex items-center gap-1" title={ACTIVATION_STAGES[reachedIndex]?.label}>
      {ACTIVATION_STAGES.map((stage, i) => (
        <span
          key={stage.key}
          aria-label={stage.label}
          className={`h-1.5 w-6 rounded-full ${
            i <= reachedIndex ? (row.stage === 'dispatching' ? 'bg-emerald-500' : 'bg-amber-500') : 'bg-zinc-500/25'
          }`}
        />
      ))}
    </div>
  );
}

export default async function HealthPage() {
  const { alerts, activation, today, knowledge } = await loadHealth();

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="text-lg font-semibold">Needs you</h1>
        {alerts.length === 0 ? (
          <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
            Nothing flagged. Trials healthy, proposals decided, dispatch running.
          </p>
        ) : (
          <div className="space-y-2">
            {alerts.map((alert, i) => (
              <AlertCard key={`${alert.title}-${i}`} alert={alert} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Today (Europe/Lisbon)</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Briefings sent" value={today.briefingsToday} hint="07:00 WhatsApp cron" />
          <Stat label="Check-ins asked" value={today.checkinsToday} hint="16:30 WhatsApp cron" />
          <Stat label="Messages" value={today.messagesToday} hint="web + WhatsApp" />
          <Stat label="Tasks completed" value={today.tasksCompletedToday} />
          <Stat label="Proposals pending" value={today.proposalsPending} hint="awaiting a manager" />
        </div>
        <p className="text-xs text-zinc-500">
          Knowledge base: {knowledge.documents} document{knowledge.documents === 1 ? '' : 's'}, {knowledge.chunks}{' '}
          chunk{knowledge.chunks === 1 ? '' : 's'} indexed.
        </p>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold">Activation</h2>
          <Link href="/companies" className="text-xs text-zinc-500 underline hover:text-zinc-800">
            All companies →
          </Link>
        </div>
        <p className="text-xs text-zinc-500">
          {ACTIVATION_STAGES.map(s => s.label).join(' → ')}
        </p>
        {activation.length === 0 ? (
          <p className="text-sm text-zinc-500">No companies yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-500/20 text-xs text-zinc-500">
                  <th className="py-2 pr-4 font-normal">Company</th>
                  <th className="py-2 pr-4 font-normal">Progress</th>
                  <th className="py-2 pr-4 font-normal">Obras</th>
                  <th className="py-2 pr-4 font-normal">Open tasks</th>
                  <th className="py-2 pr-4 font-normal">From plans</th>
                  <th className="py-2 pr-4 font-normal">Reachable crew</th>
                  <th className="py-2 pr-4 font-normal">Last dispatch</th>
                  <th className="py-2 font-normal">Last message</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-500/10">
                {activation.map(row => (
                  <tr key={row.companyId}>
                    <td className="py-2 pr-4">
                      <Link href={`/conversations/${row.companyId}`} className="underline hover:text-zinc-800">
                        {row.companyName}
                      </Link>
                      <span className="block text-xs text-zinc-500">{row.daysSinceSignup}d old</span>
                    </td>
                    <td className="py-2 pr-4">
                      <StageTrack row={row} />
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{row.obras}</td>
                    <td className="py-2 pr-4 tabular-nums">{row.tasks}</td>
                    <td className="py-2 pr-4 tabular-nums">{row.aiTasks}</td>
                    <td className={`py-2 pr-4 tabular-nums ${row.reachableWorkers === 0 ? 'text-amber-500' : ''}`}>
                      {row.reachableWorkers}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap text-xs text-zinc-500">
                      {formatWhen(row.lastDispatchAt)}
                    </td>
                    <td className="py-2 whitespace-nowrap text-xs text-zinc-500">{formatWhen(row.lastMessageAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
