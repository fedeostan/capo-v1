import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ScreenShell } from '@capo/ui/dashboard-ui';
import { TaskDetail } from '@capo/ui/task-detail';
import { loadPendingReviews, loadTaskDetail } from '@/app/dashboard-data';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import ReviewActions from '@/app/(app)/_tasks/review-actions';
import TaskActions from '@/app/(app)/_tasks/task-actions';
import PullToRefresh from '@/app/pull-to-refresh';
import { isUuid } from '../filters';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  if (isUuid(id)) {
    const { ctx } = await requireAuthT();
    const detail = await loadTaskDetail(ctx, id);
    // The task title is tenant data, already in the company language — only the
    // fallback needs translating.
    if (detail) return { title: await metadataTitle(() => detail.task.title) };
  }
  return { title: await metadataTitle(t => t.screens.taskDetail.fallbackTitle) };
}

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Reject a malformed segment before it reaches the DB. A well-formed uuid
  // from another tenant needs no special case — RLS returns nothing and this
  // 404s on the next line, which is exactly what it should look like.
  if (!isUuid(id)) notFound();

  const { ctx, locale } = await requireAuthT();
  const detail = await loadTaskDetail(ctx, id);
  if (!detail) notFound();

  // The board's per-row review lookup, narrowed to this one task. Needed here
  // too: a pending_review task with an active window outside "today" (not
  // overdue, deliberately not at_risk) shows the resolution buttons ONLY
  // under the Todas chip or an exact-date filter — the manager who just
  // requested the check from THIS screen would otherwise have no way back to
  // resolve it from here.
  const review = (await loadPendingReviews(ctx, [detail.task.id])).get(detail.task.id) ?? null;

  const subtitle = [detail.job?.name, detail.job?.address].filter(Boolean).join(' · ') || undefined;

  return (
    <ScreenShell title={detail.task.title} subtitle={subtitle}>
      {/* ScreenShell is overflow-hidden and no longer carries a scroller — the
          caller supplies one. Without this the detail body is silently clipped
          below the fold. */}
      <PullToRefresh locale={locale}>
        <TaskDetail
          task={detail.task}
          job={detail.job}
          worker={detail.worker}
          locale={locale}
          renderActions={() => (
            <>
              <TaskActions taskId={detail.task.id} status={detail.task.status} locale={locale} allowRequestReview />
              {review && (
                <ReviewActions
                  reviewId={review.id}
                  note={review.note}
                  declaredByWorker={review.declaredByWorker}
                  declaredByName={review.declaredByName}
                  locale={locale}
                />
              )}
            </>
          )}
        />
      </PullToRefresh>
    </ScreenShell>
  );
}
