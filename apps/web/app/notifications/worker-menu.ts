import type { Db } from '@capo/db/client';
import {
  listFits,
  workerMenuRowId,
  type WhatsAppList,
  type WhatsAppListRow,
} from '@capo/core/channels/whatsapp';
import { loadWorkerTasks, type WorkerTaskRow } from '@capo/core/capabilities/worker';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { clamp, taskDetailLines, type BriefingTask } from './briefing';

// The GUIDED MENU — issue #49's third complaint, in Federico's own words:
// "not a free-flowing conversation, but just these pre-made boxes".
//
// A crew member taps a native WhatsApp list, picks one of their own tasks, and
// reads everything Capo knows about it. The whole round trip is DETERMINISTIC:
// no model runs in either direction, so it is instant, free, and structurally
// incapable of inventing a curing time or a material.
//
// ── WHY THIS IS NOT "THE AGENT WITH BUTTONS" ────────────────────────────────
// The restricted worker agent (PRD 4 / issue #22) is still there and still
// answers real questions — "que cola uso nisto?" is not a menu item and never
// will be. What changed is the DEFAULT. Before this, every message a crew
// member sent bought a model turn, and the most common message by far is "what
// am I doing today?", which is a database read wearing a question mark. Now:
//
//   a list row      → this file, zero model calls
//   a menu keyword  → this file, zero model calls
//   anything else   → the agent, exactly as before
//
// That ordering lives in the webhook route, below the check-in tap and below
// the language keyword, and above the agent. See handleWorkerReply.
//
// ── THE TENANT BOUNDARY ─────────────────────────────────────────────────────
// Everything here runs on the SERVICE-ROLE client (the webhook is a system
// caller, auth.uid() is null), so RLS enforces NOTHING. The boundary is
// loadWorkerTasks' two filters — `.eq('company_id')` and
// `.eq('assignee_worker_id')`, both derived from the PHONE/BSUID that resolved
// the sender, never from anything on the wire — plus the rule below that a
// tapped id must be FOUND IN that result. A guessed uuid, including a real one
// belonging to a colleague, is therefore refused in-process and never reaches
// the database as a lookup at all, so it cannot be timed as an existence
// oracle. Same shape and same reasoning as handleCheckinTap's notification_log
// read. Do not "optimise" this into `.eq('id', tappedId)`.

/**
 * How many task rows the menu offers before the rest is dropped.
 *
 * Meta allows 10 rows in total and one of ours is always the "talk to the boss"
 * row, so 9 is the ceiling. It is set lower on purpose: a list a crew member
 * has to scroll is a list they stop reading, and beyond a handful of tasks the
 * useful next step is a conversation with their supervisor, which is exactly
 * what the last row offers.
 */
const MAX_MENU_TASKS = 6;

/**
 * One of this worker's tasks, in the shape the shared renderers take.
 *
 * Converted from `WorkerTaskRow` (the agent's read of `task_board`) into
 * `BriefingTask` (the briefing's read of the same view) so that BOTH surfaces
 * render from one function. They are two projections of the same row, and the
 * conversion exists precisely so a crew member cannot be shown one thing at
 * 07:00 and a different thing when they tap the task at 09:15.
 *
 * `days_overdue` is not on the agent's projection, so the sheet uses
 * `detailOverdue` ("atrasada", no number) where the briefing uses `taskOverdue`
 * ("atrasada 3d"). Reported honestly rather than invented — `days_overdue: 0`
 * below is "unknown", and nothing reads it as a count.
 */
export function toBriefingTask(row: WorkerTaskRow): BriefingTask {
  return {
    id: row.id,
    title: row.title ?? '',
    job_name: row.job_name,
    overdue: row.overdue === true,
    days_overdue: 0,
    description: row.description,
    materials: row.materials ?? [],
    // `?? null` rather than the raw value: the field is optional on the row
    // because 0027 APPENDS the column, so a deploy landing first drops the
    // address line instead of printing "undefined".
    job_address: row.job_address ?? null,
    waiting_on: row.depends_on_titles ?? [],
    awaiting_review: row.status === 'pending_review',
    due_date: row.due_date,
  };
}

/**
 * A stored `YYYY-MM-DD` as a crew member reads it.
 *
 * Pinned to UTC deliberately. The value is a DATE, not an instant, and
 * formatting it through the runtime's zone would shift 2026-08-20 to the 19th
 * anywhere west of Greenwich — a deadline reported one day early, on the one
 * surface that exists to stop people guessing. Anything unparseable is returned
 * as-is rather than becoming "Invalid Date".
 */
function shortDate(iso: string, locale: Locale): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const at = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(getCatalog(locale).meta.dateLocale, {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  }).format(at);
}

/**
 * ── FEDERICO: this is what a crew member reads after tapping a task. ──
 *
 * The same facts as the 07:00 briefing's entry for that task — where, what,
 * what to bring, what it waits on — without the surrounding day. Rendered from
 * `taskDetailLines`, which the briefing also uses, so the two can never drift.
 *
 * A task with nothing recorded on it says so plainly and points at a person,
 * rather than sending back a lonely title that reads like a broken feature.
 */
