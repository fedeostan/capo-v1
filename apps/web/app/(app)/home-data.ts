import type { AuthContext } from '@capo/db/session';
import type { BoardTask } from '@capo/ui/dashboard-ui';
import {
  loadBoardTasks,
  loadMaterials,
  loadObras,
  loadPendingReviews,
  loadTeam,
  loadToday,
  type DashboardObra,
  type MaterialsGroup,
  type PendingReview,
} from '@/app/dashboard-data';
import { loadActivity, type ActivityEvent } from '@/app/activity/feed';
import { loadWorkerRequests, type WorkerRequestItem } from '@/app/notifications/worker-requests';

// Everything the Home launchpad shows, in ONE place, composed from loaders
// that already existed rather than new queries.
//
// THE POINT OF THIS FILE IS THAT IT ADDS NO NEW DEFINITION OF ANYTHING.
// "What is on today" comes from task_board via loadBoardTasks, exactly as the
// Tarefas board does; "what needs a decision" comes from loadPendingReviews,
// exactly as the board's review control does; "what to buy" comes from
// loadMaterials, exactly as the buy list does; "what happened" comes from
// loadActivity, exactly as the Atividade tab does. If Home re-derived any of
// them it would be a second opinion, and the failure is Capo telling the
// manager one thing while the screen he taps through to says another — the
// exact bug AGENTS.md's one-clock rule exists to prevent.
//
// It fails SOFT, per widget. A launchpad is the first screen of the app; one
// broken query must cost one card, never the whole screen. Each section
// answers empty on failure and the widget renders nothing.

export interface CrewCheckin {
  workerId: string;
  name: string;
  /** null = no answer recorded today. The design calls these "silent". */
  answer: 'done' | 'not_done' | null;
}

export interface HomeData {
  today: string | null;
  /** Tasks active today, soonest first, already cut to what Home shows. */
  todayTasks: BoardTask[];
  /** Every open task, for the "12 tasks open" line. */
  openTaskCount: number;
  activeSiteCount: number;
  /** The oldest pending review — the one decision Home puts a button on. */
  topReview: { review: PendingReview; task: BoardTask | null } | null;
  pendingReviewCount: number;
  recent: ActivityEvent[];
  crew: CrewCheckin[];
  materials: MaterialsGroup[];
  /** What the crew asked for (issue #152), most urgent first, already cut to
   *  what Home shows. Ranked by `needed_by` and plain subtraction — never by
   *  how urgent a message sounded. */
  requests: WorkerRequestItem[];
  /** Every fresh request, for the "+2 pedidos" line. */
  requestCount: number;
  /** What TODAY's work needs on site (issue #154) — a different question from
   *  `materials`, which is tomorrow's buy list. Same loader, third horizon. */
  materialsToday: MaterialsGroup[];
}

/** How many rows each widget shows before it defers to its own screen. Three
 *  is the handoff's number and it is the right kind of number: a launchpad
 *  that lists everything is the list screen it was meant to replace. */
const TASK_ROWS = 3;
const ACTIVITY_ROWS = 3;
const MATERIAL_ROWS = 2;
const REQUEST_ROWS = 2;

async function soft<T>(promise: Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    // Swallowed but greppable, the same posture as loadCompanySnapshot and
    // recordUsage. The cost is that a revoked grant presents as a card that
    // quietly stops appearing; grep these before concluding a quiet Home
    // means a quiet day.
    console.warn(`home.${label}_failed`, error instanceof Error ? error.message : error);
    return fallback;
  }
}

