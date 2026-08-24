import type { AuthContext } from '@capo/db/session';

// The site feed: what the crew actually did, newest first.
//
// ONE LOADER, TWO SURFACES — the Atividade tab and Home's "what just happened"
// widget. They were specified as separate things and are deliberately not:
// two loaders would eventually disagree about the same event, and the manager
// would have no way to tell which was right. Same reason the push notification
// and the inbox share one catalog entry.
//
// THREE SOURCES, MERGED IN TYPESCRIPT rather than in SQL. A view UNIONing them
// would be tidier and is deliberately not done: it needs a migration, and this
// project has shipped a deploy ahead of its migration before. Three indexed
// reads and a sort cost nothing at this size — task_photos already has
// (company_id, created_at desc), and task_reviews and worker_checkins are both
// small per company.
//
// WHAT IS NOT HERE, and why it is not a gap: the handoff's feed showed
// "Cement delivery signed for at Campo Grande — 2 pallets short". Capo has no
// concept of a delivery or a goods-in receipt anywhere in the schema, and
// materials are notes hanging off a task rather than stock that is received.
// Inventing a row for it would be a promise the product cannot keep.

export type ActivityKind =
  | 'task_claimed'
  | 'task_approved'
  | 'task_rejected'
  | 'photos_added'
  | 'checkin_done'
  | 'checkin_not_done';

export interface ActivityEvent {
  /** Stable within a render; used as a React key, never persisted. */
  id: string;
  kind: ActivityKind;
  /** ISO timestamp. Sorting and day-grouping both key on this. */
  at: string;
  taskId: string | null;
  taskTitle: string | null;
  jobName: string | null;
  workerName: string | null;
  /** photos_added only; 0 everywhere else. */
  count: number;
}

/** Internal only. Carries the worker id that `workerName` is resolved from,
 *  which the caller has no use for — a name is what a manager reads, and an
 *  id leaking into a rendered surface is how one ends up on screen. */
interface Draft {
  id: string;
  kind: ActivityKind;
  at: string;
  taskId: string | null;
  workerId: string | null;
  count: number;
}

/** How far back to look. A feed is a "what happened lately" surface, not an
 *  audit log — and bounding the window is what keeps the three reads cheap on
 *  a company with two years of history behind it. */
const WINDOW_DAYS = 14;

// Per-source read cap. Generous relative to `limit` because the three streams
// are merged and THEN cut: capping each at `limit` would let one busy stream
// (a forty-photo upload) push a whole day of completion claims out of the
// result before the sort ever sees them.
const PER_SOURCE_LIMIT = 200;

