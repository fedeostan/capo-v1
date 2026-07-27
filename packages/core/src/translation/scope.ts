// WHAT a tenant-wide translation rewrites. One declaration, derived from by
// count, collect, apply and revert — and mirrored by the (table_name,
// column_name) CHECK in supabase/migrations/0015_translation_batches.sql. If
// you add a field here you MUST widen that constraint in a new migration, or
// the snapshot insert fails and the batch cannot start.
//
// Two rules that are easy to get wrong later:
//
// 1. READ BASE TABLES, NEVER task_board. The view is the single clock for
//    "what is on today / overdue / at risk" and filters by lisbon_today().
//    Collecting through it would silently skip rows AND couple translation to
//    the calendar, so a task outside today's window would keep its old
//    language forever.
// 2. EVERY STATUS, including done and cancelled. The instinct is to filter to
//    open work; don't. The manager scrolls history, and a bilingual archive is
//    exactly the half-translated state this feature exists to prevent.

export const TRANSLATABLE_TABLES = ['tasks', 'jobs', 'workers', 'memories'] as const;
export type TranslatableTable = (typeof TRANSLATABLE_TABLES)[number];

export type TranslatableField = {
  readonly table: TranslatableTable;
  readonly column: string;
  /** text[] is flattened into one model unit per element and reassembled. */
  readonly kind: 'text' | 'text[]';
};

// Deliberately absent, and each for its own reason:
//   workers.name, jobs.client_name, jobs.address, companies.name,
//     profiles.full_name  — proper nouns. Translating "Rua do Carmo" or "Zé"
//     produces nonsense, and jobs.address is what the crew navigates to.
//   messages, proposals.rendered_text, conversation_summaries — the record of
//     what was actually said. capabilities/guard.ts authorizes direct writes by
//     matching the model's quote against recent user messages; rewriting those
//     would break authorization retroactively.
//   knowledge_documents / knowledge_chunks — a shared Portuguese corpus whose
//     FTS config is hardcoded to 'portuguese'.
//   transcription_vocab.term — deliberately kept in whatever language the
//     foreman said it in (see api/transcribe/feedback).
export const TRANSLATABLE: readonly TranslatableField[] = [
  { table: 'tasks', column: 'title', kind: 'text' },
  { table: 'tasks', column: 'description', kind: 'text' },
  { table: 'tasks', column: 'materials', kind: 'text[]' },
  { table: 'jobs', column: 'name', kind: 'text' },
  { table: 'workers', column: 'trade', kind: 'text' },
  { table: 'memories', column: 'content', kind: 'text' },
];

export function fieldsFor(table: TranslatableTable): readonly TranslatableField[] {
  return TRANSLATABLE.filter(f => f.table === table);
}
