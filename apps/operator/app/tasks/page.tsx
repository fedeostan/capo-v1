import Link from 'next/link';
import { TASKS_PER_COMPANY, TASK_STATUSES, loadTaskListing, taskWasTouched } from '../data';

// Reads the DB (service role, lazy env) per request — must never be
// prerendered at build time, when those secrets don't exist.
export const dynamic = 'force-dynamic';

// The Tasks list (issue #155). Three things changed here and only the first is
// visible at a glance:
//
//  1. `created at` is on the row. It is what separates a task made during
//     onboarding from one made this morning, which is the difference between a
//     tenant that is using Capo and one that was seeded once and abandoned.
//  2. The read is capped PER COMPANY and says so when the cap bites. It used
//     to be 500 rows across the whole estate, grouped afterwards — so the
//     oldest-created companies rendered as "No tasks." See TASKS_PER_COMPANY.
//  3. The filters live in the URL, not in component state, so a filtered view
//     is a link somebody can paste into a thread. The form is a plain GET with
//     a submit button: no client JavaScript in this app, and a <select> with
//     no onChange needs something to submit it.
//
// Colours here are still the raw palette rather than the design tokens, on
// purpose: this file is one of the entries in design-check's UNCONVERTED
// ledger, that ledger fails on a STALE entry as loudly as on a new violation,
// and the entry lives in scripts/, which this change does not own. Its
// converting is a design-sweep task, not a data-defect one. The task DETAIL
// page below it is on tokens from the start, exactly as /reports is.

const STATUS_STYLES: Record<string, string> = {
  pending: 'text-zinc-500',
  in_progress: 'text-sky-400',
  pending_review: 'text-violet-400',
  blocked: 'text-amber-400',
  done: 'text-emerald-400',
  cancelled: 'text-zinc-500 line-through',
};

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Lisbon',
  });
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`py-1.5 pr-3 font-normal ${className}`}>{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-1.5 pr-3 align-top ${className}`}>{children}</td>;
}

export default async function TasksPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise and has to be awaited.
  searchParams: Promise<{ company?: string; status?: string }>;
}) {
  const { company: companyParam, status: statusParam } = await searchParams;

  // Both filters are validated against a known set before they reach a query.
  // An unknown status would otherwise return nothing for every company and read
  // exactly like an empty estate, which is the failure this whole screen exists
  // to stop being possible.
  const status = TASK_STATUSES.find(s => s === statusParam);
  const { groups, companies, companiesError, anyTruncated } = await loadTaskListing({
    companyId: companyParam || undefined,
    status,
  });
  const selectedCompany = companies.find(c => c.id === companyParam);
  const filtered = Boolean(selectedCompany) || Boolean(status);
  const shown = groups.reduce((n, g) => n + g.tasks.length, 0);
  const matching = groups.reduce((n, g) => n + g.matching, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold">Tasks — all companies</h1>
        <span className="text-xs text-zinc-500">
          {shown === matching
            ? `${matching} task${matching === 1 ? '' : 's'}`
            : `showing ${shown} of ${matching}`}
          {' · newest first'}
        </span>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">Company</span>
          <select
            name="company"
            defaultValue={companyParam ?? ''}
            className="rounded border border-zinc-500/30 bg-transparent px-2 py-1"
          >
            <option value="">All companies</option>
            {companies.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">Status</span>
          <select
            name="status"
            defaultValue={status ?? ''}
            className="rounded border border-zinc-500/30 bg-transparent px-2 py-1"
          >
            <option value="">All statuses</option>
            {TASK_STATUSES.map(s => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded border border-zinc-500/30 px-3 py-1 hover:bg-zinc-500/10">
          Apply
        </button>
        {filtered && (
          <Link href="/tasks" className="pb-1 text-xs text-zinc-500 underline hover:text-zinc-800">
            Clear
          </Link>
        )}
      </form>

      {anyTruncated && (
        <p className="rounded border border-amber-500/40 px-3 py-2 text-xs text-amber-600">
          At least one company has more tasks than this screen reads ({TASKS_PER_COMPANY} per company). The counts
          beside each company name are the real totals — filter by company or by status to see the rest. A cap is
          stated here rather than left silent because a silently short list reads exactly like an empty tenant.
        </p>
      )}

      {companiesError && (
        <p className="text-sm text-red-500">
          Could not read the company list: <code className="font-mono text-xs">{companiesError}</code> — nothing
          below is trustworthy. This is a failed query, not an empty estate.
        </p>
      )}

      {!companiesError && groups.length === 0 && (
        <p className="text-sm text-zinc-500">No companies match this filter.</p>
      )}

      {groups.map(({ company, tasks, matching: companyMatching, truncated, error }) => (
        <section key={company.id} className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold">
              <Link href={`/companies/${company.id}`} className="hover:underline">
                {company.name}
              </Link>
            </h2>
            <span className="text-xs text-zinc-500">
              {truncated
                ? `showing ${tasks.length} of ${companyMatching} — capped at ${TASKS_PER_COMPANY}`
                : `${companyMatching} task${companyMatching === 1 ? '' : 's'}`}
            </span>
          </div>

          {error && (
            <p className="text-sm text-red-500">
              Could not read this company&rsquo;s tasks: <code className="font-mono text-xs">{error}</code>
            </p>
          )}
          {!error && tasks.length === 0 && (
            <p className="text-sm text-zinc-500">
              {status || companyParam ? 'No tasks match this filter.' : 'No tasks.'}
            </p>
          )}

          {tasks.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-500/20 text-xs text-zinc-500">
                    <Th className="w-24">Status</Th>
                    <Th>Task</Th>
                    <Th>Obra</Th>
                    <Th>Lead</Th>
                    <Th className="whitespace-nowrap">Created</Th>
                    <Th className="whitespace-nowrap">Last moved</Th>
                    <Th className="whitespace-nowrap">Due</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-500/10">
                  {tasks.map(task => {
                    const touched = taskWasTouched(task);
                    return (
                      <tr key={task.id}>
                        <Td className={`text-xs ${STATUS_STYLES[task.status] ?? 'text-zinc-500'}`}>
                          {task.status.replace('_', ' ')}
                        </Td>
                        <Td>
                          <Link href={`/tasks/${task.id}`} className="underline decoration-zinc-500/40 hover:decoration-current">
                            {task.title}
                          </Link>
                        </Td>
                        <Td className="text-xs text-zinc-500">{task.jobs?.name ?? '—'}</Td>
                        <Td className="text-xs text-zinc-500">{task.workers?.name ?? 'unassigned'}</Td>
                        <Td className="whitespace-nowrap text-xs text-zinc-500">{formatWhen(task.created_at)}</Td>
                        <Td className="whitespace-nowrap text-xs">
                          {touched ? (
                            <span className="text-zinc-500">{formatWhen(task.updated_at)}</span>
                          ) : (
                            // Not "—": an empty cell reads as missing data. This
                            // is a fact about the task — nothing has touched it
                            // since the moment it was made.
                            <span className="text-zinc-500 italic">never moved</span>
                          )}
                        </Td>
                        <Td className="whitespace-nowrap text-xs text-zinc-500">{task.due_date ?? '—'}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