export async function loadActivity(
  { db, companyId }: AuthContext,
  limit = 50,
): Promise<ActivityEvent[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // All three concurrently, and each allowed to come back empty on its own: a
  // feed missing photos is worth more than a screen that will not render, and
  // it is the same posture loadCompanySnapshot takes. Nothing here is a tenant
  // boundary — every query carries company_id AND runs on the RLS-scoped
  // client — so a bug in this file costs completeness, never isolation.
  const [reviews, photos, checkins] = await Promise.all([
    db
      .from('task_reviews')
      .select('id, task_id, declared_at, declared_by_worker_id, status, resolved_at')
      .eq('company_id', companyId)
      .gte('declared_at', since)
      .order('declared_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT)
      .then(r => r.data ?? []),
    db
      .from('task_photos')
      .select('id, task_id, created_at, worker_id')
      .eq('company_id', companyId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT)
      .then(r => r.data ?? []),
    db
      .from('worker_checkins')
      .select('id, worker_id, answer, answered_at')
      .eq('company_id', companyId)
      .gte('answered_at', since)
      .order('answered_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT)
      .then(r => r.data ?? []),
  ]);

  const drafts: Draft[] = [];

  for (const r of reviews) {
    drafts.push({
      id: `claim:${r.id}`,
      kind: 'task_claimed',
      at: r.declared_at,
      taskId: r.task_id,
      workerId: r.declared_by_worker_id,
      count: 0,
    });
    // A resolution is its OWN event at its own time, never a rewrite of the
    // claim. "Rui said it was done" and "you confirmed it" are two things that
    // happened, often days apart, and collapsing them would erase the gap
    // between them — which is the entire thing a review queue is about.
    // 'dismissed' and 'superseded' are excluded deliberately: neither is a
    // decision the manager made about the work.
    if (r.resolved_at && (r.status === 'approved' || r.status === 'rejected')) {
      drafts.push({
        id: `resolve:${r.id}`,
        kind: r.status === 'approved' ? 'task_approved' : 'task_rejected',
        at: r.resolved_at,
        taskId: r.task_id,
        workerId: null,
        count: 0,
      });
    }
  }

  // Photos collapse to ONE event per task per calendar day. Six photos of the
  // same façade is one thing that happened, and six rows would bury every
  // other event under them — which is exactly what the handoff's own example
  // ("6 photos added to Rua Ferreira 12") shows it expects.
  const groups = new Map<string, { at: string; count: number; taskId: string; workerId: string | null }>();
  for (const p of photos) {
    const key = `${p.task_id}:${p.created_at.slice(0, 10)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      // Keep the LATEST stamp in the group, so the row sorts to where the last
      // photo landed rather than where the first one did.
      if (p.created_at > existing.at) existing.at = p.created_at;
    } else {
      groups.set(key, { at: p.created_at, count: 1, taskId: p.task_id, workerId: p.worker_id });
    }
  }
  for (const [key, g] of groups) {
    drafts.push({
      id: `photos:${key}`,
      kind: 'photos_added',
      at: g.at,
      taskId: g.taskId,
      workerId: g.workerId,
      count: g.count,
    });
  }

  for (const c of checkins) {
    drafts.push({
      id: `checkin:${c.id}`,
      kind: c.answer === 'done' ? 'checkin_done' : 'checkin_not_done',
      at: c.answered_at,
      taskId: null,
      workerId: c.worker_id,
      count: 0,
    });
  }

  // Sort and cut BEFORE resolving names and titles, so the two lookup queries
  // only ever fetch what is actually going to be rendered.
  drafts.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const visible = drafts.slice(0, limit);

  const taskIds = [...new Set(visible.map(d => d.taskId).filter((id): id is string => Boolean(id)))];
  const workerIds = [...new Set(visible.map(d => d.workerId).filter((id): id is string => Boolean(id)))];

  // Base `tasks`, not `task_board`: the view filters by lisbon_today(), so a
  // task whose window has closed comes back with nothing — and a feed is
  // entirely about things that have already happened.
  const [taskRows, workerRows] = await Promise.all([
    taskIds.length
      ? db
          .from('tasks')
          .select('id, title, job:jobs(name)')
          .eq('company_id', companyId)
          .in('id', taskIds)
          .then(r => r.data ?? [])
      : Promise.resolve([]),
    workerIds.length
      ? db
          .from('workers')
          .select('id, name')
          .eq('company_id', companyId)
          .in('id', workerIds)
          .then(r => r.data ?? [])
      : Promise.resolve([]),
  ]);

  const titles = new Map(
    taskRows.map(t => [t.id, { title: t.title as string, job: (t.job as { name: string } | null)?.name ?? null }]),
  );
  const names = new Map(workerRows.map(w => [w.id, w.name]));

  return visible.map(d => ({
    id: d.id,
    kind: d.kind,
    at: d.at,
    taskId: d.taskId,
    taskTitle: d.taskId ? (titles.get(d.taskId)?.title ?? null) : null,
    jobName: d.taskId ? (titles.get(d.taskId)?.job ?? null) : null,
    workerName: d.workerId ? (names.get(d.workerId) ?? null) : null,
    count: d.count,
  }));
}
