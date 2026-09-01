import type { Metadata } from 'next';
import type { Catalog } from '@capo/i18n/catalog';
import { EmptyState, ScreenShell } from '@capo/ui/dashboard-ui';
import {
  MEMORY_PROMPT_ROWS,
  MEMORY_READ_LIMIT,
  selectPromptMemories,
} from '@capo/core/memory/prompt';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import PullToRefresh from '@/app/pull-to-refresh';
import { Card } from '../settings-controls';
import { forgetMemory } from './actions';

// Perfil → Memória (issue #48).
//
// ── FEDERICO: why this screen exists ───────────────────────────────────────
// Because from tonight Capo writes things down on its own, at 03:00, without
// anybody asking — and memory a person cannot inspect is a trust problem, not a
// feature. Everything Capo remembers about you and your company is on this page,
// in the order it will be read, with a button that removes it.
//
// It also shows the CAP working. Capo carries only the most recent notes into a
// conversation, and a screen that hid that would make Capo look randomly
// forgetful. Anything past the line is labelled as stored-but-not-carried.

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.memory.title) };
}

/** Europe/Lisbon, always — one clock, the rule the whole product follows. */
function day(iso: string, t: Catalog): string {
  return new Intl.DateTimeFormat(t.meta.dateLocale, {
    timeZone: 'Europe/Lisbon',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}

interface Row {
  id: string;
  kind: string;
  content: string;
  created_at: string;
  profile_id?: string | null;
}

function MemoryItem({ row, carried, t }: { row: Row; carried: boolean; t: Catalog }) {
  // The `kind` catalog is typed Record<…> over 0001's CHECK values, so a kind
  // added to the database without copy in all three dictionaries is a tsc error.
  // A row carrying something outside that set can only come from a hand-edit, so
  // it falls back to the raw value rather than rendering a blank label.
  const kindLabel = t.memory.kind[row.kind as keyof Catalog['memory']['kind']] ?? row.kind;
  return (
    <li className="flex items-start justify-between gap-3 border-t border-hairline pt-3 first:border-0 first:pt-0">
      <div className="min-w-0 space-y-1">
        <p className={carried ? 'text-callout' : 'text-callout text-fg-muted'}>{row.content}</p>
        <p className="text-caption text-fg-muted">
          {kindLabel} · {day(row.created_at, t)}
          {carried ? '' : ` · ${t.memory.storedNotCarried}`}
        </p>
      </div>
      <form action={forgetMemory} className="shrink-0">
        <input type="hidden" name="memoria" value={row.id} />
        <button type="submit" className="text-caption font-medium text-brand underline">
          {t.memory.forget}
        </button>
      </form>
    </li>
  );
}

function Group({
  title,
  hint,
  rows,
  carriedIds,
  t,
}: {
  title: string;
  hint: string;
  rows: Row[];
  carriedIds: Set<string>;
  t: Catalog;
}) {
  return (
    <Card title={title}>
      <p className="text-caption text-fg-muted">{hint}</p>
      {rows.length === 0 ? (
        <p className="text-caption text-fg-muted">{t.memory.empty}</p>
      ) : (
        <ul className="space-y-3">
          {rows.map(row => (
            <MemoryItem key={row.id} row={row} carried={carriedIds.has(row.id)} t={t} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export default async function MemoriaPage({
  searchParams,
}: {
  searchParams: Promise<{ esquecido?: string; erro?: string }>;
}) {
  const { ctx, locale, t } = await requireAuthT();
  const params = await searchParams;

  // `select('*')`, never a column list naming `profile_id`: it is a column 0037
  // adds, and a deploy landing before its migration would 42703 this page
  // instead of degrading. Same rule the prompt builder follows.
  const [{ data: memoryRows }, { data: lastRun }] = await Promise.all([
    ctx.db
      .from('memories')
      .select('*')
      .eq('company_id', ctx.companyId)
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(MEMORY_READ_LIMIT),
    // The night shift's liveness signal. Degrades to "never reviewed" rather
    // than throwing, because this table may not exist yet on a deploy that
    // landed ahead of 0037 — and a missing background job must not take the
    // whole screen down.
    ctx.db
      .from('memory_consolidations')
      .select('completed_at, status')
      .eq('company_id', ctx.companyId)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const rows = (memoryRows ?? []) as Row[];

  // The same function the prompt builder calls, on the same rows, with the same
  // reader — so what this page marks as "carried" is what Capo actually reads,
  // rather than a second guess at the rule.
  const { carried } = selectPromptMemories(rows, ctx.userId);
  const carriedIds = new Set(carried.map(row => row.id));

  const company = rows.filter(row => (row.profile_id ?? null) === null);
  const personal = rows.filter(row => (row.profile_id ?? null) === ctx.userId);

  return (
    <PullToRefresh locale={locale}>
      <ScreenShell title={t.memory.title} subtitle={t.memory.subtitle}>
        {params.esquecido && (
          <p className="rounded-lg bg-success-quiet px-3 py-2 text-center text-callout text-success">
            {t.memory.forgotten}
          </p>
        )}
        {params.erro && (
          <p className="rounded-lg bg-danger-quiet px-3 py-2 text-center text-callout text-danger">
            {t.memory.forgetFailed}
          </p>
        )}

        <p className="text-callout text-fg-muted">{t.memory.explainer}</p>

        {rows.length === 0 ? (
          <EmptyState text={t.memory.empty} />
        ) : (
          <>
            <Group
              title={t.memory.companyHeading}
              hint={t.memory.companyHint}
              rows={company}
              carriedIds={carriedIds}
              t={t}
            />
            <Group
              title={t.memory.personalHeading}
              hint={t.memory.personalHint}
              rows={personal}
              carriedIds={carriedIds}
              t={t}
            />
            <Card title={t.memory.capTitle}>
              <p className="text-caption text-fg-muted">
                {t.memory.capHint(carried.length, MEMORY_PROMPT_ROWS)}
              </p>
              <p className="text-caption text-fg-muted">{t.memory.forgetNote}</p>
            </Card>
          </>
        )}

        <Card title={t.memory.reviewTitle}>
          <p className="text-callout">
            {lastRun?.completed_at
              ? t.memory.lastReviewed(day(lastRun.completed_at, t))
              : t.memory.neverReviewed}
          </p>
          <p className="text-caption text-fg-muted">{t.memory.reviewHint}</p>
        </Card>
      </ScreenShell>
    </PullToRefresh>
  );
}
