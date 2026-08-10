import { addWorkdays, countWorkdays, nextWorkday, workdayAfter, workdayDelta } from './workdays';

// Cascade rescheduling — the pure half.
//
// NO `Db`, no `Date.now()`, no locale, no import of createProposal. That is
// the same split plan-apply.ts describes at its head, and here it is not
// aesthetics: scripts/scheduler-check.mts is the ONLY automated correctness
// gate in this repo (AGENTS.md), it must keep running with no credentials and
// no network, and this is the highest-risk pure function in the codebase — it
// proposes moving dates on live jobs.
//
// ── why scheduleTasks (plan.ts) cannot be reused ───────────────────────────
// 1. It keys on a plan `key`, not a task id.
// 2. It has ONE global start-date floor. A cascade needs a per-task floor,
//    because each task is held back by its own predecessors' real finishes.
// 3. It has no notion of completed work. A finished predecessor should
//    contribute the workday after it ACTUALLY finished, not after the date it
//    was once planned to finish — that difference is the entire feature.
// 4. It always rewrites every task (`earliestStart` initialises to the plan
//    start), so anything not downstream of the change gets dragged to the
//    anchor date. On a live job that is catastrophic, which is why nothing
//    outside `movable` is ever written here.

export type ExistingTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'pending_review'
  | 'done'
  | 'cancelled';

export interface ExistingTask {
  id: string;
  status: ExistingTaskStatus;
  start_date: string | null;
  due_date: string | null;
  /** Nullable since 0010 — every task created before the planner existed. */
  duration_days: number | null;
  depends_on_task_ids: readonly string[];
}

export interface RescheduleChange {
  task_id: string;
  from: { start_date: string | null; due_date: string | null };
  to: { start_date: string; due_date: string };
  /** Signed WORKDAY delta; negative = pulled earlier. See shiftOf() below. */
  shift_days: number;
}

export interface DependencyEdge {
  task_id: string;
  depends_on_task_id: string;
}

/** A dependency cycle, or anything else that makes a schedule unanswerable. */
export class RescheduleError extends Error {}

// Returning CHANGES rather than tasks is deliberate on three counts: the card
// renders a diff, which is the only thing a manager can actually judge;
// "nothing moved" becomes an explicit empty array instead of a silent 30-row
// rewrite; and the `from` side is what lets execution compare-and-set, so a
// card left open overnight cannot stomp a manual edit made in between.

/**
 * Transitive dependents of `roots` — everything downstream that would have to
 * move if a root moved. The roots themselves are excluded from the result
 * (a task is not its own dependent), even when a cycle would otherwise walk
 * back to one.
 */
export function dependentsClosure(edges: readonly DependencyEdge[], roots: readonly string[]): Set<string> {
  const dependentsOf = new Map<string, string[]>();
  for (const edge of edges) {
    const list = dependentsOf.get(edge.depends_on_task_id);
    if (list) list.push(edge.task_id);
    else dependentsOf.set(edge.depends_on_task_id, [edge.task_id]);
  }

  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const dependent of dependentsOf.get(current) ?? []) {
      // The `seen` guard is what makes this terminate on a cyclic edge set.
      // recomputeSchedule refuses cycles outright; this helper must not hang
      // before it gets the chance to say so.
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      queue.push(dependent);
    }
  }
  for (const root of roots) seen.delete(root);
  return seen;
}

/**
 * Dependency-first order over the loaded tasks.
 * Throws RescheduleError on a cycle rather than silently dropping the back
 * edge the way scheduleTasks does: that is safe for MODEL output, which is
 * zod-validated as a DAG before it ever reaches the scheduler, but
 * task_dependencies has no anti-cycle constraint in SQL, so DB edges have
 * never been checked by anything. A plausible-looking schedule derived from a
 * cyclic graph is worse than an error.
 */
function topologicalOrder(byId: ReadonlyMap<string, ExistingTask>): string[] {
  const DONE = 2;
  const VISITING = 1;
  const state = new Map<string, number>();
  const order: string[] = [];

  const visit = (id: string, trail: readonly string[]): void => {
    const seen = state.get(id);
    if (seen === DONE) return;
    if (seen === VISITING) {
      throw new RescheduleError(`Dependency cycle: ${[...trail.slice(trail.indexOf(id)), id].join(' → ')}`);
    }
    state.set(id, VISITING);
    for (const dep of byId.get(id)?.depends_on_task_ids ?? []) {
      // Edges pointing outside the loaded set are not constraints we can
      // evaluate, so they are ignored rather than guessed at.
      if (byId.has(dep)) visit(dep, [...trail, id]);
    }
    state.set(id, DONE);
    order.push(id);
  };

  for (const id of byId.keys()) visit(id, []);
  return order;
}

/**
 * How long this task takes, in working days.
 * duration_days when it has one; otherwise read back off its existing span,
 * so a pre-planner task keeps the length it visibly has on the board rather
 * than being silently collapsed to a single day.
 */
