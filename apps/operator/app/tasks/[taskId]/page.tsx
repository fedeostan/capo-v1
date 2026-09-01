import Link from 'next/link';
import {
  loadTaskDetail,
  riskSignals,
  taskWasTouched,
  type OperatorTaskPhoto,
  type TaskDependencyLink,
  type TaskSendView,
} from '../../data';

// Reads the DB (service role, lazy env) per request — must never be
// prerendered at build time, when those secrets don't exist. It is ALSO what
// keeps the signed photo URLs below honest: a signed URL is a bearer token,
// and one baked into a prerendered page is served to whoever asks and then
// expires. Do not add a cached wrapper, and do not remove this line.
export const dynamic = 'force-dynamic';

// One task, end to end (issue #155).
//
// The question this screen answers is "what has happened to this piece of
// work", and until now the answer lived in seven relations and a SQL client:
// the task, its obra, the crew on it, both directions of task_dependencies,
// every completion claim, every photo, and every WhatsApp send that carried
// it. The last of those had no screen at all — notification_log is deny-all to
// tenants, so "did the crew ever actually hear about this task" was
// unanswerable from anywhere in the product.
//
// READ-ONLY, like the rest of apps/operator. There is no control on this page
// and there must not be one: a portal that can write is a portal that can
// write to the wrong tenant.

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Lisbon',
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TASK_STATUS_STYLE: Record<string, string> = {
  pending: 'text-fg-muted',
  in_progress: 'text-info',
  pending_review: 'text-review',
  blocked: 'text-warn',
  done: 'text-success',
  cancelled: 'text-fg-faint line-through',
};

const REVIEW_STATUS_STYLE: Record<string, string> = {
  pending: 'text-review',
  approved: 'text-success',
  rejected: 'text-danger',
  dismissed: 'text-fg-muted',
  superseded: 'text-fg-muted',
};

const SEND_STATUS_STYLE: Record<string, string> = {
  sent: 'text-success',
  failed: 'text-danger font-medium',
  pending: 'text-warn',
  skipped: 'text-fg-muted',
};

const KIND_LABEL: Record<string, string> = {
  daily_briefing: '07:00 briefing',
  task_checkin: 'Afternoon check-in',
  welcome: 'Welcome',
  operator_resend_welcome: 'Welcome (operator resend)',
};

/** What Meta has told us about a sent row so far — one column per callback,
 *  never derived from another, because Meta does not order them. */
