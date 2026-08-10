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

/**
 * One photo attached to the task. `url` is a short-lived signed URL minted by
 * the caller on this request — this component must never cache it, and the
 * page that renders it has to be dynamic. See loadTaskPhotos in
 * apps/web/app/dashboard-data.ts.
 */
export interface TaskDetailPhoto {
  id: string;
  url: string;
  /** 'worker' or 'manager'. Attribution, not decoration: a photo the crew sent
   *  and a photo the manager took are different claims about the same work. */
  source: string;
  createdAt: string;
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
  photos,
  locale,
  renderActions,
}: {
  task: BoardTask;
  job: TaskDetailJob | null;
  worker: TaskDetailWorker | null;
  /** Proof of the work, newest first. Empty is the normal case and renders
   *  nothing at all — an "no photos yet" placeholder on every task would turn
   *  an optional feature into a standing reproach. */
  photos?: TaskDetailPhoto[];
  locale: Locale;
  /** Concluir/Reabrir today; the reminder card joins it in phase 2. */
  renderActions?: () => React.ReactNode;
}) {
  const catalog = getCatalog(locale);
  const t = catalog.screens.taskDetail;
  // The photo copy lives under its own key rather than inside taskDetail's,
  // because the completion sheet in apps/web reads the same strings — the
  // section heading and the two source labels have to agree with the sheet
  // that produced the photos.
  const photoCopy = catalog.screens.taskPhotos;
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

      {photos && photos.length > 0 && (
        <Section title={photoCopy.sectionTitle}>
          <ul className="grid grid-cols-3 gap-2">
            {photos.map(photo => {
              const label =
                photo.source === 'worker' ? photoCopy.sourceWorker : photoCopy.sourceManager;
              return (
                <li key={photo.id}>
                  {/* Opens the full image in a new tab. The signed URL is
                      already in this page's HTML, so the link adds no exposure
                      — but it does expire, which is why the page is dynamic
                      and the manager gets a fresh one on every visit. */}
                  <a href={photo.url} target="_blank" rel="noopener noreferrer">
                    {/* Plain <img>, not next/image: @capo/ui is framework-
                        agnostic presentation with no next dependency (which is
                        also why there is no eslint-disable for
                        @next/next/no-img-element here — this package lints
                        under the library preset, where that rule does not
                        exist and naming it is itself an error). A per-request
                        signed URL on a Storage host is exactly what the image
                        optimizer cannot cache anyway. */}
                    <img
                      src={photo.url}
                      // slice(0, 10), and it is load-bearing: formatShortDate
                      // takes a DATE, not a timestamp — it builds
                      // `new Date(`${iso}T00:00:00Z`)` to pin the result to
                      // UTC, so a full created_at produces an Invalid Date and
                      // Intl.DateTimeFormat.format THROWS on it. Every other
                      // caller passes start_date/due_date, which are already
                      // date-only; this is the first timestamp column to reach
                      // it. Both are `string`, so nothing but this comment
                      // stands between the next caller and a crashed screen.
                      alt={`${label} · ${formatShortDate(photo.createdAt.slice(0, 10), locale)}`}
                      loading="lazy"
                      className="aspect-square w-full rounded-lg object-cover"
                    />
                  </a>
                  <p className="mt-0.5 text-[11px] text-zinc-500">{label}</p>
                </li>
              );
            })}
          </ul>
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
