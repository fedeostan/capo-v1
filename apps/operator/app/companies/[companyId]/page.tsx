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
// state, not just its transcript. This page itself only reads; the one write
// action it links to is #123's welcome resend, which lives behind its own
// preview-and-confirm screen (./resend-welcome/...). Briefing/check-in resends
// and the message-a-worker flow (#123 part B) are still to come.

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Lisbon' });
}

const KIND_LABEL: Record<string, string> = {
  daily_briefing: '07:00 briefing',
  task_checkin: 'Afternoon check-in',
  welcome: 'Welcome',
  operator_resend_welcome: 'Welcome (operator resend)',
};

const STATUS_STYLE: Record<string, string> = {
  sent: 'text-success',
  failed: 'text-danger font-medium',
  pending: 'text-warn',
  skipped: 'text-fg-muted',
};

const PROPOSAL_STATUS_STYLE: Record<string, string> = {
  pending: 'text-warn',
  executing: 'text-danger font-medium',
  failed: 'text-danger font-medium',
  rejected: 'text-fg-muted',
};

const ALERT_STYLE = {
  critical: 'border-danger bg-danger-quiet',
  warning: 'border-warn bg-warn-quiet',
} as const;

const ALERT_LABEL = { critical: 'text-danger', warning: 'text-warn' } as const;