function deliveryState(row: TaskSendView['row']): string {
  if (row.status !== 'sent') return '—';
  if (row.failed_at) return `delivery failed${row.delivery_error_code ? ` (${row.delivery_error_code})` : ''}`;
  if (row.read_at) return 'read';
  if (row.delivered_at) return 'delivered';
  return 'accepted by Meta';
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint && <p className="text-xs text-fg-muted">{hint}</p>}
      {children}
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="py-2 pr-4 font-normal">{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-2 pr-4 align-top ${className}`}>{children}</td>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function DependencyTable({ rows, empty }: { rows: TaskDependencyLink[]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-fg-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-hairline text-xs text-fg-muted">
            <Th>Task</Th>
            <Th>Status</Th>
            <Th>Obra</Th>
            <Th>Due</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {rows.map(link => (
            <tr key={link.id}>
              <Td>
                <Link href={`/tasks/${link.id}`} className="underline hover:text-fg">
                  {link.title}
                </Link>
              </Td>
              <Td className={TASK_STATUS_STYLE[link.status] ?? ''}>{link.status.replace('_', ' ')}</Td>
              <Td className="text-xs text-fg-muted">
                {link.jobName ?? 'no obra'}
                {/* Cross-job edges are legal (0007 constrains both ends to one
                    COMPANY, never one job) and are exactly what an operator
                    tracing a stuck task needs pointed out. */}
                {link.crossJob && <span className="ml-2 text-warn">different obra</span>}
              </Td>
              <Td className="text-xs text-fg-muted">{link.dueDate ?? '—'}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PhotoCard({ photo }: { photo: OperatorTaskPhoto }) {
  return (
    <li className="space-y-1">
      {photo.url ? (
        <a href={photo.url} target="_blank" rel="noopener noreferrer">
          {/* Plain <img>, not next/image: the URL is a per-request signed URL
              on a Storage host, which is exactly what the image optimizer
              cannot cache — and caching it is the one thing that must not
              happen to a bearer token. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photo.url}
            alt={`${photo.source}-sourced photo, ${formatWhen(photo.createdAt)}`}
            loading="lazy"
            className="aspect-square w-full rounded-chip border border-hairline object-cover"
          />
        </a>
      ) : (
        // The row is shown even with no URL, deliberately unlike apps/web,
        // which drops an unsignable row so the manager never meets a broken
        // frame. An operator is here to find out that this row exists.
        <div className="flex aspect-square w-full items-center justify-center rounded-chip border border-danger bg-danger-quiet p-2 text-center text-xs text-danger">
          object could not be signed
        </div>
      )}
      <p className="text-xs text-fg-muted">
        <span className={photo.source === 'worker' ? 'text-info' : ''}>{photo.source}</span>
        {' · '}
        {formatWhen(photo.createdAt)}
      </p>
      <p className="text-xs text-fg-faint">
        {photo.source === 'worker'
          ? `worker: ${photo.workerName ?? photo.workerId ?? 'unattributed'}`
          : `uploaded by: ${photo.uploadedByName ?? photo.uploadedBy ?? 'unattributed'}`}
        {' · '}
        {photo.mime.replace('image/', '')} · {formatBytes(photo.byteSize)}
      </p>
    </li>
  );
}

export default async function TaskDetailPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const detail = await loadTaskDetail(taskId);

  if (!detail) {
    return (
      <p className="text-sm text-fg-muted">
        Unknown task.{' '}
        <Link href="/tasks" className="underline">
          Back to tasks
        </Link>
      </p>
    );
  }

  const {
    task,
    company,
    job,
    board,
    lead,
    collaborators,
    unresolvedCollaboratorIds,
    dependsOn,
    blocks,
    reviews,
    photos,
    photoError,
    sends,
    sendsError,
  } = detail;

  const signals = riskSignals(board);
  const firedSignals = signals.filter(s => s.fired);
  const pendingReview = reviews.find(r => r.status === 'pending') ?? null;

  return (
    <div className="space-y-8">
      <section className="space-y-1">
        <p className="text-xs text-fg-muted">
          <Link href="/tasks" className="underline hover:text-fg">
            Tasks
          </Link>
          {' / '}
          <Link href={`/companies/${company.id}`} className="underline hover:text-fg">
            {company.name}
          </Link>
        </p>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold">{task.title}</h1>
          <span className={`text-sm ${TASK_STATUS_STYLE[task.status] ?? 'text-fg-muted'}`}>
            {task.status.replace('_', ' ')}
          </span>
        </div>
        <p className="text-xs text-fg-muted">
          created {formatWhen(task.created_at)} · last moved{' '}
          {taskWasTouched(task) ? formatWhen(task.updated_at) : 'never'} · written by{' '}
          <span className="font-mono">{task.source}</span> · <span className="font-mono">{task.id}</span>
        </p>
      </section>

      <Section
        title="Where the board puts it"
        hint="Read from task_board, never recomputed here — the view is the one clock, so this page and the manager's own board cannot disagree. Note the view suppresses `at risk` for anything already overdue while leaving the individual signals set: a signal firing under a false `at risk` is the view being right."
      >
        {board === null ? (
          <p className="text-sm text-danger">
            No task_board row for this task. That should be impossible — the view selects from `tasks` with no
            filter — so treat it as a read failure rather than as a fact about the task.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-3 text-sm">
              <span className={board.overdue ? 'text-danger font-medium' : 'text-fg-muted'}>
                {board.overdue
                  ? `overdue${board.days_overdue != null ? ` by ${board.days_overdue}d` : ''}`
                  : 'not overdue'}
              </span>
              <span className={board.at_risk ? 'text-warn font-medium' : 'text-fg-muted'}>
                {board.at_risk ? 'at risk' : 'not at risk'}
              </span>
              <span className="text-fg-muted">{board.is_open ? 'open' : 'closed'}</span>
              <span className="text-fg-muted">{board.active_today ? 'on today' : 'not on today'}</span>
              <span className="text-fg-muted">{board.active_tomorrow ? 'on tomorrow' : 'not on tomorrow'}</span>
            </div>
            <ul className="space-y-1">
              {signals.map(signal => (
                <li key={signal.id} className="flex items-baseline gap-2 text-sm">
                  <span className={signal.fired ? 'text-warn' : 'text-fg-faint'}>{signal.fired ? '●' : '○'}</span>
                  <span className={signal.fired ? '' : 'text-fg-faint'}>{signal.label}</span>
                  <span className="text-xs text-fg-muted">{signal.why}</span>
                </li>
              ))}
            </ul>
            {firedSignals.length === 0 && (
              <p className="text-xs text-fg-muted">No risk signal is firing.</p>
            )}
            {board.late_dependency_titles && board.late_dependency_titles.length > 0 && (
              <p className="text-sm text-warn">
                Late predecessors: {board.late_dependency_titles.join(', ')}
              </p>
            )}
            <p className="text-xs text-fg-muted">
              Active window {board.window_start ?? '—'} → {board.window_end ?? '—'} · board&rsquo;s today{' '}
              {board.today ?? '—'} (Europe/Lisbon)
            </p>
          </>
        )}
      </Section>

      <Section title="The task">
        <dl className="grid gap-4 sm:grid-cols-2">
          <Fact label="Description">
            {task.description ? (
              <span className="whitespace-pre-line">{task.description}</span>
            ) : (
              <span className="text-fg-muted">none</span>
            )}
          </Fact>
          <Fact label="Dates">
            start {task.start_date ?? '—'} · due {task.due_date ?? '—'}
            <span className="block text-xs text-fg-muted">
              window_start {board?.window_start ?? '—'} — the view falls back to the creation date when there is no
              start_date
            </span>
          </Fact>
          <Fact label="Duration">
            {task.duration_days != null ? (
              `${task.duration_days} working day${task.duration_days === 1 ? '' : 's'}`
            ) : (
              <span className="text-fg-muted">not set — nullable since 0010, true of every pre-planner task</span>
            )}
          </Fact>
          <Fact label="Materials">
            {task.materials && task.materials.length > 0 ? (
              <ul className="list-inside list-disc">
                {task.materials.map((m, i) => (
                  <li key={`${m}-${i}`}>{m}</li>
                ))}
              </ul>
            ) : (
              <span className="text-fg-muted">none</span>
            )}
          </Fact>
          <Fact label="Completion proof">
            {task.completion_proof === 'photos' && <span className="text-success">photos</span>}
            {task.completion_proof === 'skipped' && (
              <span className="text-warn">skipped — the manager closed it and said so</span>
            )}
            {task.completion_proof == null && (
              <span className="text-fg-muted">
                unknown — NULL means &ldquo;closed some other way&rdquo; (chat, agent, pre-0023). It does NOT mean
                skipped.
              </span>
            )}
            {task.completion_proof != null &&
              task.completion_proof !== 'photos' &&
              task.completion_proof !== 'skipped' && <span>{task.completion_proof}</span>}
          </Fact>
          <Fact label="Photos actually attached">
            {photos.length === 0 ? (
              <span className="text-fg-muted">none</span>
            ) : (
              `${photos.length} photo${photos.length === 1 ? '' : 's'}`
            )}
            <span className="block text-xs text-fg-muted">
              counted at read time, not stamped on the claim — a photo can arrive minutes after one
            </span>
          </Fact>
        </dl>
      </Section>

      <Section title="Obra">
        {job === null ? (
          <p className="text-sm text-fg-muted">
            This task belongs to no obra. Legal — `tasks.job_id` is nullable — and it means every job-derived signal
            above (paused obra, address) has nothing to read.
          </p>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            <Fact label="Name">{job.name}</Fact>
            <Fact label="Status">
              <span className={job.status === 'paused' ? 'text-warn' : job.status === 'done' ? 'text-fg-muted' : ''}>
                {job.status}
              </span>
              {job.status === 'paused' && (
                <span className="block text-xs text-fg-muted">
                  a paused obra keeps its tasks on the board and badges them; it does not hide them
                </span>
              )}
            </Fact>
            <Fact label="Address">
              {job.address ?? <span className="text-fg-muted">none — the 07:00 message has no site to name</span>}
            </Fact>
            <Fact label="Client">{job.client_name ?? <span className="text-fg-muted">none</span>}</Fact>
            <Fact label="Runs">
              {job.starts_on ?? '—'} → {job.ends_on ?? '—'}
            </Fact>
          </dl>
        )}
      </Section>

      <Section
        title="Who is on it"
        hint="The lead comes from tasks.assignee_worker_id, which stays the authoritative answer to whose job this is. The collaborators come from task_assignees through the view's two appended arrays, read by the one function allowed to read them."
      >
        <ul className="space-y-1 text-sm">
          <li>
            <span className="text-xs text-fg-muted">lead</span>{' '}
            {lead ? (
              <>
                {lead.name}
                {lead.trade && <span className="text-xs text-fg-muted"> · {lead.trade}</span>}
                {!lead.active && <span className="text-xs text-danger"> · inactive crew row</span>}
              </>
            ) : (
              <span className="text-fg-muted">unassigned — nobody is briefed about this task at 07:00</span>
            )}
          </li>
          {collaborators.map(worker => (
            <li key={worker.id}>
              <span className="text-xs text-fg-muted">helping</span> {worker.name}
              {worker.trade && <span className="text-xs text-fg-muted"> · {worker.trade}</span>}
              {!worker.active && <span className="text-xs text-danger"> · inactive crew row</span>}
            </li>
          ))}
          {collaborators.length === 0 && (
            <li className="text-fg-muted">No collaborators.</li>
          )}
        </ul>
        {unresolvedCollaboratorIds.length > 0 && (
          <p className="text-sm text-danger">
            The board names {unresolvedCollaboratorIds.length} collaborator id
            {unresolvedCollaboratorIds.length === 1 ? '' : 's'} with no matching workers row in this company:{' '}
            <span className="font-mono text-xs">{unresolvedCollaboratorIds.join(', ')}</span>
          </p>
        )}
        <p className="text-xs text-fg-muted">
          Worth remembering when reading the sends below: the 07:00 briefing goes to everyone on the task, the
          afternoon check-in only to the lead.
        </p>
      </Section>

      <Section
        title="Dependencies"
        hint="Both directions. An edge only has to stay inside the COMPANY, never inside the obra, so a cross-obra link is legal and is flagged rather than hidden."
      >
        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-xs font-semibold text-fg-muted">Waits on ({dependsOn.length})</h3>
            <DependencyTable rows={dependsOn} empty="Waits on nothing." />
          </div>
          <div className="space-y-1">
            <h3 className="text-xs font-semibold text-fg-muted">Blocks ({blocks.length})</h3>
            <DependencyTable rows={blocks} empty="Nothing waits on this." />
          </div>
        </div>
      </Section>

      <Section
        title={`Completion claims (${reviews.length})`}
        hint="A claim is somebody saying the work is finished. It is not the work being finished: the task sits in pending_review, stays open on the board, and still goes overdue until the manager decides."
      >
        {reviews.length === 0 ? (
          <p className="text-sm text-fg-muted">
            Nobody has ever declared this task finished — neither the crew nor the manager.
          </p>
        ) : (
          <div className="space-y-3">
            {pendingReview && (
              <p className="rounded-chip border border-review bg-review-quiet p-3 text-sm">
                A claim is outstanding and nothing expires it. The manager has to approve, reject or dismiss it
                before this task can leave pending_review by the front door.
              </p>
            )}
            {reviews.map(review => (
              <article key={review.id} className="rounded-card border border-hairline p-3">
                <p className="text-xs text-fg-muted">
                  <span className={REVIEW_STATUS_STYLE[review.status] ?? ''}>{review.status}</span>
                  {' · declared '}
                  {formatWhen(review.declaredAt)}
                  {' · by '}
                  {review.declaredByName ??
                    (review.declaredByWorkerId ? review.declaredByWorkerId : 'the manager (no worker attributed)')}
                  {review.resolvedAt && (
                    <>
                      {' · resolved '}
                      {formatWhen(review.resolvedAt)}
                      {' by '}
                      {review.resolvedByName ?? review.resolvedBy ?? 'a trigger — no human resolved it'}
                    </>
                  )}
                </p>
                {review.note ? (
                  // WORKER-AUTHORED TEXT. Rendered as an attributed quote, so
                  // it can never be mistaken for something this portal says.
                  // React escapes it; it is data, and it must never be pasted
                  // onward into anything that treats text as instructions.
                  <figure className="mt-2">
                    <blockquote className="border-l-2 border-review pl-3 text-sm italic whitespace-pre-line">
                      {review.note}
                    </blockquote>
                    <figcaption className="mt-1 pl-3 text-xs text-fg-muted">
                      — {review.declaredByName ?? 'the person who filed this claim'}, in their own words
                    </figcaption>
                  </figure>
                ) : (
                  <p className="mt-2 text-xs text-fg-muted">
                    No note. A check-in button tap carries no text at all, so this is what a tapped claim looks
                    like.
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </Section>

      <Section
        title={`Photos (${photos.length})`}
        hint="The URLs below are signed for a few minutes and minted fresh on every load. `source` is set by the grant layer, not by app code, so a manager cannot manufacture “the crew sent proof”."
      >
        {photoError && (
          <p className="rounded-chip bg-danger-quiet px-3 py-2 text-sm text-danger">
            Photo read or signing failed: <code className="font-mono text-xs">{photoError}</code>
          </p>
        )}
        {photos.length === 0 && !photoError && <p className="text-sm text-fg-muted">No photos on this task.</p>}
        {photos.length > 0 && (
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {photos.map(photo => (
              <PhotoCard key={photo.id} photo={photo} />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={`What was sent about it (${sends.length})`}
        hint="Every notification_log row whose snapshot carried this task. This is the answer to “did the crew ever actually hear about this task”, and this screen is the only place it can be read — the send ledger is deny-all to tenants."
      >
        {sendsError && (
          <p className="rounded-chip bg-danger-quiet px-3 py-2 text-sm text-danger">
            Could not read the send ledger: <code className="font-mono text-xs">{sendsError}</code> — this is a
            failed query, not a task nobody was told about.
          </p>
        )}
        {sends.length === 0 && !sendsError && (
          <p className="text-sm text-fg-muted">
            No send has ever carried this task. Both daily sends read an allowlist of pending/in_progress, so a task
            that is done, cancelled or already claimed is excluded by design — and one whose active window has
            passed is in neither send at all.
          </p>
        )}
        {sends.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-hairline text-xs text-fg-muted">
                  <Th>When</Th>
                  <Th>Kind</Th>
                  <Th>To</Th>
                  <Th>Status</Th>
                  <Th>Delivery</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {sends.map(({ row, recipientName, recipientKind }) => (
                  <tr key={row.id}>
                    <Td className="whitespace-nowrap text-xs text-fg-muted">{formatWhen(row.created_at)}</Td>
                    <Td>{KIND_LABEL[row.kind] ?? row.kind}</Td>
                    <Td>
                      {recipientName ?? row.audience}
                      <span className="block text-xs text-fg-muted">{recipientKind}</span>
                    </Td>
                    <Td className={SEND_STATUS_STYLE[row.status] ?? ''}>{row.status}</Td>
                    <Td className={row.failed_at ? 'text-danger' : 'text-xs text-fg-muted'}>{deliveryState(row)}</Td>
                    <Td className="text-xs text-fg-muted">{row.error ?? row.delivery_error ?? ''}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
