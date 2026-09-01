import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { searchKnowledgeChunks, type KnowledgeHit } from '@capo/core/knowledge';
import { EmptyState, ScreenShell } from '@capo/ui/dashboard-ui';
import { Badge } from '@capo/ui/badge';
import { Card } from '@capo/ui/card';
import { loadTaskDetail } from '@/app/dashboard-data';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import PullToRefresh from '@/app/pull-to-refresh';
import { isUuid } from '../../filters';

export const dynamic = 'force-dynamic';

// Its OWN route rather than a section of the detail screen, because every open
// costs a Gemini embedding call. Every screen here is force-dynamic, so nothing
// caches — putting this behind a tap is not an optimisation, it is the only way
// the detail page stays free to open.
export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.screens.taskHelp.title) };
}

function Hit({ hit, categoryLabel }: { hit: KnowledgeHit; categoryLabel: string }) {
  return (
    <li className="space-y-1 p-3">
      <p className="flex flex-wrap items-center gap-2 text-caption font-medium text-fg-muted">
        <Badge>{categoryLabel}</Badge>
        <span>{hit.source}</span>
      </p>
      <p className="text-callout leading-relaxed text-fg">{hit.content}</p>
      {hit.sourceRef && <p className="text-caption text-fg-faint">{hit.sourceRef}</p>}
    </li>
  );
}

export default async function TaskHelpPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const { ctx, locale, t } = await requireAuthT();
  const detail = await loadTaskDetail(ctx, id);
  if (!detail) notFound();

  const copy = t.screens.taskHelp;
  const { task } = detail;

  // The corpus is Portuguese and the RPC's full-text half ranks with
  // websearch_to_tsquery('portuguese', …). The query is built from stored task
  // text, which is in companies.language — a Spanish tenant therefore gets the
  // embedding half only. Degraded ranking, not a failure.
  const query = [task.title, task.description].filter(Boolean).join('. ');

  let hits: KnowledgeHit[] | null = null;
  try {
    hits = await searchKnowledgeChunks(ctx.db, query);
  } catch {
    // An embedding provider outage must not take the screen down — say so and
    // leave the manager a way back.
    hits = null;
  }

  return (
    <ScreenShell title={copy.title} subtitle={task.title}>
      {/* ScreenShell is overflow-hidden and no longer carries a scroller — the
          caller supplies one. A long list of excerpts is exactly the content
          that would otherwise be clipped below the fold. */}
      <PullToRefresh locale={locale}>
        <a
          href={`/tarefas/${task.id}`}
          className="inline-flex min-h-11 items-center text-caption text-fg-muted underline"
        >
          {copy.backToTask}
        </a>

        {hits === null ? (
          <EmptyState text={copy.failed} />
        ) : hits.length === 0 ? (
          <EmptyState text={copy.empty} />
        ) : (
          <>
            <p className="text-caption text-fg-muted">{copy.intro}</p>
            <Card padding="none">
              <ul className="divide-y divide-hairline">
                {hits.map(hit => (
                  <Hit
                    key={hit.chunkId}
                    hit={hit}
                    categoryLabel={copy.category[hit.category as keyof typeof copy.category] ?? hit.category}
                  />
                ))}
              </ul>
            </Card>
          </>
        )}
      </PullToRefresh>
    </ScreenShell>
  );
}
