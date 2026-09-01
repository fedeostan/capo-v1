import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { loadObraDetail } from '@/app/dashboard-data';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { ScreenShell, TimelineList } from '@capo/ui/dashboard-ui';
import TaskActions from '@/app/(app)/_tasks/task-actions';
import PullToRefresh from '@/app/pull-to-refresh';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { ctx } = await requireAuthT();
  const detail = await loadObraDetail(ctx, id);
  // The job name is tenant data, already in the company language — only the
  // fallback needs translating.
  if (detail) return { title: await metadataTitle(() => detail.job.name) };
  return { title: await metadataTitle(t => t.screens.jobDetail.fallbackTitle) };
}

export default async function ObraDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, locale, t } = await requireAuthT();
  const detail = await loadObraDetail(ctx, id);
  if (!detail) notFound();

  const done = detail.tasks.filter(task => task.status === 'done').length;
  const total = detail.tasks.length;

  return (
    <ScreenShell
      title={detail.job.name}
      subtitle={[detail.job.address, detail.job.client_name].filter(Boolean).join(' · ') || undefined}
    >
      <PullToRefresh locale={locale}>
        {/* Said on the site's own screen, not only as a badge in the list
            (issue #95): this is where a manager comes to ask "why is nothing
            happening here?", and pausing is the answer often enough that it
            should not have to be inferred from a status word. Quiet styling —
            a paused obra is a decision, not a problem. */}
        {detail.job.status === 'paused' && (
          <p className="rounded-card border border-dashed border-hairline p-3 text-caption text-fg-muted">
            {t.screens.jobDetail.paused}
          </p>
        )}
        <p className="text-caption text-fg-muted">
          {total > 0 ? t.dashboard.tasksDone(done, total) : t.dashboard.noTasksRegistered}
        </p>
        <TimelineList
          tasks={detail.tasks}
          empty={t.screens.jobDetail.empty}
          locale={locale}
          renderExtra={task => <TaskActions taskId={task.id} status={task.status} locale={locale} />}
        />
      </PullToRefresh>
    </ScreenShell>
  );
}
