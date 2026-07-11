import { loadTasksByCompany } from '../data';

export const dynamic = 'force-dynamic';

const STATUS_STYLES: Record<string, string> = {
  pending: 'text-zinc-400',
  in_progress: 'text-sky-400',
  blocked: 'text-amber-400',
  done: 'text-emerald-400',
  cancelled: 'text-zinc-600 line-through',
};

export default async function TasksPage() {
  const grouped = await loadTasksByCompany();

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Tasks — all companies</h1>
      {grouped.map(({ company, tasks }) => (
        <section key={company.id} className="space-y-2">
          <h2 className="font-semibold">{company.name}</h2>
          {tasks.length === 0 && <p className="text-sm text-zinc-500">No tasks.</p>}
          <ul className="divide-y divide-zinc-500/10 text-sm">
            {tasks.map(task => (
              <li key={task.id} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
                <span className={`w-24 shrink-0 text-xs ${STATUS_STYLES[task.status] ?? 'text-zinc-400'}`}>
                  {task.status.replace('_', ' ')}
                </span>
                <span className="min-w-0 flex-1">{task.title}</span>
                <span className="text-xs text-zinc-500">
                  {task.jobs?.name ?? '—'}
                  {task.workers?.name ? ` · ${task.workers.name}` : ''}
                  {task.due_date ? ` · due ${task.due_date}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