export function renderTaskDetail(task: BriefingTask, locale: Locale): string {
  const t = getCatalog(locale).reminders;
  const named = task.job_name ? t.taskWithJob(task.title, task.job_name) : task.title;
  // Lateness is on the HEADLINE, exactly as it is in the briefing, because it
  // changes what somebody does first. It is added here rather than inside
  // taskDetailLines so the briefing does not say it twice — there it is already
  // part of the numbered line, with the day count this projection lacks.
  const labelled = task.overdue ? t.detailOverdue(named) : named;

  // The deadline, which the 07:00 briefing has no need to state (everything in
  // it is today) and this sheet does: a task opened from the menu carries no
  // surrounding day at all.
  const lines = [
    ...(task.due_date ? [t.detailDue(shortDate(task.due_date, locale))] : []),
    ...taskDetailLines(task, t),
  ];
  const body = lines.length > 0 ? lines.join('\n') : t.detailNothingMore;
  return `${t.detailHeader(labelled)}\n${body}`;
}

/**
 * The list itself: this worker's tasks, plus one row that is not a task.
 *
 * `body` is supplied by the caller rather than built here, because the two
 * callers have genuinely different things to say. The 07:00 briefing passes its
 * whole rendered briefing — the list is the SAME message, with the detail
 * behind a tap — and the keyword reply passes a short "pick one".
 *
 * Returns null when the body will not fit Meta's interactive-body cap. That is
 * not a failure and must not be treated as one: the caller then sends ordinary
 * text, which holds four times as much. A rich morning is worth more than a
 * menu, and the keyword still summons the menu afterwards.
 */
export function buildWorkerMenu(args: {
  tasks: readonly BriefingTask[];
  body: string;
  locale: Locale;
}): WhatsAppList | null {
  if (!listFits(args.body)) return null;

  const t = getCatalog(args.locale).whatsapp;
  const r = getCatalog(args.locale).reminders;

  // Overdue first, exactly as both briefing renderers order them: the two
  // surfaces must agree about what is urgent.
  const ordered = [...args.tasks].sort((a, b) => Number(b.overdue) - Number(a.overdue));

  const rows: WhatsAppListRow[] = ordered.slice(0, MAX_MENU_TASKS).map(task => ({
    id: workerMenuRowId({ kind: 'task', taskId: task.id }),
    // Clamped here as well as in buildListPayload. Clamping twice is not
    // belt-and-braces theatre: Meta's 24-char row title is brutally short and
    // clamping at the source is what lets a dictionary reason about the shape
    // it will actually produce.
    // Clamped BEFORE the fallback, not after: clamp() flattens whitespace, so a
    // title of three spaces is truthy at this line and empty by the time Meta
    // sees it — which is a 400, and on the keyword path that means this worker
    // can never open the menu again until somebody edits the title.
    title: clamp(task.title, 24) || clamp(r.workerNothing, 24),
    // The sub-line answers "which of the three Pinturas is this?" — the obra
    // first, because that is what distinguishes them, then the address.
    description: clamp([task.job_name, task.job_address].filter(Boolean).join(' · '), 72) || undefined,
  }));

  // ALWAYS last, and always present even when there are no tasks at all. This
  // is issue #49's "off-topic questions should get 'talk to your manager', not
  // an answer", made into a tappable thing rather than a sentence in a prompt.
  rows.push({
    id: workerMenuRowId({ kind: 'manager' }),
    title: clamp(t.workerMenuManagerRow, 24),
    description: clamp(t.workerMenuManagerNote, 72) || undefined,
  });

  return {
    body: args.body,
    button: t.workerMenuButton,
    section: t.workerMenuSection,
    rows,
  };
}

/**
 * The menu a crew member gets when they ASK for it, rather than at 07:00.
 *
 * Reads `loadWorkerTasks`, which filters `is_open` — task_board's DENYLIST — so
 * it shows more than the morning briefing does: a task the worker already
 * declared finished appears here, marked as waiting on the manager. That
 * asymmetry is deliberate and is the same one the board makes. BRIEFABLE (an
 * ALLOWLIST) still governs both daily sends and is untouched by this issue, so
 * nobody is nagged about work they have already reported.
 *
 * Returns null when they have no open tasks — the caller sends `workerMenuEmpty`
 * as plain text, because a list whose only row is "talk to the boss" reads as a
 * system with nothing to say.
 */
export async function loadWorkerMenu(
  db: Db,
  worker: { id: string; company_id: string },
  locale: Locale,
): Promise<{ list: WhatsAppList; tasks: BriefingTask[] } | null> {
  const rows = await loadWorkerTasks(db, worker.company_id, worker.id);
  if (rows.length === 0) return null;

  const tasks = rows.map(toBriefingTask);
  // BOTH numbers. `loadWorkerTasks` returns every open task (up to 40) and the
  // list shows at most MAX_MENU_TASKS of them, so telling somebody "you have 11
  // tasks" above six rows sends them looking for five that are not there.
  const list = buildWorkerMenu({
    tasks,
    body: getCatalog(locale).whatsapp.workerMenuBody(
      Math.min(tasks.length, MAX_MENU_TASKS),
      tasks.length,
    ),
    locale,
  });
  // buildWorkerMenu only returns null on a body that does not fit, and this
  // body is one short catalog sentence — so this branch is unreachable in
  // practice and is here so a future dictionary cannot make it a crash.
  return list ? { list, tasks } : null;
}

/**
 * Find the tapped task among THIS worker's own open tasks.
 *
 * The whole tenant boundary for the tap, and the reason it is a `find` over an
 * already-scoped read rather than a query on the tapped id. See the header.
 * Returns null for "not yours" and for "no longer open" alike — one outcome,
 * one sentence, no oracle.
 */
export async function findWorkerTask(
  db: Db,
  worker: { id: string; company_id: string },
  taskId: string,
): Promise<BriefingTask | null> {
  const rows = await loadWorkerTasks(db, worker.company_id, worker.id);
  const row = rows.find(r => r.id === taskId);
  return row ? toBriefingTask(row) : null;
}
