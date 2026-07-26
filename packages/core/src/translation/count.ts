import type { Db } from '@capo/db/client';

// How much would a translation touch? Head counts only — NO model call, no row
// payload. This runs on every /perfil render and inside every approval-card
// render, so it has to stay four cheap COUNT queries.
//
// Counts ROWS, not fields, because that is what the manager can verify: "6
// obras" is something he can go and look at, "9 campos de texto" is not. The
// batch's own item_count (fields) is what the progress bar uses.

export type TranslationCounts = {
  tasks: number;
  jobs: number;
  workers: number;
  memories: number;
  /** Rows across all four tables. Zero means there is nothing to propose. */
  total: number;
};

export async function countTranslatable(db: Db, companyId: string): Promise<TranslationCounts> {
  const head = { count: 'exact' as const, head: true };

  const [tasks, jobs, workers, memories] = await Promise.all([
    // title is NOT NULL, so every task row has at least one translatable field.
    db.from('tasks').select('id', head).eq('company_id', companyId),
    // name is NOT NULL — same reasoning.
    db.from('jobs').select('id', head).eq('company_id', companyId),
    // trade is the ONLY translatable column on workers (name is a proper noun),
    // and it is nullable — a crew with no trades recorded would otherwise be
    // announced on the card and then produce zero items.
    db.from('workers').select('id', head).eq('company_id', companyId).not('trade', 'is', null).neq('trade', ''),
    // content is NOT NULL.
    db.from('memories').select('id', head).eq('company_id', companyId),
  ]);

  const n = (r: { count: number | null }) => r.count ?? 0;
  const counts = {
    tasks: n(tasks),
    jobs: n(jobs),
    workers: n(workers),
    memories: n(memories),
  };

  return { ...counts, total: counts.tasks + counts.jobs + counts.workers + counts.memories };
}
