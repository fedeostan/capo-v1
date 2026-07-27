import type { Db } from '@capo/db/client';
import { coerceLocale, type Locale } from '@capo/i18n/locale';
import { getCatalog } from '@capo/i18n/catalog';

// The 07:00 briefing, rendered.
//
// Deliberately here and not in @capo/core: this is a delivery concern of the
// web app (which already owns the WhatsApp webhook), and it needs the USER copy
// catalog. @capo/core only ever imports @capo/i18n/locale — pulling
// @capo/i18n/catalog into it would drag every UI string into the agent bundle.
//
// Deliberately deterministic, with no model call. The output has to be short,
// newline-free (Meta rejects newlines in template parameters) and identical to
// what the Tarefas board shows. A per-worker LLM call each morning would add
// cost, latency and a failure mode, and buy nothing.

/** One row of task_board, narrowed to what a briefing actually reads. */
export interface BriefingTask {
  id: string;
  title: string;
  job_name: string | null;
  overdue: boolean;
  days_overdue: number;
}

export interface WorkerBriefing {
  workerId: string;
  name: string;
  /** E.164, with the '+'. */
  phone: string;
  locale: Locale;
  tasks: BriefingTask[];
}

export interface ManagerCounts {
  today: number;
  unassigned: number;
  overdue: number;
}

export interface CompanyBriefing {
  companyId: string;
  companyLocale: Locale;
  workers: WorkerBriefing[];
  counts: ManagerCounts;
}

// Tasks a worker should be told about. `blocked` is excluded on purpose: the
// SMS view drew that line first (0005_dashboard.sql — "SMS does not nag about
// it") and a channel swap is no reason to start nagging.
const BRIEFABLE = new Set(['pending', 'in_progress']);

/**
 * Everything the cron needs for one company, in one read.
 *
 * Reads `task_board` and nothing else, per the house rule that "what is on
 * today" has exactly one definition, in SQL. `active_today` and `overdue` are
 * precomputed columns on the view — we filter on them, we never recompute
 * them from dates here. `select('*')` so that a deploy landing before its
 * migration degrades instead of erroring.
 */
export async function loadCompanyBriefing(
  db: Db,
  companyId: string,
  companyLanguage: string | null,
): Promise<CompanyBriefing> {
  const companyLocale = coerceLocale(companyLanguage);

  const [{ data: rows, error: boardError }, { data: crew, error: crewError }] = await Promise.all([
    db.from('task_board').select('*').eq('company_id', companyId).eq('is_open', true),
    db.from('workers').select('id, name, phone, language').eq('company_id', companyId).eq('active', true),
  ]);
  if (boardError) throw new Error(`task_board read failed: ${boardError.message}`);
  if (crewError) throw new Error(`workers read failed: ${crewError.message}`);

  const open = rows ?? [];
  const todayRows = open.filter(r => r.active_today === true && BRIEFABLE.has(r.status ?? ''));

  const byWorker = new Map<string, BriefingTask[]>();
  for (const row of todayRows) {
    if (!row.assignee_worker_id || !row.id || !row.title) continue;
    const list = byWorker.get(row.assignee_worker_id) ?? [];
    list.push({
      id: row.id,
      title: row.title,
      job_name: row.job_name,
      overdue: row.overdue === true,
      days_overdue: row.days_overdue ?? 0,
    });
    byWorker.set(row.assignee_worker_id, list);
  }

  // A worker with no phone cannot be reached at all — /perfil already warns
  // the manager about exactly this, so it is not a silent drop.
  const workers: WorkerBriefing[] = (crew ?? [])
    .filter((w): w is typeof w & { phone: string } => Boolean(w.phone))
    .map(w => ({
      workerId: w.id,
      name: w.name,
      phone: w.phone,
      // NULL means "inherit the company"; the worker sets this themselves by
      // replying a keyword to their briefing.
      locale: w.language ? coerceLocale(w.language) : companyLocale,
      tasks: byWorker.get(w.id) ?? [],
    }));

  return {
    companyId,
    companyLocale,
    workers,
    counts: {
      today: todayRows.length,
      unassigned: todayRows.filter(r => !r.assignee_worker_id).length,
      overdue: open.filter(r => r.overdue === true).length,
    },
  };
}

// How many tasks fit in one message before it stops being scannable on a phone
// at 07:00. Beyond this the list is truncated and the remainder becomes "+N".
const MAX_LISTED = 5;

/**
 * ── FEDERICO: this is the product-voice dial for the whole feature. ──
 *
 * Turns one worker's day into the template's two body parameters:
 * `[name, taskList]`. Both are passed through toTemplateParam() by the sender,
 * which flattens whitespace — so returning newlines here is safe but pointless,
 * they become spaces.
 *
 * The judgement calls baked in below, all of which are yours to change:
 *   - MAX_LISTED = 5, then "+N". A bricklayer with eleven tasks gets a wall of
 *     text otherwise.
 *   - The obra name is shown in parentheses, because "Pintar paredes" alone is
 *     ambiguous for someone working two sites in a week.
 *   - Overdue tasks are marked with their age rather than sorted away, and are
 *     listed FIRST — they are the ones that need a decision, not just doing.
 *   - A worker with nothing today still gets a message (`workerNothing`).
 *     Returning null instead would save a paid template send per idle worker
 *     per day; `status: 'skipped'` in notification_log exists for that case.
 *     Silence, though, reads as "the system forgot me".
 */
export function renderWorkerBriefing(briefing: WorkerBriefing): [name: string, taskList: string] {
  const t = getCatalog(briefing.locale).reminders;
  if (briefing.tasks.length === 0) return [briefing.name, t.workerNothing];

  const ordered = [...briefing.tasks].sort((a, b) => Number(b.overdue) - Number(a.overdue));
  const shown = ordered.slice(0, MAX_LISTED);

  const parts = shown.map(task => {
    const labelled = task.job_name ? t.taskWithJob(task.title, task.job_name) : task.title;
    return task.overdue && task.days_overdue > 0 ? t.taskOverdue(labelled, task.days_overdue) : labelled;
  });
  if (ordered.length > shown.length) parts.push(t.andMore(ordered.length - shown.length));

  return [briefing.name, parts.join(t.taskSeparator)];
}

/** The manager's two body parameters. */
export function renderManagerBriefing(
  name: string,
  counts: ManagerCounts,
  locale: Locale,
): [name: string, summary: string] {
  const t = getCatalog(locale).reminders;
  return [name, counts.today === 0 ? t.managerNothing : t.managerSummary(counts)];
}

/**
 * The line written into the company's chat thread. Not a template parameter,
 * so it may be longer and may contain newlines — and unlike the WhatsApp push
 * it is permanent, which is the point: the thread is where the manager can
 * later ask "what did you send the crew on Tuesday?".
 */
export function renderManagerEvent(counts: ManagerCounts, notified: number, locale: Locale): string {
  return getCatalog(locale).reminders.managerEvent({ ...counts, notified });
}
