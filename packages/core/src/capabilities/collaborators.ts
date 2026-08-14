// Reading "who else is on this task" off a `task_board` row (issue #44).
//
// ONE function, in @capo/core, read by the 07:00 briefing, the afternoon
// check-in, the Tarefas detail screen, the crew card on /perfil and the
// `list_workers` tool. Deliberately not four copies of six lines: the day two of
// them disagreed, one surface would say a person was free and another would say
// they were on site, and the manager would have no way to tell which to
// believe. Same reasoning that keeps "what is on today" in a single view.
//
// Pure, with no `Db` and no imports: it takes a row that has already been read.

/** One crew member on a task, besides the lead. */
export interface Collaborator {
  id: string;
  /** As stored in `workers.name`. May be the empty string if a row somehow has
   *  none — callers omit the name rather than printing a placeholder. */
  name: string;
}

/**
 * The collaborators on one `task_board` row, read DEFENSIVELY.
 *
 * ── why the row is typed `object` and read through an index ─────────────────
 * `collaborator_worker_ids` and `collaborator_names` are APPENDED to the view
 * by migration 0035. Every reader of that view uses `select('*')` (AGENTS.md),
 * so on a deploy that lands before its migration both come back `undefined` and
 * this answers `[]` — the morning send then briefs exactly the people it briefs
 * today, and the board shows exactly what it shows today. That is the required
 * degradation. A typed field access would instead be a `tsc` error or a
 * runtime surprise depending on which way the hand-maintained generated types
 * happen to lead the live schema.
 *
 * ── the one place this codebase zips two arrays by position ─────────────────
 * Matching two lists by index is normally the mistake the translation
 * invariants exist to forbid. It is safe HERE, and only here, because the two
 * arrays are not two results: they are one aggregate split in two, produced in
 * the same statement over the same rows with the same `order by cw.name,
 * cw.id`. The length guard below is what keeps that falsifiable rather than
 * merely believed — if the view is ever edited so the two orderings diverge,
 * this answers "nobody" instead of confidently naming the wrong person to
 * their own crew.
 */
export function readCollaborators(row: object): Collaborator[] {
  const record = row as Record<string, unknown>;
  const ids = record.collaborator_worker_ids;
  const names = record.collaborator_names;
  if (!Array.isArray(ids) || !Array.isArray(names) || ids.length !== names.length) return [];

  const out: Collaborator[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (typeof id !== 'string' || !id) continue;
    const name = names[i];
    out.push({ id, name: typeof name === 'string' ? name : '' });
  }
  return out;
}

/**
 * Every worker on a task — the lead first, then the collaborators.
 *
 * The lead comes from `assignee_worker_id`, which stays the authoritative
 * answer to "whose job is this"; it is NEVER taken from the mirrored `lead` row
 * in `task_assignees`. See the header of migration 0035 for why that asymmetry
 * is the whole safety design.
 *
 * Used by the counters that answer "how busy is this person" — a helper on a
 * wall is on that wall, and a picker that called them free would be the exact
 * wrong-direction label /tarefas/[id] already refuses to print.
 */
export function everyoneOnTask(row: { assignee_worker_id?: string | null } & object): string[] {
  const ids = readCollaborators(row).map(c => c.id);
  return row.assignee_worker_id ? [row.assignee_worker_id, ...ids] : ids;
}
