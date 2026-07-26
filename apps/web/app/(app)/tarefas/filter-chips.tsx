// The time filter row. Deliberately a server component of plain <Link>s: the
// whole screen filters correctly before any client JS has loaded, and each
// chip is a real, shareable URL.
import Link from 'next/link';
import { buildHref, QUANDO_CHIPS, type TarefasFilters } from './filters';

function chipClass(active: boolean): string {
  return `shrink-0 rounded-full border px-3 py-1 text-xs ${
    active
      ? 'border-orange-600 bg-orange-600 font-semibold text-white'
      : 'border-zinc-500/30 text-zinc-500'
  }`;
}

export default function FilterChips({ filters }: { filters: TarefasFilters }) {
  return (
    <nav className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
      {QUANDO_CHIPS.map(({ value, label }) => {
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
          {new Intl.DateTimeFormat('pt-PT', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }).format(
            new Date(`${filters.quando.iso}T00:00:00Z`),
          )}
        </span>
      )}
    </nav>
  );
}
