import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { searchKnowledgeChunks, type KnowledgeHit } from '@capo/core/knowledge';
import { EmptyState, ScreenShell } from '@capo/ui/dashboard-ui';
import { loadTaskDetail } from '@/app/dashboard-data';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
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
      <p className="text-xs font-medium text-zinc-500">
        <span className="rounded-full bg-zinc-500/10 px-2 py-0.5">{categoryLabel}</span>
        <span className="ml-2">{hit.source}</span>
      </p>
      <p className="text-sm leading-relaxed">{hit.content}</p>
      {hit.sourceRef && <p className="text-[11px] text-zinc-500">{hit.sourceRef}</p>}
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
      <a href={`/tarefas/${task.id}`} className="text-xs text-zinc-500 underline">
        {copy.backToTask}
      </a>

      {hits === null ? (
        <EmptyState text={copy.failed} />
      ) : hits.length === 0 ? (
        <EmptyState text={copy.empty} />
      ) : (
        <>
          <p className="text-xs text-zinc-500">{copy.intro}</p>
          <ul className="divide-y divide-zinc-500/15 rounded-xl border border-zinc-500/20">
            {hits.map(hit => (
              <Hit
                key={hit.chunkId}
                hit={hit}
                categoryLabel={copy.category[hit.category as keyof typeof copy.category] ?? hit.category}
              />
            ))}
          </ul>
        </>
      )}
    </ScreenShell>
  );
}
