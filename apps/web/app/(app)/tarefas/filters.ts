// The /tarefas filter state, expressed entirely as URL search params so the
// screen stays a server component and every view is shareable and
// back-button-friendly.
//
// Pure module: no React, no 'use server', no DB. Imported by the page, by the
// chip row, by the client control strip, and by dashboard-data.ts.

// Values only — the labels live in @capo/i18n, keyed by these same strings.
// The VALUES stay Portuguese on purpose: they are the URL contract (?quando=hoje),
// shareable and bookmarkable, so translating them would break existing links.
export const QUANDO_CHIPS = ['hoje', 'amanha', 'atrasadas', 'risco', 'todas'] as const;

export type QuandoKeyword = (typeof QUANDO_CHIPS)[number];

// `quando` is either one of the keywords above or a literal YYYY-MM-DD, so a
// specific day is just another value of the same param rather than a second
// param that could contradict the first.
export type Quando = { kind: 'keyword'; value: QuandoKeyword } | { kind: 'date'; iso: string };

export interface TarefasFilters {
  quando: Quando;
  obraId: string | null;
}

export type RawSearchParams = Record<string, string | string[] | undefined>;

export const DEFAULT_QUANDO: Quando = { kind: 'keyword', value: 'hoje' };

const KEYWORDS: readonly string[] = QUANDO_CHIPS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Shared with /tarefas/[id]: a route segment is checked here before it ever
// reaches the DB. A well-formed uuid belonging to another tenant still needs no
// special handling — RLS returns zero rows and the page 404s.
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

// Round-trip through Date so 2026-02-31 is rejected rather than silently
// shifted to 2026-03-03 — a filter that quietly shows the wrong day is worse
// than one that falls back to today.
export function isIsoDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
  );
}

// Degrade, never throw: anything unrecognised falls back to the default view.
// A well-formed uuid belonging to another tenant needs no special handling —
// RLS returns zero rows for it.
export function parseFilters(searchParams: RawSearchParams): TarefasFilters {
  const rawQuando = first(searchParams.quando);
  const rawObra = first(searchParams.obra);

  let quando: Quando = DEFAULT_QUANDO;
  if (rawQuando && KEYWORDS.includes(rawQuando)) {
    quando = { kind: 'keyword', value: rawQuando as QuandoKeyword };
  } else if (rawQuando && isIsoDate(rawQuando)) {
    quando = { kind: 'date', iso: rawQuando };
  }

  return { quando, obraId: rawObra && UUID.test(rawObra) ? rawObra : null };
}

export function serializeQuando(quando: Quando): string {
  return quando.kind === 'keyword' ? quando.value : quando.iso;
}

// Always emits `quando` (so the active chip is unambiguous and the URL is
// shareable) and emits `obra` only when set.
export function buildHref(filters: TarefasFilters): string {
  const params = new URLSearchParams({ quando: serializeQuando(filters.quando) });
  if (filters.obraId) params.set('obra', filters.obraId);
  return `/tarefas?${params.toString()}`;
}