function AlertCard({ alert }: { alert: Alert }) {
  return (
    <div className={`rounded-lg border p-3 ${ALERT_STYLE[alert.level]}`}>
      <p className={`text-xs font-semibold uppercase tracking-wide ${ALERT_LABEL[alert.level]}`}>{alert.level}</p>
      <p className="mt-1 text-sm font-medium">{alert.title}</p>
      <p className="mt-1 text-sm text-fg-muted">{alert.detail}</p>
    </div>
  );
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <li className="flex items-baseline gap-2 text-sm">
      <span className={ok ? 'text-success' : 'text-danger'}>{ok ? '✓' : '✗'}</span>
      <span>{label}</span>
      {detail && <span className="text-xs text-fg-muted">{detail}</span>}
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

/**
 * The path to the resend preview for a row, or null when no resend exists for
 * its kind. Welcome only (issue #123, part A): a failed briefing or check-in
 * self-heals at the next day's send, and their resend needs the shared
 * renderers, which live in apps/web — see the PR for why they wait.
 */
function resendHref(companyId: string, row: SendLogRow): string | null {
  if (row.kind !== 'welcome') return null;
  const personId = row.worker_id ?? row.profile_id;
  if (!personId) return null;
  return `/companies/${companyId}/resend-welcome/${row.worker_id ? 'worker' : 'manager'}/${personId}`;
}

function SendTable({
  rows,
  showRecipient,
  names,
  resendCompanyId,
}: {
  rows: SendLogRow[];
  showRecipient?: boolean;
  names?: Map<string, string>;
  /** When set, welcome rows get a link to the resend preview (#123). */
  resendCompanyId?: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-fg-muted">Nothing in the window.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-hairline text-xs text-fg-muted">
            <Th>When</Th>
            <Th>Kind</Th>
            {showRecipient && <Th>To</Th>}
            <Th>Status</Th>
            <Th>Delivery</Th>
            <Th>Detail</Th>
            {resendCompanyId && <Th>Action</Th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {rows.map(row => {
            const recipientId = row.worker_id ?? row.profile_id;
            const resend = resendCompanyId ? resendHref(resendCompanyId, row) : null;
            return (
              <tr key={row.id}>
                <Td className="whitespace-nowrap text-xs text-fg-muted">{formatWhen(row.created_at)}</Td>
                <Td>{KIND_LABEL[row.kind] ?? row.kind}</Td>
                {showRecipient && (
                  <Td>{recipientId ? (names?.get(recipientId) ?? row.audience) : '—'}</Td>
                )}
                <Td className={STATUS_STYLE[row.status] ?? ''}>{row.status}</Td>
                <Td className={row.failed_at ? 'text-danger' : 'text-xs text-fg-muted'}>{deliveryState(row)}</Td>
                <Td className="text-xs text-fg-muted">{row.error ?? row.delivery_error ?? ''}</Td>
                {resendCompanyId && (
                  <Td className="whitespace-nowrap text-xs">
                    {resend ? (
                      <Link href={resend} className="underline hover:text-fg">
                        Resend →
                      </Link>
                    ) : (
                      <span className="text-fg-muted">—</span>
                    )}
                  </Td>
                )}
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
        <article key={p.id} className="rounded-lg border border-hairline p-3">
          <p className="text-xs text-fg-muted">
            <span className="font-mono">{p.actionName}</span>
            {' · '}
            <span className={PROPOSAL_STATUS_STYLE[p.status] ?? ''}>{p.status}</span>
            {' · '}created {formatWhen(p.createdAt)} ({p.ageDays}d ago)
            {p.resolvedAt && <> · resolved {formatWhen(p.resolvedAt)}</>}
          </p>
          <p className="mt-1 line-clamp-4 whitespace-pre-line text-sm text-fg-muted">{p.renderedText}</p>
        </article>
      ))}
    </div>
  );
}

function CronRunsTable({ rows }: { rows: CronRun[] }) {
  if (rows.length === 0) return <p className="text-sm text-fg-muted">No runs recorded yet (cron_runs is written since 0036).</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-hairline text-xs text-fg-muted">
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
        <tbody className="divide-y divide-hairline">
          {rows.map(run => (
            <tr key={run.id}>
              <Td className="whitespace-nowrap text-xs text-fg-muted">{run.run_date}</Td>
              <Td>{KIND_LABEL[run.job_kind] ?? run.job_kind}</Td>
              <Td className={`tabular-nums ${run.ran_hour !== run.due_hour ? 'text-warn' : ''}`}>
                {run.due_hour}h / {run.ran_hour}h
              </Td>
              <Td className="tabular-nums">{run.messaged}</Td>
              <Td className={`tabular-nums ${run.failed > 0 ? 'text-danger font-medium' : ''}`}>{run.failed}</Td>
              <Td className={`tabular-nums ${run.excluded_no_consent > 0 ? 'text-warn' : ''}`}>
                {run.excluded_no_consent}
              </Td>
              <Td className="tabular-nums">{run.excluded_inactive}</Td>
              <Td className={`tabular-nums ${run.excluded_unreachable > 0 ? 'text-warn' : ''}`}>
                {run.excluded_unreachable}
              </Td>
              <Td className="tabular-nums">{run.skipped_idle}</Td>
              <Td className="text-xs text-fg-muted">
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
      <p className="text-sm text-fg-muted">
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
          <span className="text-xs text-fg-muted">
            {company.subscription_status} · signed up {formatWhen(company.created_at)} ({activation.daysSinceSignup}d
            ago) · stage: {stageLabel}
          </span>
        </div>
        <p className="text-xs text-fg-muted">
          Company language: {company.language} · last send {formatWhen(activation.lastDispatchAt)} · last manager
          message {formatWhen(activation.lastMessageAt)} ·{' '}
          <Link href={`/conversations/${company.id}`} className="underline hover:text-fg">
            full manager thread →
          </Link>
        </p>
        <p className="text-xs text-fg-muted">
          Failed or stuck welcomes can be resent from the tables below (#123); briefing and check-in resends are not
          built yet — a failed one self-heals at the next day&rsquo;s send. Worker outreach outside the 24h window is
          #123 part B.
          {sendsTruncated && ' Send window is capped — per-person tallies below are floors, not totals.'}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Needs attention</h2>
        {alerts.length === 0 ? (
          <p className="rounded-lg border border-success bg-success-quiet p-3 text-sm">
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
          <p className="text-sm text-fg-muted">No failed, stuck, skipped or undelivered sends in the window.</p>
        ) : (
          <div className="space-y-4">
            {failedSends.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-danger">Failed ({failedSends.length})</h3>
                <SendTable rows={failedSends} showRecipient names={recipientNames} resendCompanyId={company.id} />
              </div>
            )}
            {unresolvedSends.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-warn">
                  Claimed but never resolved ({unresolvedSends.length}) — the cron died mid-run
                </h3>
                <SendTable rows={unresolvedSends} showRecipient names={recipientNames} resendCompanyId={company.id} />
              </div>
            )}
            {deliveryFailures.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-danger">
                  Sent, but Meta reported delivery failure ({deliveryFailures.length})
                </h3>
                <SendTable rows={deliveryFailures} showRecipient names={recipientNames} />
              </div>
            )}
            {skippedSends.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-fg-muted">
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
          <p className="text-sm text-fg-muted">Nothing pending, stuck, failed or rejected.</p>
        ) : (
          <div className="space-y-4">
            {proposals.pending.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-warn">
                  Pending ({proposals.pending.length}) — nothing expires these
                </h3>
                <ProposalList rows={proposals.pending} />
              </div>
            )}
            {proposals.executing.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-danger">Stuck mid-execution ({proposals.executing.length})</h3>
                <ProposalList rows={proposals.executing} />
              </div>
            )}
            {proposals.failed.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-danger">
                  Approved but failed ({proposals.failed.length})
                </h3>
                <ProposalList rows={proposals.failed} />
              </div>
            )}
            {proposals.rejected.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-fg-muted">Rejected ({proposals.rejected.length})</h3>
                <ProposalList rows={proposals.rejected} />
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Cron runs (last {cronRuns.length})</h2>
        <p className="text-xs text-fg-muted">
          One row per job per day. “Due / ran” differing means Vercel’s dispatch drifted; the exclusion counts are the
          people no send ledger row exists for.
        </p>
        <CronRunsTable rows={cronRuns} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Obras</h2>
        {obras.length === 0 ? (
          <p className="text-sm text-fg-muted">No obras yet.</p>
        ) : (
          <>
            <p className="text-sm text-fg-muted">
              {['active', 'paused', 'done']
                .filter(s => obraStatusCounts[s])
                .map(s => `${obraStatusCounts[s]} ${s}`)
                .join(' · ') || `${obras.length} total`}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-hairline text-xs text-fg-muted">
                    <Th>Obra</Th>
                    <Th>Status</Th>
                    <Th>Client</Th>
                    <Th>Starts</Th>
                    <Th>Ends</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {obras.map(job => (
                    <tr key={job.id}>
                      <Td>{job.name}</Td>
                      <Td className={job.status === 'paused' ? 'text-warn' : ''}>{job.status}</Td>
                      <Td className="text-fg-muted">{job.client_name ?? '—'}</Td>
                      <Td className="text-xs text-fg-muted">{job.starts_on ?? '—'}</Td>
                      <Td className="text-xs text-fg-muted">{job.ends_on ?? '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Tasks</h2>
          {/* The shape below is counts. Anything that needs a NAMED task — when
              it was created, whether it ever moved, what was ever sent about
              it — lives one click away on the filtered task list (#155). */}
          <Link href={`/tasks?company=${company.id}`} className="text-xs text-fg-muted underline hover:text-fg">
            Task by task →
          </Link>
        </div>
        {taskShape.total === 0 ? (
          <p className="text-sm text-fg-muted">No tasks yet.</p>
        ) : (
          <div className="space-y-1 text-sm">
            <p>
              {Object.entries(taskShape.byStatus)
                .map(([status, count]) => `${count} ${status.replace('_', ' ')}`)
                .join(' · ')}
            </p>
            <p className="text-fg-muted">
              {taskShape.assigned} assigned / {taskShape.unassigned} unassigned · {taskShape.dated} dated /{' '}
              {taskShape.undated} without dates
            </p>
            <p>
              <span className="text-success">{taskShape.doneLast7Days} done in the last 7 days</span>
              {' · '}
              <span className={taskShape.overdue > 0 ? 'text-danger' : 'text-fg-muted'}>
                {taskShape.overdue} overdue
              </span>
              {' · '}
              <span className={taskShape.atRisk > 0 ? 'text-warn' : 'text-fg-muted'}>
                {taskShape.atRisk} at risk
              </span>
              <span className="text-xs text-fg-muted"> (board definitions, from task_board)</span>
            </p>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Crew</h2>
        {crew.length === 0 ? (
          <p className="text-sm text-fg-muted">No crew yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-hairline text-xs text-fg-muted">
                  <Th>Name</Th>
                  <Th>Active</Th>
                  <Th>Consent</Th>
                  <Th>Language</Th>
                  <Th>Sends (sent/failed/skipped)</Th>
                  <Th>Last send</Th>
                  <Th>Ever replied</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {crew.map(({ worker, consent, sends: tally, lastSendAt, hasThread }) => (
                  <tr key={worker.id} className={worker.active ? '' : 'text-fg-faint'}>
                    <Td>
                      {worker.name}
                      {worker.trade && <span className="block text-xs text-fg-muted">{worker.trade}</span>}
                    </Td>
                    <Td>{worker.active ? 'yes' : 'no'}</Td>
                    <Td className={consent ? 'text-success' : 'text-danger'}>
                      {consent ? 'opted in' : worker.whatsapp_opt_out_at ? 'opted out' : 'never opted in'}
                      <span className="block text-xs text-fg-muted">
                        {consent
                          ? `since ${formatWhen(worker.whatsapp_opt_in_at)}`
                          : worker.whatsapp_opt_out_at
                            ? `out ${formatWhen(worker.whatsapp_opt_out_at)}`
                            : worker.phone
                              ? 'has phone, no opt-in recorded'
                              : 'no phone number'}
                      </span>
                    </Td>
                    <Td>{worker.language ?? <span className="text-fg-muted">inherits ({company.language})</span>}</Td>
                    <Td className="tabular-nums">
                      <span className="text-success">{tally.sent}</span>
                      {' / '}
                      <span className={tally.failed > 0 ? 'text-danger' : ''}>{tally.failed}</span>
                      {' / '}
                      <span className="text-fg-muted">{tally.skipped}</span>
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-fg-muted">{formatWhen(lastSendAt)}</Td>
                    <Td className="text-xs text-fg-muted">
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
              <tr className="border-b border-hairline text-xs text-fg-muted">
                <Th>Name</Th>
                <Th>Phone</Th>
                <Th>Language</Th>
                <Th>Confirm posture</Th>
                <Th>Consent</Th>
                <Th>Last WhatsApp reply</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {managers.map(({ profile, consent }) => (
                <tr key={profile.id}>
                  <Td>{profile.full_name}</Td>
                  <Td className="text-fg-muted">{profile.phone}</Td>
                  <Td>{profile.language}</Td>
                  <Td>{profile.confirm_posture}</Td>
                  <Td className={consent ? 'text-success' : 'text-fg-muted'}>
                    {consent ? 'opted in' : 'no opt-in'}
                  </Td>
                  <Td className="text-xs text-fg-muted">{formatWhen(profile.last_inbound_at)}</Td>
                </tr>
              ))}
              {managers.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-2 text-fg-muted">
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
            <h3 className="text-xs font-semibold text-fg-muted">
              Manager thread — last {Math.min(managerMessages.length, 10)} of {managerMessages.length} loaded
            </h3>
            <Link href={`/conversations/${company.id}`} className="text-xs text-fg-muted underline hover:text-fg">
              Full thread →
            </Link>
          </div>
          <div className="space-y-2">
            {managerMessages.slice(-10).map(message => (
              <article
                key={message.id}
                className={`rounded-lg border-l-2 py-1 pl-3 ${ROLE_STYLES[message.role] ?? 'border-hairline'}`}
              >
                <p className="text-xs text-fg-muted">
                  {message.role} · {message.channel} · {formatWhen(message.created_at)}
                </p>
                <MessageBody content={message.content} />
              </article>
            ))}
            {managerMessages.length === 0 && <p className="text-sm text-fg-muted">No messages yet.</p>}
          </div>
          {managerSends.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-fg-muted">Sends to managers ({managerSends.length})</h4>
              <SendTable rows={managerSends.slice(0, 15)} />
            </div>
          )}
        </div>

        {workerThreads.length === 0 && (
          <p className="text-sm text-fg-muted">
            No worker threads yet — nobody on the crew has written to the worker agent.
          </p>
        )}
        {workerThreads.map(thread => (
          <div key={thread.workerId} className="space-y-2">
            <h3 className="text-xs font-semibold text-fg-muted">
              {thread.workerName} — worker thread, last {thread.messages.length} messages
            </h3>
            <div className="space-y-2">
              {thread.messages.map(message => (
                <article
                  key={message.id}
                  className={`rounded-lg border-l-2 py-1 pl-3 ${ROLE_STYLES[message.role] ?? 'border-hairline'}`}
                >
                  <p className="text-xs text-fg-muted">
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
            <h4 className="text-xs font-semibold text-fg-muted">Send history — {worker.name}</h4>
            <SendTable rows={sends.filter(s => s.worker_id === worker.id).slice(0, 15)} />
          </div>
        ))}
      </section>
    </div>
  );
}
