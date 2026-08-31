'use client';

// The obra picker and the specific-day picker. The only client component on
// this screen, and it deliberately does NOT call useSearchParams: the current
// filters arrive as props from the server page, so there is no Suspense
// boundary to get wrong and no `next build` bailout to work around.
//
// Native <select>/<input type="date"> on purpose — on iOS and Android the
// platform renders them as its own picker sheet, which is the bottom sheet we
// wanted, for free and accessible. Both render through @capo/ui's Select and
// Input so they share the one control style (and its 44px+ height) with every
// other form in the app.
import { useRouter } from 'next/navigation';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { Input, Select } from '@capo/ui/field';
import { buildHref, DEFAULT_QUANDO, isIsoDate, type TarefasFilters } from './filters';
import type { ObraOption } from '@/app/dashboard-data';

export default function FilterControls({
  filters,
  obras,
  locale,
}: {
  filters: TarefasFilters;
  obras: ObraOption[];
  locale: Locale;
}) {
  const t = getCatalog(locale).screens.tasks;
  const router = useRouter();

  return (
    <div className="flex gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="sr-only">{t.filterByJob}</span>
        <Select
          value={filters.obraId ?? ''}
          onChange={e => router.push(buildHref({ ...filters, obraId: e.target.value || null }))}
        >
          <option value="">{t.allJobs}</option>
          {obras.map(obra => (
            <option key={obra.id} value={obra.id}>
              {obra.name}
              {obra.status === 'paused'
                ? t.jobStatusSuffix.paused
                : obra.status === 'done'
                  ? t.jobStatusSuffix.done
                  : ''}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="sr-only">{t.filterByDay}</span>
        <Input
          type="date"
          value={filters.quando.kind === 'date' ? filters.quando.iso : ''}
          onChange={e => {
            const iso = e.target.value;
            // Clearing the field falls back to the DEFAULT view rather than
            // to an empty list — the date input's own "clear" must mean
            // something, and it must mean the same thing as arriving at
            // /tarefas with no filter at all.
            router.push(
              buildHref({ ...filters, quando: isIsoDate(iso) ? { kind: 'date', iso } : DEFAULT_QUANDO }),
            );
          }}
        />
      </label>
    </div>
  );
}
