import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getCatalog } from '@capo/i18n/catalog';
import { formatShortDate, ScreenShell } from '@capo/ui/dashboard-ui';
import { TaskDetail } from '@capo/ui/task-detail';
import {
  loadAssignableWorkers,
  loadPendingReviews,
  loadTaskDetail,
  loadTaskPhotos,
} from '@/app/dashboard-data';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import MaterialsEditor from '@/app/(app)/_tasks/materials-editor';
import ReviewActions from '@/app/(app)/_tasks/review-actions';
import TaskActions from '@/app/(app)/_tasks/task-actions';
import PullToRefresh from '@/app/pull-to-refresh';
import { isUuid } from '../filters';
import AssigneePicker from './assignee-picker';

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
  // overdue, and at_risk only if risk_late_dependency or risk_paused_job
  // fires — risk_late_start/risk_due_soon are pending-only allowlists that
  // never do) shows the resolution buttons ONLY under the Todas chip or an
  // exact-date filter — the manager who just requested the check from THIS
  // screen would otherwise have no way back to resolve it from here.
  // Both reads are per-request and neither may be cached: loadTaskPhotos mints
  // signed URLs, which is the reason `export const dynamic = 'force-dynamic'`
  // above is now load-bearing rather than merely tidy.
  //
  // The third read is the worker picker's roster. It is loaded with the page
  // rather than fetched when the sheet opens: the crew of a construction
  // company is tens of rows, not thousands, and a picker that spins before it
  // can answer "who is free" is a picker the manager taps twice.
  const [review, photos, assignable] = await Promise.all([
    loadPendingReviews(ctx, [detail.task.id]).then(m => m.get(detail.task.id) ?? null),
    loadTaskPhotos(ctx, detail.task.id),
    loadAssignableWorkers(ctx, detail.task),
  ]);

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
          photos={photos}
          locale={locale}
          renderAssignee={() => (
            <AssigneePicker
              taskId={detail.task.id}
              currentWorkerId={detail.task.assignee_worker_id}
              currentWorkerName={detail.worker?.name ?? null}
              workers={assignable.workers}
              // Formatted here, on the server: formatShortDate lives in
              // @capo/ui/dashboard-ui and pulling that module into a client
              // component would drag the whole board with it.
              dateLabel={assignable.date ? formatShortDate(assignable.date, locale) : null}
              locale={locale}
            />
          )}
          // One candidate task by definition, so the editor opens straight on
          // the list instead of asking which task it is for.
          renderMaterials={() => (
            <MaterialsEditor
              tasks={[
                {
                  id: detail.task.id,
                  title: detail.task.title,
                  materials: detail.task.materials ?? [],
                },
              ]}
              label={getCatalog(locale).screens.materialsEdit.edit}
              locale={locale}
            />
          )}
          renderActions={() => (
            <>
              <TaskActions taskId={detail.task.id} status={detail.task.status} locale={locale} allowRequestReview />
              {review && (
                <ReviewActions
                  reviewId={review.id}
                  note={review.note}
                  declaredByWorker={review.declaredByWorker}
                  declaredByName={review.declaredByName}
                  photoCount={review.photoCount}
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
