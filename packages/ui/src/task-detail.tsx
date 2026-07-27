// The task detail screen body. Same contract as dashboard-ui.tsx: no buttons,
// no forms, no mutations — the manager's actions arrive through the
// `renderActions` slot, injected by apps/web.
//
// Its own module rather than another section of dashboard-ui.tsx for one
// concrete reason: it renders `./markdown`, which is a 'use client' component.
// Importing that from dashboard-ui.tsx would pull react-markdown into the
// client bundle of every screen that shows a board or an obra list.
//
// Row shapes are declared locally (like TimelineTask) so @capo/ui stays a pure
// presentation package with no @capo/core dependency and no view types.
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import Markdown from './markdown';
import { type BoardTask, formatShortDate, riskReasons, StatusBadge } from './dashboard-ui';

export interface TaskDetailJob {
  id: string;
  name: string;
  address: string | null;
  client_name: string | null;
  status: string;
}

export interface TaskDetailWorker {
  id: string;
  name: string;
  trade: string | null;
  phone: string | null;
  active: boolean;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
      {children}
    </section>
  );
}

function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map(item => (
        <span key={item} className="rounded-full bg-zinc-500/10 px-2 py-0.5 text-[11px] text-zinc-500">
          {item}
        </span>
      ))}
    </div>
  );
}

export function TaskDetail({
  task,
  job,
  worker,
  locale,
  renderActions,
}: {
  task: BoardTask;
  job: TaskDetailJob | null;
  worker: TaskDetailWorker | null;
  locale: Locale;
  /** Concluir/Reabrir today; the reminder card joins it in phase 2. */
  renderActions?: () => React.ReactNode;
}) {
  const catalog = getCatalog(locale);
  const t = catalog.screens.taskDetail;
  const dash = catalog.dashboard;
  const reasons = riskReasons(task, locale);

  // The assignee line has to explain ITSELF, not just name someone: an active
  // worker with no phone silently receives nothing at 07:00 and cannot be sent
  // a reminder — the same failure /perfil already warns about on the crew card.
  const workerNotes = worker
    ? [worker.trade, !worker.active ? t.assigneeInactive : null, !worker.phone ? t.assigneeNoPhone : null].filter(
        Boolean,
      )
    : [];

  const dates = [
    task.start_date ? `${t.startDate}: ${formatShortDate(task.start_date, locale)}` : null,
    task.due_date ? `${t.dueDate}: ${formatShortDate(task.due_date, locale)}` : null,
    task.duration_days ? t.durationDays(task.duration_days) : null,
  ].filter(Boolean) as string[];

  return (
    <>
      <a href="/tarefas" className="text-xs text-zinc-500 underline">
        {t.backToTasks}
      </a>

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={task.status} locale={locale} showPending />
        {job && (
          <a href={`/obras/${job.id}`} className="text-xs text-zinc-500 underline">
            {job.name}
          </a>
        )}
      </div>

      {reasons.length > 0 && (
        <p className={`text-sm ${task.overdue ? 'font-medium text-red-600' : 'text-amber-600'}`}>
          {reasons.join(' · ')}
        </p>
      )}

      <Section title={t.assignee}>
        <p className="text-sm">{worker ? worker.name : dash.noAssignee}</p>
        {workerNotes.length > 0 && <p className="text-xs text-zinc-500">{workerNotes.join(' · ')}</p>}
      </Section>

      {dates.length > 0 && (
        <Section title={t.dates}>
          <p className="text-sm">{dates.join(' · ')}</p>
        </Section>
      )}

      <Section title={t.description}>
        {task.description ? (
          // Rendered as markdown so a description written as "1. …" or "- …"
          // — which is what the planner prompt asks for — becomes a real
          // step-by-step list, with no second column to keep in sync.
          <div className="text-sm">
            <Markdown text={task.description} />
          </div>
        ) : (
          <p className="text-sm text-zinc-500">{t.noDescription}</p>
        )}
      </Section>

      {task.materials && task.materials.length > 0 && (
        <Section title={t.materials}>
          <Chips items={task.materials} />
        </Section>
      )}

      {task.depends_on_titles.length > 0 && (
        <p className="text-xs text-zinc-500">{dash.dependsOn(task.depends_on_titles)}</p>
      )}

      <Section title={t.help}>
        <ul className="divide-y divide-zinc-500/15 rounded-xl border border-zinc-500/20">
          <li>
            <a
              className="block p-3 text-sm hover:bg-zinc-500/5"
              href={`/tarefas/${task.id}/ajuda`}
            >
              {t.knowledge}
              <span className="block text-xs text-zinc-500">{t.knowledgeHint}</span>
            </a>
          </li>
          <li>
            {/* Prefills the composer; it does not send. The manager reads what
                is about to go out in his name — the same rule as the mic. */}
            <a
              className="block p-3 text-sm hover:bg-zinc-500/5"
              href={`/?q=${encodeURIComponent(t.askCapoPrompt(task.title))}`}
            >
              {t.askCapo}
            </a>
          </li>
        </ul>
      </Section>

      {renderActions && <div className="pt-2">{renderActions()}</div>}
    </>
  );
}
