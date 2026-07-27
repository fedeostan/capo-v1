import type { Db } from '@capo/db/client';
import { fieldsFor, type TranslatableTable } from './scope';

// Reading the rows a batch will rewrite, and the proper nouns it must leave
// alone. Base tables only — see the note in scope.ts about task_board.

export type CollectedItem = {
  table: TranslatableTable;
  rowId: string;
  column: string;
  kind: 'text' | 'text[]';
  oldValue: string | string[];
};

// PostgREST caps a response at 1000 rows by default; a tenant with more tasks
// than that would silently collect a prefix and report a complete batch.
const PAGE = 1000;

async function page<T>(
  fetch: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await fetch(from, from + PAGE - 1);
    if (error) throw new Error(`Failed to read rows for translation: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

/** Pull the translatable fields off already-fetched rows, skipping blanks. */
function itemsFrom(table: TranslatableTable, rows: Record<string, unknown>[]): CollectedItem[] {
  const fields = fieldsFor(table);
  const items: CollectedItem[] = [];

  for (const row of rows) {
    const rowId = row.id as string;
    for (const f of fields) {
      const raw = row[f.column];
      if (f.kind === 'text[]') {
        // An empty array and a null column are the same thing here: nothing to
        // translate, and inserting an item for it would inflate the progress bar.
        if (!Array.isArray(raw)) continue;
        const values = raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
        if (values.length === 0) continue;
        items.push({ table, rowId, column: f.column, kind: f.kind, oldValue: values });
      } else {
        if (typeof raw !== 'string' || raw.trim() === '') continue;
        items.push({ table, rowId, column: f.column, kind: f.kind, oldValue: raw });
      }
    }
  }

  return items;
}

/**
 * Every field in this company that a translation would rewrite.
 *
 * Selects are written out per table rather than assembled from scope.ts: a
 * dynamic column string would defeat the generated Database types, and the
 * types are what catch a scope entry naming a column that does not exist.
 */
export async function collectTranslatable(db: Db, companyId: string): Promise<CollectedItem[]> {
  const [tasks, jobs, workers, memories] = await Promise.all([
    page((from, to) =>
      db.from('tasks').select('id, title, description, materials').eq('company_id', companyId).order('id').range(from, to),
    ),
    page((from, to) => db.from('jobs').select('id, name').eq('company_id', companyId).order('id').range(from, to)),
    page((from, to) => db.from('workers').select('id, trade').eq('company_id', companyId).order('id').range(from, to)),
    page((from, to) => db.from('memories').select('id, content').eq('company_id', companyId).order('id').range(from, to)),
  ]);

  return [
    ...itemsFrom('tasks', tasks),
    ...itemsFrom('jobs', jobs),
    ...itemsFrom('workers', workers),
    ...itemsFrom('memories', memories),
  ];
}

/**
 * The do-not-translate list: this tenant's own proper nouns.
 *
 * These appear INSIDE the strings being translated — "Ligar ao João da Silva
 * sobre a obra da Rua do Carmo" is one task title containing a person, a street
 * and a job name. Handing the model the tenant's actual vocabulary is the
 * single highest-leverage quality lever available here, and it costs one round
 * trip per batch.
 */
export async function loadGlossary(db: Db, companyId: string): Promise<string[]> {
  const [workers, jobs, company] = await Promise.all([
    db.from('workers').select('name').eq('company_id', companyId).limit(PAGE),
    db.from('jobs').select('name, client_name, address').eq('company_id', companyId).limit(PAGE),
    db.from('companies').select('name').eq('id', companyId).maybeSingle(),
  ]);

  const terms = [
    ...(workers.data ?? []).map(w => w.name),
    // jobs.client_name and jobs.address only — NOT jobs.name, which is itself
    // in scope and must be translated. Known consequence: a job name is
    // translated once on its own row and again wherever it appears inside a
    // task title, independently, so the two can word it differently. Pinning
    // job names here would trade that for the worse bug of a job whose row and
    // whose mentions permanently disagree about which language they are in.
    ...(jobs.data ?? []).flatMap(j => [j.client_name, j.address]),
    company.data?.name ?? null,
  ];

  return [...new Set(terms.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(t => t.trim()))];
}
