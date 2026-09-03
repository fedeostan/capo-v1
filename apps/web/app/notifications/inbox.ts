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
import { countTaskPhotos } from '../dashboard-data';
import { describeUrgency, type RequestUrgency } from '@/lib/worker-request';

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
  /**
   * How many photos are attached to the task this row is about (issue #52), or
   * null for a row whose subject is not a task review — there is nothing for a
   * photo to be proof of.
   *
   * ── WHY THE ROW ITSELF CANNOT CARRY THIS ──────────────────────────────────
   * A `notifications` row is written by a TRIGGER at the moment the claim is
   * filed (0024), and on the check-in path a photo cannot possibly have arrived
   * yet — Capo has not even asked for one. Anything stamped into the row would
   * say "no photo" forever and be wrong minutes later, invisibly. Counted at
   * read time instead, from the SAME helper the board uses, so the inbox and
   * the board cannot say different things about one claim.
   *
   * ⚠ THE PUSH NOTIFICATION DELIBERATELY DOES NOT CARRY IT. A push is
   * dispatched seconds after the claim, from `after()` in the producer's own
   * request, which is exactly the window in which "no photo" is guaranteed true
   * and guaranteed uninformative. A lock-screen alert that always says the same
   * thing teaches the manager to ignore it.
   */
  photoCount: number | null;
  /**
   * True when the claim this row is about was filed WITHOUT a photo on purpose
   * (0049): the crew member was asked twice and said they could not send one.
   * Null for a row whose subject is not a task review.
   *
   * Read here so the inbox says the same thing the board and Home say about
   * one claim. Without it a waived claim reads "· Sem fotos anexadas." beside
   * its own headline, which is the ORDINARY sentence — and this is the one
   * surface of the four where the manager is most likely to be skimming.
   */
  photoWaived: boolean | null;
  /**
   * When a crew request is needed FOR (issue #152), or null for every other
   * kind. `kind` is the result of subtracting lisbon_today() from
   * `worker_requests.needed_by`, and `date` is the raw ISO day for the reader
   * to format in their own locale.
   *
   * Read at query time rather than stamped into the row for the same reason
   * photoCount is: 'para amanhã' is only true today, and a sentence frozen into
   * the notification would go on saying it for ever.
   */
  requestWhen: { kind: RequestUrgency; date: string | null } | null;
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
  const waivedReviews = new Set<string>();
  if (reviewIds.length > 0) {
    // `select('*')` for 0049's `photo_waived`: naming a column a pending
    // migration adds couples this read to that migration, and a deploy landing
    // first answers 42703. Same rule loadPendingReviews follows.
    const { data: reviews } = await db
      .from('task_reviews')
      .select('*')
      .eq('company_id', companyId)
      .in('id', reviewIds);
    for (const r of reviews ?? []) {
      taskByReview.set(r.id, r.task_id);
      // `=== true`, never a bare read: absent before the migration lands.
      if (r.photo_waived === true) waivedReviews.add(r.id);
    }
  }

  // Whether each of those claims came with proof (issue #52). Same helper the
  // board's loadPendingReviews calls, so the two surfaces cannot disagree about
  // one claim — the same reason push and inbox share one headline entry.
  const photos = await countTaskPhotos(ctx, [...taskByReview.values()]);

  // Crew requests (issue #152). Same shape as the review lookup above and for
  // the same reasons: a second query rather than an embed, and the row's own
  // subject_id resolved to what the manager actually wants — the day it is
  // needed for, and the task it was about if one was named.
  //
  // `lisbon_today()` is read ONLY when there is a request on the page. One
  // clock: "para amanhã" here has to mean what "amanhã" means on the board.
  const requestIds = [
    ...new Set(
      rows
        .filter(r => r.subject_type === 'worker_request')
        .map(r => r.subject_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const requestById = new Map<string, { neededBy: string | null; taskId: string | null }>();
  let today: string | null = null;
  if (requestIds.length > 0) {
    const { data: todayValue } = await db.rpc('lisbon_today');
    today = typeof todayValue === 'string' ? todayValue : null;
    const { data: requests } = await db
      .from('worker_requests')
      .select('id, needed_by, task_id')
      .eq('company_id', companyId)
      .in('id', requestIds);
    for (const r of requests ?? []) requestById.set(r.id, { neededBy: r.needed_by, taskId: r.task_id });
  }

  return rows.map(row => {
    const isReview = row.subject_type === 'task_review' && !!row.subject_id;
    const reviewTaskId = isReview ? taskByReview.get(row.subject_id as string) : undefined;
    const request = row.subject_type === 'worker_request' && row.subject_id ? requestById.get(row.subject_id) : undefined;
    // A request links to the task only when the crew member named one; there is
    // no screen a request of its own lives on, and a link to nowhere reads as a
    // bug — so the row renders without one, as it already does for a review
    // whose subject has vanished.
    const href = reviewTaskId
      ? `/tarefas/${reviewTaskId}`
      : request?.taskId
        ? `/tarefas/${request.taskId}`
        : null;
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      readAt: row.read_at,
      createdAt: row.created_at,
      href,
      photoCount: reviewTaskId ? (photos.get(reviewTaskId) ?? 0) : null,
      photoWaived: isReview ? waivedReviews.has(row.subject_id as string) : null,
      requestWhen: request ? { kind: describeUrgency(request.neededBy, today), date: request.neededBy } : null,
    };
  });
}