export async function loadHome(ctx: AuthContext): Promise<HomeData> {
  const today = await soft(loadToday(ctx), null, 'today');

  const [todayTasks, openTasks, obras, activity, crew, materials, requests, materialsToday] =
    await Promise.all([
    soft(
      // 'date' grouping: Home sorts by when, and the grouping argument only
      // decides the ORDER the rows come back in — Home renders a flat list and
      // never uses the sections.
      loadBoardTasks(ctx, { quando: { kind: 'keyword', value: 'hoje' }, obraId: null }, 'date'),
      [] as BoardTask[],
      'today_tasks',
    ),
    soft(
      loadBoardTasks(ctx, { quando: { kind: 'keyword', value: 'todas' }, obraId: null }, 'date'),
      [] as BoardTask[],
      'open_tasks',
    ),
    soft(loadObras(ctx), [] as DashboardObra[], 'obras'),
    soft(loadActivity(ctx, ACTIVITY_ROWS), [] as ActivityEvent[], 'activity'),
    soft(loadCrewToday(ctx, today), [] as CrewCheckin[], 'crew'),
    soft(loadMaterials(ctx, 'amanha', today), [] as MaterialsGroup[], 'materials'),
    // `today` is the SAME lisbon_today() every other widget uses, passed in
    // rather than read again: the urgency words on this card have to mean what
    // "hoje" means everywhere else in the app.
    soft(loadWorkerRequests(ctx, today), [] as WorkerRequestItem[], 'requests'),
    soft(loadMaterials(ctx, 'hoje', today), [] as MaterialsGroup[], 'materials_today'),
  ]);

  // Reviews are keyed by task id, so they need the open board to look up
  // against — which is already loaded above rather than fetched again.
  const reviews = await soft(
    loadPendingReviews(
      ctx,
      openTasks.map(t => t.id),
    ),
    new Map<string, PendingReview>(),
    'reviews',
  );

  // The OLDEST claim, not the newest: a completion claim sitting unanswered is
  // the one that is costing somebody. `declaredAt` is an ISO string, so a
  // plain string compare is a chronological compare.
  const sorted = [...reviews.values()].sort((a, b) => (a.declaredAt < b.declaredAt ? -1 : 1));
  const top = sorted[0] ?? null;

  return {
    today,
    todayTasks: todayTasks.slice(0, TASK_ROWS),
    openTaskCount: openTasks.length,
    // `dashboard_obras` carries active AND paused since 0038, so Home has to
    // say which it means rather than counting rows. "Activas" means active.
    activeSiteCount: obras.filter(o => o.status === 'active').length,
    topReview: top ? { review: top, task: openTasks.find(t => t.id === top.taskId) ?? null } : null,
    pendingReviewCount: reviews.size,
    recent: activity,
    crew,
    materials: materials.slice(0, MATERIAL_ROWS),
    requests: requests.slice(0, REQUEST_ROWS),
    requestCount: requests.length,
    // Groups with no materials recorded are kept by the loader on purpose —
    // they are the ones a manager wants to ADD to, and the materials screen
    // renders them as an empty group with the "add" control inside. On Home
    // there is no such control and the row would be a blank line, so the card
    // shows only the obras that actually have something to check.
    materialsToday: materialsToday.filter(g => g.items.length > 0).slice(0, MATERIAL_ROWS),
  };
}

// Who answered the late-afternoon check-in today, and who did not.
//
// Every ACTIVE crew member is listed, not just the ones with a row — the whole
// point of the widget is the people who did NOT answer, and they are exactly
// the ones `worker_checkins` has nothing for. A read that only joined answers
// would show a full crew every day and never a silent one.
async function loadCrewToday(ctx: AuthContext, today: string | null): Promise<CrewCheckin[]> {
  const team = await loadTeam(ctx);
  const active = team.filter(w => w.active);
  if (active.length === 0 || !today) return [];

  const { data } = await ctx.db
    .from('worker_checkins')
    .select('worker_id, answer')
    .eq('company_id', ctx.companyId)
    .eq('checkin_date', today);

  const answers = new Map((data ?? []).map(r => [r.worker_id, r.answer as 'done' | 'not_done']));
  return active.map(w => ({ workerId: w.id, name: w.name, answer: answers.get(w.id) ?? null }));
}
