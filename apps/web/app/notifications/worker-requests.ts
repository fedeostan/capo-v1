import type { AuthContext } from '@capo/db/session';
import { coerceCategory, describeUrgency, urgencyRank, type RequestCategory, type RequestUrgency } from '@/lib/worker-request';

// The manager's read of what the crew asked for (issue #152).
//
// Sits beside inbox.ts for the reason inbox.ts sits beside briefing.ts: it is
// the same subject matter — what Capo tells the manager — arriving through a
// third door. Runs on the USER-scoped client, so RLS already restricts these
// rows to `company_id = current_company_id()`; the explicit filter below is
// belt-and-braces on top of it, the same posture dashboard-data.ts takes.
//
// Read-only. Nothing here mutates, and there is nothing a tenant COULD mutate:
// 0043 grants them SELECT and nothing else.

/** One request, resolved to something renderable. */
export interface WorkerRequestItem {
  id: string;
  /** workers.name — typed by the MANAGER on /perfil, so it is company-owned
   *  text and safe anywhere. Never anything the crew member wrote. */
  workerName: string;
  /**
   * The crew member's OWN WORDS. Rendered as an attributed quote on every
   * surface, never as Capo's voice — the same rule task_reviews.note follows,
   * because it is the same class of text (AGENTS.md, migration 0043).
   */
  text: string;
  category: RequestCategory | null;
  neededBy: string | null;
  /** Derived from `needed_by` and lisbon_today() by plain subtraction. Never
   *  from the model's reading of tone. */
  urgency: RequestUrgency;
  /** The task they named, if they named one. Company-owned text. */
  taskId: string | null;
  taskTitle: string | null;
  createdAt: string;
}

/**
 * How far back Home looks.
 *
 * 0043 has NO resolution marker on purpose (problem_reports' decision — a
 * status column added before anything writes it is a promise the product does
 * not make), so a card that showed every request ever would be permanently lit
 * within a fortnight, and a permanently lit card is one the manager stops
 * reading. Freshness is the self-clearing substitute: a request occupies Home
 * for a week and then lives on in the inbox, which keeps everything and has its
 * own read state.
 *
 * The honest cost, stated rather than hidden: a request for next month drops
 * off Home after seven days while still being unfulfilled. Fixing that properly
 * means a "handled" action, which is the follow-up this release deliberately
 * does not build.
 */
const HOME_FRESH_DAYS = 7;

/** An unbounded select on the request path is how one tenant's bad data becomes
 *  everybody's timeout. Home shows two or three rows; this is the pool they are
 *  ranked out of. */
const MAX_REQUESTS = 30;

/**
 * Every request from the last HOME_FRESH_DAYS, most urgent first.
 *
 * `today` comes from `lisbon_today()` — the caller already holds it (Home reads
 * it for everything else), so this loader never has its own idea of what day it
 * is. One clock.
 */
export async function loadWorkerRequests(ctx: AuthContext, today: string | null): Promise<WorkerRequestItem[]> {
  const { db, companyId } = ctx;

  const since = new Date(Date.now() - HOME_FRESH_DAYS * 86_400_000).toISOString();
  const { data, error } = await db
    .from('worker_requests')
    .select('id, worker_id, task_id, text, category, needed_by, created_at')
    .eq('company_id', companyId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(MAX_REQUESTS);
  if (error) throw new Error(`worker_requests read failed: ${error.message}`);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  // Two follow-up queries rather than PostgREST embeds, for the same reason
  // loadInbox and loadPendingReviews avoid them: an embed alias depends on the
  // FK constraint's generated name, and a rename would break it silently.
  const workerIds = [...new Set(rows.map(r => r.worker_id))];
  const { data: workers } = await db
    .from('workers')
    .select('id, name')
    .eq('company_id', companyId)
    .in('id', workerIds);
  const nameById = new Map((workers ?? []).map(w => [w.id, w.name]));

  const taskIds = [...new Set(rows.map(r => r.task_id).filter((id): id is string => Boolean(id)))];
  const titleById = new Map<string, string>();
  if (taskIds.length > 0) {
    const { data: tasks } = await db.from('tasks').select('id, title').eq('company_id', companyId).in('id', taskIds);
    for (const t of tasks ?? []) titleById.set(t.id, t.title);
  }

  const items = rows.map(row => ({
    id: row.id,
    // A request whose crew row has vanished still has to render: the words were
    // said by somebody. Falls back to the empty string rather than "null", and
    // the renderers treat it as an unnamed person.
    workerName: nameById.get(row.worker_id) ?? '',
    text: row.text,
    category: coerceCategory(row.category),
    neededBy: row.needed_by,
    urgency: describeUrgency(row.needed_by, today),
    taskId: row.task_id,
    taskTitle: row.task_id ? (titleById.get(row.task_id) ?? null) : null,
    createdAt: row.created_at,
  }));

  // Most urgent first; within a bucket, the one that has been waiting longest.
  // A stable, total order, so the same day's Home always ranks the same way.
  return items.sort((a, b) => {
    const byUrgency = urgencyRank(a.urgency) - urgencyRank(b.urgency);
    if (byUrgency !== 0) return byUrgency;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}