function durationOf(task: ExistingTask): number {
  if (task.duration_days != null && task.duration_days > 0) return task.duration_days;
  if (task.start_date && task.due_date && task.due_date >= task.start_date) {
    return Math.max(1, countWorkdays(task.start_date, task.due_date));
  }
  return 1;
}

/**
 * The earliest day a dependent of `task` may start — or null when this
 * predecessor imposes no constraint at all.
 *
 * `cancelled` contributes NOTHING, on purpose: cancelled work is never going
 * to finish, so holding successors behind it would freeze the job forever. If
 * every predecessor is cancelled the successor becomes an effective root and
 * floors at today.
 *
 * For a finished predecessor the constraint is the workday after it ACTUALLY
 * finished (`completedOn`), not after the date it was once planned to finish.
 * `pending_review` counts as finished HERE and only here: the worker says the
 * work is done, so downstream can pull in — but see `movable` below, where it
 * counts as immovable, and task_board.is_open, where it stays open. The
 * cascade therefore fires on an UNVERIFIED claim, which is precisely why it
 * can only ever produce a card.
 */
function constraintOf(
  task: ExistingTask,
  effective: { start: string | null; due: string | null },
  completedOn: Readonly<Record<string, string>>,
): string | null {
  if (task.status === 'cancelled') return null;
  const finish = completedOn[task.id] ?? effective.due;
  return finish ? workdayAfter(finish) : null;
}

/**
 * The number printed on each row of the card. Measured on the DUE date when
 * the task had one: that is the date the manager tracks, it is what the
 * overdue chip keys off, and for an in_progress task (whose start is pinned)
 * it is the only thing that CAN move. Falls back to the start date, and to 0
 * for a task that had no dates at all.
 *
 * Exported because render.ts re-derives this number from the stored payload
 * rather than trusting a carried field — one rule, one implementation, so the
 * card's "-2 dias úteis" can never disagree with the dates printed beside it.
 */
export function shiftDaysBetween(
  from: { start_date: string | null; due_date: string | null },
  to: { start_date: string; due_date: string },
): number {
  if (from.due_date) return workdayDelta(from.due_date, to.due_date);
  if (from.start_date) return workdayDelta(from.start_date, to.start_date);
  return 0;
}

/**
 * Recompute dates for `movable` given what has actually been completed.
 *
 * Nothing outside `movable` is ever emitted, and every computed start is
 * clamped to the next workday on or after `today` — a cascade that proposes
 * past dates reads as nonsense to the manager and would immediately re-fire
 * task_board.risk_late_start.
 *
 * Throws RescheduleError on a dependency cycle.
 */
export function recomputeSchedule(input: {
  tasks: readonly ExistingTask[];
  /** db.rpc('lisbon_today') — one clock, never new Date(). */
  today: string;
  /** Actual finish dates by task id. This is what makes it a cascade. */
  completedOn: Readonly<Record<string, string>>;
  /** ONLY these ids may be written. Everything else is a fixed constraint. */
  movable: ReadonlySet<string>;
}): RescheduleChange[] {
  const byId = new Map(input.tasks.map(task => [task.id, task]));
  const order = topologicalOrder(byId);

  const groundFloor = nextWorkday(input.today);
  const effective = new Map<string, { start: string | null; due: string | null }>();
  const changes: RescheduleChange[] = [];

  for (const id of order) {
    const task = byId.get(id);
    if (!task) continue;

    if (!input.movable.has(id)) {
      effective.set(id, { start: task.start_date, due: task.due_date });
      continue;
    }

    let floor: string | null = null;
    for (const depId of task.depends_on_task_ids) {
      const dep = byId.get(depId);
      if (!dep) continue;
      const dates = effective.get(depId) ?? { start: dep.start_date, due: dep.due_date };
      const constraint = constraintOf(dep, dates, input.completedOn);
      if (constraint && (floor === null || constraint > floor)) floor = constraint;
    }

    // Work that has begun cannot be moved to a different start day — saying so
    // would be a lie about the site. Only its finish is recomputed. `blocked`
    // counts as not-yet-started and stays fully movable.
    const pinned = task.status === 'in_progress' ? task.start_date : null;
    const start = pinned ?? nextWorkday(floor && floor > groundFloor ? floor : groundFloor);
    const computedDue = addWorkdays(start, durationOf(task));
    // The clamp has to be applied AGAIN on the due side, and only the pinned
    // branch needs it: an unpinned start is already >= groundFloor so its due
    // cannot land in the past, but a task that began three weeks ago with a
    // 2-day duration recorded would otherwise be proposed as due before today
    // — an instantly-overdue deadline, which is exactly the nonsense the clamp
    // exists to prevent.
    const due = pinned && computedDue < groundFloor ? groundFloor : computedDue;

    effective.set(id, { start, due });
    if (start === task.start_date && due === task.due_date) continue;
    changes.push({
      task_id: id,
      from: { start_date: task.start_date, due_date: task.due_date },
      to: { start_date: start, due_date: due },
      shift_days: shiftDaysBetween(task, { start_date: start, due_date: due }),
    });
  }

  return changes;
}
