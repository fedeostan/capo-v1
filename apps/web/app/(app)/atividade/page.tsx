import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@capo/ui/card';
import { EmptyState } from '@capo/ui/empty-state';
import type { Catalog } from '@capo/i18n/catalog';
import { loadToday } from '@/app/dashboard-data';
import { loadActivity, type ActivityEvent } from '@/app/activity/feed';
import { activitySentence, activityTime, groupByDay } from '@/app/activity/render';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { TabScreen } from '@/app/_ui/tab-screen';
import PullToRefresh from '@/app/pull-to-refresh';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.activity.title) };
}

// One row. A fixed time column on the left and the sentence on the right, so
// the times line up down the page and the eye can scan for "when" without
// reading every line — the shape the handoff drew, and the reason it drew it.
function Row({ event, t }: { event: ActivityEvent; t: Catalog }) {
  const body = (
    <div className="flex gap-3 py-3">
      <span className="w-10 shrink-0 pt-px text-micro tabular-nums text-fg-faint">
        {activityTime(event.at, t)}
      </span>
      <span className="min-w-0 flex-1 text-callout text-fg">
        {activitySentence(event, t)}
        {event.jobName && <span className="text-fg-muted"> · {event.jobName}</span>}
      </span>
    </div>
  );
  // Linked only when there is a task to open. A check-in answer is about a
  // person and a day, not a task, so linking it somewhere arbitrary would be
  // worse than leaving it inert.
  return event.taskId ? (
    <Link
      href={`/tarefas/${event.taskId}`}
      className="block border-b border-hairline px-4 no-underline last:border-b-0 hover:bg-surface-hover"
    >
      {body}
    </Link>
  ) : (
    <div className="border-b border-hairline px-4 last:border-b-0">{body}</div>
  );
}

// The Atividade tab. It answers "what happened while I was not looking", which
// is a different question from /notificacoes' "what needs me" — the inbox is
// addressed TO the manager and is markable as read; this is a record of the
// site and is never read or unread.
export default async function AtividadePage() {
  const { ctx, locale, t } = await requireAuthT();
  const [events, today] = await Promise.all([loadActivity(ctx, 60), loadToday(ctx)]);
  const days = groupByDay(events, today, t);

  return (
    <TabScreen title={t.activity.title} subtitle={t.activity.subtitle}>
      <PullToRefresh locale={locale}>
        {days.length === 0 ? (
          <EmptyState title={t.activity.empty} />
        ) : (
          <div className="flex flex-col gap-4">
            {days.map(day => (
              <section key={day.label} className="flex flex-col gap-2">
                <h2 className="px-1 text-caption font-semibold text-fg-muted">{day.label}</h2>
                <Card padding="none">
                  {day.events.map(event => (
                    <Row key={event.id} event={event} t={t} />
                  ))}
                </Card>
              </section>
            ))}
          </div>
        )}
      </PullToRefresh>
    </TabScreen>
  );
}
