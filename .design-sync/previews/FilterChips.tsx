import { FilterChips } from '@capo/ui';

// `quando` is either one of the five keywords or a literal YYYY-MM-DD, so a
// specific day is just another value of the same param rather than a second
// param that could contradict the first.
const todas = { quando: { kind: 'keyword' as const, value: 'todas' as const }, obraId: null };

/** The default view. 'Todas' is deliberately the default, not 'Hoje'. */
export function DefaultIsTodas() {
  return <div style={{ maxWidth: 460, padding: '0.75rem' }}><FilterChips locale="pt-PT" filters={todas} /></div>;
}

/** Filtered to overdue work — the chip a manager reaches for on a bad morning. */
export function Atrasadas() {
  return (
    <div style={{ maxWidth: 460, padding: '0.75rem' }}>
      <FilterChips locale="pt-PT" filters={{ quando: { kind: 'keyword', value: 'atrasadas' }, obraId: null }} />
    </div>
  );
}

/** A literal date selected: no keyword chip is lit, because none matches. */
export function ASpecificDay() {
  return (
    <div style={{ maxWidth: 460, padding: '0.75rem' }}>
      <FilterChips locale="pt-PT" filters={{ quando: { kind: 'date', iso: '2026-08-26' }, obraId: null }} />
    </div>
  );
}

/** The same five chips in English. */
export function English() {
  return <div style={{ maxWidth: 460, padding: '0.75rem' }}><FilterChips locale="en-US" filters={todas} /></div>;
}
