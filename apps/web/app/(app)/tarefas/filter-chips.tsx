// The time filter row. Deliberately a server component of plain <Link>s: the
// whole screen filters correctly before any client JS has loaded, and each
// chip is a real, shareable URL — which is also why this is not the shared
// SegmentedControl: that is a client fieldset of radio inputs, and these are
// links. The pill styling matches it instead, so the two read as one control.
import Link from 'next/link';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { buildHref, QUANDO_CHIPS, type TarefasFilters } from './filters';

function chipClass(active: boolean): string {
  return [
    'flex min-h-11 shrink-0 items-center rounded-full border px-4 text-callout no-underline',
    'transition-colors ease-out',
    'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    active
      ? 'border-brand bg-brand font-semibold text-on-brand'
      : 'border-control bg-surface text-fg-muted hover:bg-surface-hover',
  ].join(' ');
}

export default function FilterChips({ filters, locale }: { filters: TarefasFilters; locale: Locale }) {
  const t = getCatalog(locale);
  return (
    <nav className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
      {QUANDO_CHIPS.map(value => {
        const label = t.screens.tasks.quando[value];
        const active = filters.quando.kind === 'keyword' && filters.quando.value === value;
        return (
          <Link
            key={value}
            href={buildHref({ ...filters, quando: { kind: 'keyword', value } })}
            className={chipClass(active)}
          >
            {label}
          </Link>
        );
      })}
      {/* A chosen day joins the row as its own chip, so it is visible as the
          active filter instead of hiding inside the date input. */}
      {filters.quando.kind === 'date' && (
        <span className={chipClass(true)}>
          {new Intl.DateTimeFormat(t.meta.dateLocale, { timeZone: 'UTC', day: '2-digit', month: '2-digit' }).format(
            new Date(`${filters.quando.iso}T00:00:00Z`),
          )}
        </span>
      )}
    </nav>
  );
}
