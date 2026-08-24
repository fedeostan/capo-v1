import { notFound } from 'next/navigation';
import { AppBar } from '@capo/ui/app-bar';
import { Badge } from '@capo/ui/badge';
import { Card } from '@capo/ui/card';
import { MaterialsList, StatusBadge } from '@capo/ui/dashboard-ui';
import { EmptyState } from '@capo/ui/empty-state';
import { ListRow } from '@capo/ui/list-row';
import { Skeleton } from '@capo/ui/skeleton';
import { getCatalog } from '@capo/i18n/catalog';
import { DEFAULT_LOCALE } from '@capo/i18n/locale';
import { ShellCases } from './shell-cases';
import {
  EMPTY_BOARD,
  LONG_TITLE_BOARD,
  NORMAL_BOARD,
  NO_WORKER_BOARD,
  OVERDUE_AND_REVIEW_BOARD,
  SEVEN_OBRA_MATERIALS,
  type TaskBoardRow,
} from '../fixtures';

// Real screen components, fake data, no login. The manager's dashboard reads
// live rows — a chat message, a WhatsApp reply, a cron — so a before/after
// screenshot of it is comparing two different DAYS, not two different
// LAYOUTS. This route freezes the data so the only thing that can change
// between two screenshots is the design.
//
// Dev-only, same posture as /design-system (Task 13): notFound() rather than a
// redirect, because a redirect announces that the route exists.
export const dynamic = 'force-dynamic';

const t = getCatalog(DEFAULT_LOCALE);

// A local heading wrapper, not shared with /design-system/page.tsx. Six duplicated
// lines in two development-only routes is correct here — see the task brief.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-hairline pt-6">
      <h2 className="text-heading font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}

// task_board types every column nullable (it is a view), so the meta line
// falls back exactly the way TaskBoardList does: no obra reads as "sem
// obra", no assignee reads as "sem responsável".
function taskMeta(task: TaskBoardRow): string {
  const obra = task.job_name ?? t.dashboard.noJob;
  const assignee = task.worker_name ? t.dashboard.assignedTo(task.worker_name) : t.dashboard.noAssignee;
  return `${assignee} · ${obra}`;
}

function TaskRow({ task }: { task: TaskBoardRow }) {
  return (
    <ListRow
      title={task.title ?? ''}
      meta={taskMeta(task)}
      danger={task.overdue ?? false}
      trailing={
        <div className="flex items-center gap-2">
          {task.overdue && <Badge tone="danger">{t.dashboard.overdueBy(task.days_overdue ?? 0)}</Badge>}
          <StatusBadge status={task.status} locale={DEFAULT_LOCALE} showPending />
        </div>
      }
    />
  );
}

export default function DesignScreens() {
  if (process.env.NODE_ENV === 'production') notFound();

  return (
    <div className="mx-auto flex h-dvh w-full max-w-2xl flex-col overflow-y-auto bg-bg">
      <AppBar title="Real screens, fake data" subtitle="/design-system/screens — dev only" />
      <div className="flex flex-col gap-6 p-4">
        <Section title="1. Normal task board — five tasks, mixed statuses">
          <Card padding="none">
            <div className="divide-y divide-hairline">
              {NORMAL_BOARD.map(task => (
                <TaskRow key={task.id ?? ''} task={task} />
              ))}
            </div>
          </Card>
        </Section>

        <Section title="2. Empty board">
          <Card padding="none">
            {EMPTY_BOARD.length === 0 && (
              <EmptyState
                title="Nada por fazer"
                body="Quando criares tarefas para esta obra, aparecem aqui."
              />
            )}
          </Card>
        </Section>

        <Section title="3. One overdue task and one pending_review">
          <Card padding="none">
            <div className="divide-y divide-hairline">
              {OVERDUE_AND_REVIEW_BOARD.map(task => (
                <TaskRow key={task.id ?? ''} task={task} />
              ))}
            </div>
          </Card>
        </Section>

        <Section title="4. A 90-character title (truncation check)">
          <Card padding="none">
            <div className="divide-y divide-hairline">
              {LONG_TITLE_BOARD.map(task => (
                <TaskRow key={task.id ?? ''} task={task} />
              ))}
            </div>
          </Card>
        </Section>

        <Section title="5. A worker with no name (null) on a row">
          <Card padding="none">
            <div className="divide-y divide-hairline">
              {NO_WORKER_BOARD.map(task => (
                <TaskRow key={task.id ?? ''} task={task} />
              ))}
            </div>
          </Card>
        </Section>

        <Section title="6. Loading board (skeletons)">
          <Card>
            <Skeleton variant="row" count={5} />
          </Card>
        </Section>

        <Section title="7. Materials list — seven obra groups (collapses above 3)">
          <MaterialsList
            groups={SEVEN_OBRA_MATERIALS}
            empty={t.screens.materials.emptyTomorrow}
            noJobLabel={t.dashboard.noJob}
            forLabel={t.screens.materials.forTasks}
            countLabel={t.screens.materialsEdit.groupCount}
            emptyGroupLabel={t.screens.materialsEdit.groupEmpty}
            seeJobLabel={t.screens.materialsEdit.seeJob}
          />
        </Section>

        {/* The Round 1 shell. These four are the cases the handoff's
            screenshots do not cover, and each is one that actually breaks:
            a company name long enough to fight the 44px targets beside it,
            the drawer at the narrowest phone width we support, its five rows,
            and the delete sheet's permanently-disabled confirm. */}
        <ShellCases />
      </div>
    </div>
  );
}
