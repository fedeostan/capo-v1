import Link from 'next/link';
import {
  ACTIVATION_STAGES,
  loadCompanyDetail,
  type Alert,
  type CronRun,
  type ProposalView,
  type SendLogRow,
} from '../../data';
import { MessageBody, ROLE_STYLES } from '../../message-view';

// Reads the DB (service role, lazy env) per request — must never be
// prerendered at build time, when those secrets don't exist.
export const dynamic = 'force-dynamic';

// The per-company mini-app (issue #122): open a tenant and see its actual
// state, not just its transcript. Strictly read-only — the resend and
// message-a-worker buttons belong to #123, which will sit inside this page.

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Lisbon' });
}

const KIND_LABEL: Record<string, string> = {
  daily_briefing: '07:00 briefing',
  task_checkin: 'Afternoon check-in',
  welcome: 'Welcome',
};

const STATUS_STYLE: Record<string, string> = {
  sent: 'text-emerald-600',
  failed: 'text-red-600 font-medium',
  pending: 'text-amber-600',
  skipped: 'text-zinc-500',
};

const PROPOSAL_STATUS_STYLE: Record<string, string> = {
  pending: 'text-amber-600',
  executing: 'text-red-600 font-medium',
  failed: 'text-red-600 font-medium',
  rejected: 'text-zinc-500',
};

const ALERT_STYLE = {
  critical: 'border-red-500/50 bg-red-500/10',
  warning: 'border-amber-500/50 bg-amber-500/10',
} as const;

const ALERT_LABEL = { critical: 'text-red-500', warning: 'text-amber-500' } as const;

