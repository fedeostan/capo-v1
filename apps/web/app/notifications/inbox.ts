// Read-only queries for the in-app inbox. Nothing here mutates.
//
// Sits beside briefing.ts rather than in dashboard-data.ts because this is the
// same subject matter — what Capo tells the manager — arriving through the
// other channel. briefing.ts is the 07:00 WhatsApp push; this is the pull.
//
// Every query runs on the user-scoped client. RLS already restricts these rows
// to `company_id = current_company_id() AND profile_id = auth.uid()`; the
// explicit filters below are belt-and-braces on top of it, the same posture
// dashboard-data.ts takes.
import type { AuthContext } from '@capo/db/session';

/** One row of the inbox, already resolved to something renderable. */
export interface InboxItem {
  id: string;
  /** Key into the catalog's notifications.kind Record. Kept as a plain string
   *  because the DB is the source of truth for the set — see the check
   *  constraint in 0023_notifications.sql. The renderer falls back rather than
   *  throwing on a value it does not know. */
  kind: string;
  /** The subject's own name — a task title, in companies.language. Data. */
  title: string | null;
  /** Worker-authored text. Rendered as an attributed quote, never as copy. */
  body: string | null;
  /** null = unread. */
  readAt: string | null;
  createdAt: string;
  /** Where the manager can actually act, or null when the subject no longer
   *  resolves. A notification is a pointer; a pointer to nowhere is a dead
   *  end, so the renderer drops the link rather than linking to a 404. */
  href: string | null;
}

/**
 * Unread count for the badge. Runs in the app shell on EVERY authenticated
 * page render, which is why it is a `head` count against the partial index
 * (notifications_unread_idx) and never fetches rows.
 */
export async function countUnread({ db, userId, companyId }: AuthContext): Promise<number> {
  const { count, error } = await db
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('profile_id', userId)
    .is('read_at', null);
  // A failed count must not take down every screen in the app — the shell
  // renders on top of every route. Zero means "no badge", which is the safe
  // way to be wrong: it under-reports rather than blocking the page.
  if (error) return 0;
  return count ?? 0;
}

/**
 * The inbox itself, newest first.
 *
 * Capped rather than paginated. The inbox is a "what did I miss" surface, not
 * an archive: a manager scrolling past 50 notifications is looking for
 * something a list cannot give them. Revisit if a kind ever arrives in bulk.
 */
export async function loadInbox(ctx: AuthContext, limit = 50): Promise<InboxItem[]> {
  const { db, userId, companyId } = ctx;
  const { data, error } = await db
    .from('notifications')
    .select('id, kind, subject_type, subject_id, title, body, read_at, created_at')
    .eq('company_id', companyId)
    .eq('profile_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`notifications read failed: ${error.message}`);

  const rows = data ?? [];

  // Resolve task_review subjects to the TASK they are about. The notification
  // stores the review id (the retirement trigger in 0023 needs that identity),
  // but the manager wants the task screen — which is where ReviewActions
  // renders, i.e. the only place approve/reject/dismiss exist.
  //
  // A second query rather than a PostgREST embed, for the same reason
  // loadPendingReviews avoids one: the embed alias depends on the FK
  // constraint's generated name and a rename would break it silently.
  const reviewIds = [
    ...new Set(
      rows
        .filter(r => r.subject_type === 'task_review')
        .map(r => r.subject_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const taskByReview = new Map<string, string>();
  if (reviewIds.length > 0) {
    const { data: reviews } = await db
      .from('task_reviews')
      .select('id, task_id')
      .eq('company_id', companyId)
      .in('id', reviewIds);
    for (const r of reviews ?? []) taskByReview.set(r.id, r.task_id);
  }

  return rows.map(row => {
    const taskId = row.subject_type === 'task_review' && row.subject_id ? taskByReview.get(row.subject_id) : undefined;
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      readAt: row.read_at,
      createdAt: row.created_at,
      href: taskId ? `/tarefas/${taskId}` : null,
    };
  });
}
