'use client';

// The obra picker and the specific-day picker. The only client component on
// this screen, and it deliberately does NOT call useSearchParams: the current
// filters arrive as props from the server page, so there is no Suspense
// boundary to get wrong and no `next build` bailout to work around.
//
// Native <select>/<input type="date"> on purpose — on iOS and Android the
// platform renders them as its own picker sheet, which is the bottom sheet we
// wanted, for free and accessible.
import { useRouter } from 'next/navigation';
import { buildHref, isIsoDate, type TarefasFilters } from './filters';
import type { ObraOption } from '@/app/dashboard-data';

const CONTROL = 'min-w-0 flex-1 rounded-lg border border-zinc-500/30 bg-transparent px-2 py-1.5 text-xs';

export default function FilterControls({
  filters,
  obras,
}: {
  filters: TarefasFilters;
  obras: ObraOption[];
}) {
  const router = useRouter();

  return (
    <div className="flex gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="sr-only">Filtrar por obra</span>
        <select
          className={CONTROL}
          value={filters.obraId ?? ''}
          onChange={e => router.push(buildHref({ ...filters, obraId: e.target.value || null }))}
        >
          <option value="">Todas as obras</option>
          {obras.map(obra => (
            <option key={obra.id} value={obra.id}>
              {obra.name}
              {obra.status === 'paused' ? ' (pausada)' : obra.status === 'done' ? ' (terminada)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="sr-only">Filtrar por dia</span>
        <input
          type="date"
          className={CONTROL}
          value={filters.quando.kind === 'date' ? filters.quando.iso : ''}
          onChange={e => {
            const iso = e.target.value;
            // Clearing the field falls back to today rather than to an empty
            // list — the date input's own "clear" must mean something.
            router.push(
              buildHref({
                ...filters,
                quando: isIsoDate(iso) ? { kind: 'date', iso } : { kind: 'keyword', value: 'hoje' },
              }),
            );
          }}
        />
      </label>
    </div>
  );
}