function AlertCard({ alert }: { alert: Alert }) {
  return (
    <div className={`rounded-lg border p-3 ${ALERT_STYLE[alert.level]}`}>
      <p className={`text-xs font-semibold uppercase tracking-wide ${ALERT_LABEL[alert.level]}`}>{alert.level}</p>
      <p className="mt-0.5 text-sm font-medium">{alert.title}</p>
      <p className="mt-0.5 text-sm text-zinc-500">{alert.detail}</p>
    </div>
  );
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <li className="flex items-baseline gap-2 text-sm">
      <span className={ok ? 'text-emerald-600' : 'text-red-600'}>{ok ? '✓' : '✗'}</span>
      <span>{label}</span>
      {detail && <span className="text-xs text-zinc-500">{detail}</span>}
    </li>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="py-2 pr-4 font-normal">{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-2 pr-4 align-top ${className}`}>{children}</td>;
}

/** What Meta has told us about a sent row so far — one column per callback. */
function deliveryState(row: SendLogRow): string {
  if (row.status !== 'sent') return '—';
  if (row.failed_at) return `delivery failed${row.delivery_error_code ? ` (${row.delivery_error_code})` : ''}`;
  if (row.read_at) return 'read';
  if (row.delivered_at) return 'delivered';
  return 'accepted by Meta';
}

function SendTable({ rows, showRecipient, names }: { rows: SendLogRow[]; showRecipient?: boolean; names?: Map<string, string> }) {
  if (rows.length === 0) return <p className="text-sm text-zinc-500">Nothing in the window.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-500/20 text-xs text-zinc-500">
            <Th>When</Th>
            <Th>Kind</Th>
            {showRecipient && <Th>To</Th>}
            <Th>Status</Th>
            <Th>Delivery</Th>
            <Th>Detail</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-500/10">
          {rows.map(row => {
            const recipientId = row.worker_id ?? row.profile_id;
            return (
              <tr key={row.id}>
                <Td className="whitespace-nowrap text-xs text-zinc-500">{formatWhen(row.created_at)}</Td>
                <Td>{KIND_LABEL[row.kind] ?? row.kind}</Td>
                {showRecipient && (
                  <Td>{recipientId ? (names?.get(recipientId) ?? row.audience) : '—'}</Td>
                )}
                <Td className={STATUS_STYLE[row.status] ?? ''}>{row.status}</Td>
                <Td className={row.failed_at ? 'text-red-600' : 'text-xs text-zinc-500'}>{deliveryState(row)}</Td>
                <Td className="text-xs text-zinc-500">{row.error ?? row.delivery_error ?? ''}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProposalList({ rows }: { rows: ProposalView[] }) {
  return (
    <div className="space-y-2">
      {rows.map(p => (
        <article key={p.id} className="rounded-lg border border-zinc-500/20 p-3">
          <p className="text-xs text-zinc-500">
            <span className="font-mono">{p.actionName}</span>
            {' · '}
            <span className={PROPOSAL_STATUS_STYLE[p.status] ?? ''}>{p.status}</span>
            {' · '}created {formatWhen(p.createdAt)} ({p.ageDays}d ago)
            {p.resolvedAt && <> · resolved {formatWhen(p.resolvedAt)}</>}
          </p>
          <p className="mt-1 line-clamp-4 whitespace-pre-line text-sm text-zinc-600">{p.renderedText}</p>
        </article>
      ))}
    </div>
  );
}

function CronRunsTable({ rows }: { rows: CronRun[] }) {
  if (rows.length === 0) return <p className="text-sm text-zinc-500">No runs recorded yet (cron_runs is written since 0036).</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-500/20 text-xs text-zinc-500">
            <Th>Date</Th>
            <Th>Job</Th>
            <Th>Due / ran</Th>
            <Th>Messaged</Th>
            <Th>Failed</Th>
            <Th>No consent</Th>
            <Th>Inactive</Th>
            <Th>Unreachable</Th>
            <Th>Idle</Th>
            <Th>Notes</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-500/10">
          {rows.map(run => (
            <tr key={run.id}>
              <Td className="whitespace-nowrap text-xs text-zinc-500">{run.run_date}</Td>
              <Td>{KIND_LABEL[run.job_kind] ?? run.job_kind}</Td>
              <Td className={`tabular-nums ${run.ran_hour !== run.due_hour ? 'text-amber-600' : ''}`}>
                {run.due_hour}h / {run.ran_hour}h
              </Td>
              <Td className="tabular-nums">{run.messaged}</Td>
              <Td className={`tabular-nums ${run.failed > 0 ? 'text-red-600 font-medium' : ''}`}>{run.failed}</Td>
              <Td className={`tabular-nums ${run.excluded_no_consent > 0 ? 'text-amber-600' : ''}`}>
                {run.excluded_no_consent}
              </Td>
              <Td className="tabular-nums">{run.excluded_inactive}</Td>
              <Td className={`tabular-nums ${run.excluded_unreachable > 0 ? 'text-amber-600' : ''}`}>
                {run.excluded_unreachable}
              </Td>
              <Td className="tabular-nums">{run.skipped_idle}</Td>
              <Td className="text-xs text-zinc-500">
                {[
                  run.no_manager_account ? 'no manager account' : null,
                  run.managers_no_consent > 0 ? `${run.managers_no_consent} manager(s) without consent` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function CompanyDetailPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const detail = await loadCompanyDetail(companyId);

  if (!detail) {
    return (
      <p className="text-sm text-zinc-500">
        Unknown company. <Link href="/companies" className="underline">Back to companies</Link>
      </p>
    );
  }

  const {
    company,
    activation,
    alerts,
    onboarding,
    failedSends,
    skippedSends,
    unresolvedSends,
    deliveryFailures,
    sends,
    sendsTruncated,
    proposals,
    cronRuns,
    obras,
    taskShape,
    crew,
    managers,
    managerMessages,
    workerThreads,
  } = detail;

  const stageLabel = ACTIVATION_STAGES.find(s => s.key === activation.stage)?.label ?? activation.stage;
  const recipientNames = new Map([
    ...crew.map(c => [c.worker.id, c.worker.name] as const),
    ...managers.map(m => [m.profile.id, m.profile.full_name] as const),
  ]);
  const managerSends = sends.filter(s => s.profile_id != null);
  const obraStatusCounts = obras.reduce<Record<string, number>>((acc, j) => {
    acc[j.status] = (acc[j.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-8">
      <section className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold">{company.name}</h1>
          <span className="text-xs text-zinc-500">
            {company.subscription_status} · signed up {formatWhen(company.created_at)} ({activation.daysSinceSignup}d
            ago) · stage: {stageLabel}
          </span>
        </div>
        <p className="text-xs text-zinc-500">
          Company language: {company.language} · last send {formatWhen(activation.lastDispatchAt)} · last manager
          message {formatWhen(activation.lastMessageAt)} ·{' '}
          <Link href={`/conversations/${company.id}`} className="underline hover:text-zinc-800">
            full manager thread →
          </Link>
        </p>
        <p className="text-xs text-zinc-500">
          Read-only. Resend and outreach actions arrive with #123.
          {sendsTruncated && ' Send window is capped — per-person tallies below are floors, not totals.'}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Needs attention</h2>
        {alerts.length === 0 ? (
          <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
            Nothing flagged for this company.
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
        <h2 className="text-sm font-semibold">Onboarding</h2>
        <ul className="space-y-1">
          <Check ok={onboarding.hasObra} label="Has at least one obra" />
          <Check
            ok={onboarding.planApplied}
            label="A generated plan was applied"
            detail={onboarding.planApplied ? undefined : 'no approved apply_plan card, no tasks created by Capo'}
          />
          <Check ok={onboarding.hasTasks} label="Has tasks" detail={`${taskShape.total} total`} />
          <Check
            ok={onboarding.reachableCrew > 0}
            label="Crew reachable on WhatsApp"
            detail={`${onboarding.reachableCrew} of ${onboarding.activeCrew} active have a phone`}
          />
          <Check
            ok={onboarding.consentedCrew > 0}
            label="Crew consent recorded"
            detail={`${onboarding.consentedCrew} of ${onboarding.activeCrew} active opted in — without it no proactive send goes out (0025)`}
          />
          <Check ok={onboarding.briefingEverSent} label="A 07:00 briefing has gone out" />
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Sends that need looking at</h2>
        {failedSends.length === 0 && unresolvedSends.length === 0 && skippedSends.length === 0 && deliveryFailures.length === 0 ? (
          <p className="text-sm text-zinc-500">No failed, stuck, skipped or undelivered sends in the window.</p>
        ) : (
          <div className="space-y-4">
            {failedSends.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-red-600">Failed ({failedSends.length})</h3>
                <SendTable rows={failedSends} showRecipient names={recipientNames} />
              </div>
            )}
            {unresolvedSends.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-amber-600">
                  Claimed but never resolved ({unresolvedSends.length}) — the cron died mid-run
                </h3>
                <SendTable rows={unresolvedSends} showRecipient names={recipientNames} />
              </div>
            )}
            {deliveryFailures.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-red-600">
                  Sent, but Meta reported delivery failure ({deliveryFailures.length})
                </h3>
                <SendTable rows={deliveryFailures} showRecipient names={recipientNames} />
              </div>
            )}
            {skippedSends.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-zinc-500">
                  Skipped ({skippedSends.length}) — claimed, then deliberately not sent; the cron run row below says who
                  was excluded and why
                </h3>
                <SendTable rows={skippedSends} showRecipient names={recipientNames} />
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Approval cards</h2>
        {proposals.pending.length === 0 &&
        proposals.executing.length === 0 &&
        proposals.failed.length === 0 &&
        proposals.rejected.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing pending, stuck, failed or rejected.</p>
        ) : (
          <div className="space-y-4">
            {proposals.pending.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-amber-600">
                  Pending ({proposals.pending.length}) — nothing expires these
                </h3>
                <ProposalList rows={proposals.pending} />
              </div>
            )}
            {proposals.executing.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-red-600">Stuck mid-execution ({proposals.executing.length})</h3>
                <ProposalList rows={proposals.executing} />
              </div>
            )}
            {proposals.failed.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-red-600">
                  Approved but failed ({proposals.failed.length})
                </h3>
                <ProposalList rows={proposals.failed} />
              </div>
            )}
            {proposals.rejected.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-zinc-500">Rejected ({proposals.rejected.length})</h3>
                <ProposalList rows={proposals.rejected} />
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Cron runs (last {cronRuns.length})</h2>
        <p className="text-xs text-zinc-500">
          One row per job per day. “Due / ran” differing means Vercel’s dispatch drifted; the exclusion counts are the
          people no send ledger row exists for.
        </p>
        <CronRunsTable rows={cronRuns} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Obras</h2>
        {obras.length === 0 ? (
          <p className="text-sm text-zinc-500">No obras yet.</p>
        ) : (
          <>
            <p className="text-sm text-zinc-500">
              {['active', 'paused', 'done']
                .filter(s => obraStatusCounts[s])
                .map(s => `${obraStatusCounts[s]} ${s}`)
                .join(' · ') || `${obras.length} total`}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-500/20 text-xs text-zinc-500">
                    <Th>Obra</Th>
                    <Th>Status</Th>
                    <Th>Client</Th>
                    <Th>Starts</Th>
                    <Th>Ends</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-500/10">
                  {obras.map(job => (
                    <tr key={job.id}>
                      <Td>{job.name}</Td>
                      <Td className={job.status === 'paused' ? 'text-amber-600' : ''}>{job.status}</Td>
                      <Td className="text-zinc-500">{job.client_name ?? '—'}</Td>
                      <Td className="text-xs text-zinc-500">{job.starts_on ?? '—'}</Td>
                      <Td className="text-xs text-zinc-500">{job.ends_on ?? '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Tasks</h2>
        {taskShape.total === 0 ? (
          <p className="text-sm text-zinc-500">No tasks yet.</p>
        ) : (
          <div className="space-y-1 text-sm">
            <p>
              {Object.entries(taskShape.byStatus)
                .map(([status, count]) => `${count} ${status.replace('_', ' ')}`)
                .join(' · ')}
            </p>
            <p className="text-zinc-500">
              {taskShape.assigned} assigned / {taskShape.unassigned} unassigned · {taskShape.dated} dated /{' '}
              {taskShape.undated} without dates
            </p>
            <p>
              <span className="text-emerald-600">{taskShape.doneLast7Days} done in the last 7 days</span>
              {' · '}
              <span className={taskShape.overdue > 0 ? 'text-red-600' : 'text-zinc-500'}>
                {taskShape.overdue} overdue
              </span>
              {' · '}
              <span className={taskShape.atRisk > 0 ? 'text-amber-600' : 'text-zinc-500'}>
                {taskShape.atRisk} at risk
              </span>
              <span className="text-xs text-zinc-500"> (board definitions, from task_board)</span>
            </p>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Crew</h2>
        {crew.length === 0 ? (
          <p className="text-sm text-zinc-500">No crew yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-500/20 text-xs text-zinc-500">
                  <Th>Name</Th>
                  <Th>Active</Th>
                  <Th>Consent</Th>
                  <Th>Language</Th>
                  <Th>Sends (sent/failed/skipped)</Th>
                  <Th>Last send</Th>
                  <Th>Ever replied</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-500/10">
                {crew.map(({ worker, consent, sends: tally, lastSendAt, hasThread }) => (
                  <tr key={worker.id} className={worker.active ? '' : 'text-zinc-400'}>
                    <Td>
                      {worker.name}
                      {worker.trade && <span className="block text-xs text-zinc-500">{worker.trade}</span>}
                    </Td>
                    <Td>{worker.active ? 'yes' : 'no'}</Td>
                    <Td className={consent ? 'text-emerald-600' : 'text-red-600'}>
                      {consent ? 'opted in' : worker.whatsapp_opt_out_at ? 'opted out' : 'never opted in'}
                      <span className="block text-xs text-zinc-500">
                        {consent
                          ? `since ${formatWhen(worker.whatsapp_opt_in_at)}`
                          : worker.whatsapp_opt_out_at
                            ? `out ${formatWhen(worker.whatsapp_opt_out_at)}`
                            : worker.phone
                              ? 'has phone, no opt-in recorded'
                              : 'no phone number'}
                      </span>
                    </Td>
                    <Td>{worker.language ?? <span className="text-zinc-500">inherits ({company.language})</span>}</Td>
                    <Td className="tabular-nums">
                      <span className="text-emerald-600">{tally.sent}</span>
                      {' / '}
                      <span className={tally.failed > 0 ? 'text-red-600' : ''}>{tally.failed}</span>
                      {' / '}
                      <span className="text-zinc-500">{tally.skipped}</span>
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-zinc-500">{formatWhen(lastSendAt)}</Td>
                    <Td className="text-xs text-zinc-500">
                      {worker.last_inbound_at ? formatWhen(worker.last_inbound_at) : hasThread ? 'has thread' : 'never'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Managers</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-500/20 text-xs text-zinc-500">
                <Th>Name</Th>
                <Th>Phone</Th>
                <Th>Language</Th>
                <Th>Confirm posture</Th>
                <Th>Consent</Th>
                <Th>Last WhatsApp reply</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-500/10">
              {managers.map(({ profile, consent }) => (
                <tr key={profile.id}>
                  <Td>{profile.full_name}</Td>
                  <Td className="text-zinc-500">{profile.phone}</Td>
                  <Td>{profile.language}</Td>
                  <Td>{profile.confirm_posture}</Td>
                  <Td className={consent ? 'text-emerald-600' : 'text-zinc-500'}>
                    {consent ? 'opted in' : 'no opt-in'}
                  </Td>
                  <Td className="text-xs text-zinc-500">{formatWhen(profile.last_inbound_at)}</Td>
                </tr>
              ))}
              {managers.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-2 text-zinc-500">
                    No manager profile — nobody can log in or approve anything.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold">Communication</h2>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-xs font-semibold text-zinc-500">
              Manager thread — last {Math.min(managerMessages.length, 10)} of {managerMessages.length} loaded
            </h3>
            <Link href={`/conversations/${company.id}`} className="text-xs text-zinc-500 underline hover:text-zinc-800">
              Full thread →
            </Link>
          </div>
          <div className="space-y-2">
            {managerMessages.slice(-10).map(message => (
              <article
                key={message.id}
                className={`rounded-lg border-l-2 py-1 pl-3 ${ROLE_STYLES[message.role] ?? 'border-zinc-500/20'}`}
              >
                <p className="text-xs text-zinc-500">
                  {message.role} · {message.channel} · {formatWhen(message.created_at)}
                </p>
                <MessageBody content={message.content} />
              </article>
            ))}
            {managerMessages.length === 0 && <p className="text-sm text-zinc-500">No messages yet.</p>}
          </div>
          {managerSends.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-zinc-500">Sends to managers ({managerSends.length})</h4>
              <SendTable rows={managerSends.slice(0, 15)} />
            </div>
          )}
        </div>

        {workerThreads.length === 0 && (
          <p className="text-sm text-zinc-500">
            No worker threads yet — nobody on the crew has written to the worker agent.
          </p>
        )}
        {workerThreads.map(thread => (
          <div key={thread.workerId} className="space-y-2">
            <h3 className="text-xs font-semibold text-zinc-500">
              {thread.workerName} — worker thread, last {thread.messages.length} messages
            </h3>
            <div className="space-y-2">
              {thread.messages.map(message => (
                <article
                  key={message.id}
                  className={`rounded-lg border-l-2 py-1 pl-3 ${ROLE_STYLES[message.role] ?? 'border-zinc-500/20'}`}
                >
                  <p className="text-xs text-zinc-500">
                    {message.role} · {message.channel} · {formatWhen(message.created_at)}
                    {message.photo_count > 0 && <> · {message.photo_count} photo{message.photo_count === 1 ? '' : 's'}</>}
                  </p>
                  <MessageBody content={message.content} />
                </article>
              ))}
            </div>
          </div>
        ))}

        {crew.filter(c => sends.some(s => s.worker_id === c.worker.id)).map(({ worker }) => (
          <div key={worker.id} className="space-y-1">
            <h4 className="text-xs font-semibold text-zinc-500">Send history — {worker.name}</h4>
            <SendTable rows={sends.filter(s => s.worker_id === worker.id).slice(0, 15)} />
          </div>
        ))}
      </section>
    </div>
  );
}
