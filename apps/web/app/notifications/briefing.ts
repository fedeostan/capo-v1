import type { Db } from '@capo/db/client';
import type { CheckinAnswer, WhatsAppRecipient } from '@capo/core/channels/whatsapp';
import { readCollaborators } from '@capo/core/capabilities/collaborators';
import { coerceLocale, type Locale } from '@capo/i18n/locale';
import { getCatalog } from '@capo/i18n/catalog';
import { hasWhatsAppConsent, recipientFor } from '../../lib/whatsapp';

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
  /**
   * The two fields that answer "what am I actually doing, and what do I bring?"
   * — read only by the FREE-FORM renderer. They cannot go in the template: a
   * template parameter is one line, and Meta rejects a newline outright (132000).
   *
   * Both are stored in companies.language and are never retranslated (0014), so
   * a worker on 'es-ES' reads Spanish sentences wrapping Portuguese content —
   * the same trade-off task titles already make.
   */
  description: string | null;
  materials: string[];
  /**
   * WHERE (issue #49, complaint 1). `jobs.address`, appended to the task_board
   * view by 0027 and — until this change — read by nothing that ever spoke to a
   * crew member. It is the first thing somebody standing in a van at 07:00
   * needs and the only reason left to phone the manager before starting.
   *
   * OPTIONAL on the row, `null` here, for the reason AGENTS.md gives for
   * `select('*')`: a deploy landing before 0027 simply has no such column, and
   * the line is then omitted rather than the read failing.
   */
  job_address: string | null;
  /**
   * The titles of the tasks this one is waiting on (`depends_on_titles`).
   *
   * Shown because "I turned up and the floor wasn't ready" is a wasted morning
   * that the board already knew about. It is NOT a claim that those tasks are
   * unfinished — the view lists every predecessor — so the copy says "depends
   * on", never "blocked by".
   */
  waiting_on: string[];
  /**
   * This task is `pending_review`: somebody already declared it finished and
   * the manager has not confirmed yet.
   *
   * Never in the 07:00 briefing — BRIEFABLE is an allowlist of
   * pending/in_progress and is deliberately UNCHANGED by this issue, so a task
   * in review is not nagged about in either daily send. It reaches a worker
   * only through the guided menu, which reads `is_open` (a denylist) so the
   * task is visible rather than vanished. See AGENTS.md on pending_review.
   */
  awaiting_review: boolean;
  /**
   * The task's own deadline, as stored (`YYYY-MM-DD`), or null.
   *
   * Read only by the guided menu's task sheet, which has no surrounding day to
   * put a task in context — the 07:00 briefing does not need it, because
   * everything in it is today by construction. Formatted at the point of use;
   * never at 07:00.
   */
  due_date: string | null;
  /**
   * WHICH OF THE TWO PEOPLE READING THIS TASK THIS PERSON IS (issue #44).
   *
   * The same task now appears in more than one worker's briefing: once for the
   * LEAD (`tasks.assignee_worker_id`, still the only authoritative answer to
   * "whose job is this") and once for each COLLABORATOR. Both read the same
   * row, the same address and the same materials — one task, one materials
   * list, which is the entire point of the issue.
   *
   * What must differ is the sentence. A collaborator who reads a briefing that
   * sounds like the job is theirs is the failure this field exists to prevent;
   * see `taskAsCollaborator` in @capo/i18n.
   */
  role: 'lead' | 'collaborator';
  /**
   * The LEAD's name, for a `role: 'collaborator'` row. `task_board.worker_name`,
   * already on the wire.
   *
   * Optional and nullable, and both cases mean the same thing: no lead to name,
   * so the copy falls to `taskAsTeam`, which claims nothing about anybody.
   * Reachable because `tasks.assignee_worker_id` is nullable and clearing it
   * does not delete anyone's collaborator row.
   */
  lead_name?: string | null;
  /**
   * The COLLABORATORS' names, for a `role: 'lead'` row — so the person
   * accountable for the job knows who else is turning up.
   *
   * Optional because 0035 APPENDS the column to `task_board`: a deploy landing
   * before its migration reads `undefined`, which is treated as "nobody", and
   * the line is simply omitted. Never trusted straight off the row — see
   * `readCollaborators`.
   */
  collaborator_names?: string[];
}

export interface WorkerBriefing {
  workerId: string;
  name: string;
  /**
   * Where to send, and in which envelope field — the phone when we have one,
   * otherwise the stored BSUID. Resolved HERE rather than in each cron because
   * both proactive sends read this function, and two copies of the preference
   * would eventually disagree about who is reachable.
   */
  recipient: WhatsAppRecipient;
  locale: Locale;
  /**
   * Has this crew member ever CHOSEN their language, rather than inheriting the
   * company's? `workers.language is not null` — the third dial, which is
   * nullable precisely so that null means "inherit" (AGENTS.md).
   *
   * Read for one reason: with `lastInboundAt` it is the whole of what we know
   * about whether this person has ever engaged with Capo, and therefore the
   * whole basis for showing the language line once instead of forever. See
   * renderWorkerBriefing.
   */
  hasChosenLanguage: boolean;
  tasks: BriefingTask[];
  /**
   * When this worker last wrote to us (0030), or null when there is no inbound
   * on record. The ONLY input to the template-vs-free-form decision — see
   * withinFreeFormWindow, which fails closed toward the paid template on
   * anything it cannot read, this null included.
   *
   * Typed `string | null` rather than read straight off the row because the
   * generated DB types lead the live schema here: on a deploy that lands before
   * 0030 the column simply is not there, `select('*')` returns undefined for it,
   * and undefined reads as "no inbound on record" — degrading to today's
   * behaviour rather than erroring.
   */
  lastInboundAt: string | null;
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
  /**
   * Active workers we could address who were dropped for want of a recorded
   * WhatsApp opt-in. Reported rather than silently swallowed: after 0025 every
   * pre-existing worker starts without consent, so "Capo has gone quiet" is the
   * expected first symptom and this is the number that explains it. Each route
   * logs it.
   */
  excludedNoConsent: number;
  /**
   * Active workers with NO usable address at all — neither a phone nor a stored
   * BSUID. Counted for the same reason excludedNoConsent is: a worker dropped
   * before the send loop can even see them is otherwise indistinguishable from
   * a worker who had nothing to do, and "Capo never messages João" needs a
   * number somewhere that explains it.
   */
  excludedUnreachable: number;
  /**
   * Crew rows marked `active = false`. Counted because they were, until #54,
   * the ONE way to disappear from both daily sends with no trace anywhere: the
   * `active` filter ran in the SQL, so an inactive worker was gone before
   * `excludedUnreachable` and `excludedNoConsent` could ever see them, and
   * appeared in no signal at all.
   *
   * That is exactly how issue #51 lost half a day. Federico's own crew row on
   * Ostan construcciones is inactive, so a task assigned to it produces no
   * 07:00 briefing and no afternoon check-in — correct behaviour, invisibly
   * applied, and indistinguishable from a broken cron.
   *
   * Deliberately NOT a filter change: an inactive worker must keep being
   * skipped. This only makes the skip countable, and both cron routes log it.
   */
  excludedInactive: number;
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
    // select('*') rather than a column list, for the same reason the task_board
    // read above uses it: 0025 adds the two consent columns, and a deploy that
    // lands before its migration would otherwise fail the whole read with an
    // unknown-column error instead of degrading. Degrading here means every
    // worker reads as "no consent on record" and nothing is sent — the
    // fail-closed direction, and a loud one.
    //
    // The `active` filter moved OUT of this query and into TypeScript below
    // (#54). Not to change who is messaged — an inactive crew row is still
    // skipped, and must be — but so that the skip can be COUNTED. Filtered in
    // SQL, an inactive worker vanished before either exclusion counter could
    // see them, which is why issue #51's silent worker took a log dive and a
    // database session to explain.
    db.from('workers').select('*').eq('company_id', companyId),
  ]);
  if (boardError) throw new Error(`task_board read failed: ${boardError.message}`);
  if (crewError) throw new Error(`workers read failed: ${crewError.message}`);

  const open = rows ?? [];
  const todayRows = open.filter(r => r.active_today === true && BRIEFABLE.has(r.status ?? ''));

  const byWorker = new Map<string, BriefingTask[]>();
  for (const row of todayRows) {
    if (!row.id || !row.title) continue;

    // ── the fan-out (issue #44) ───────────────────────────────────────────
    // ONE row, read once, rendered for everybody on it. `collaborator_*` come
    // from task_board's 0035 columns, index-aligned by construction — the view
    // aggregates both with the same ORDER BY. Reading them here rather than in
    // a second query is what keeps "who is on this task" a single definition in
    // SQL, exactly like "what is on today".
    const collaborators = readCollaborators(row);
    const leadId = row.assignee_worker_id;
    // A row with neither a lead nor a collaborator reaches nobody. Skipped
    // BEFORE the shared object is built, so an unassigned task costs nothing.
    if (!leadId && collaborators.length === 0) continue;

    // Built once and shared by reference across every reader of this task. That
    // is not a micro-optimisation, it is the proof the issue asks for: there is
    // exactly one `materials` array per task in this whole function, so two
    // people on one task cannot possibly produce two van-loads. `role` and the
    // two name fields are the ONLY things that differ per reader, and they are
    // spread on below.
    const shared = {
      id: row.id,
      title: row.title,
      job_name: row.job_name,
      overdue: row.overdue === true,
      days_overdue: row.days_overdue ?? 0,
      description: row.description,
      // `materials` is a Postgres text[]; null and an empty array mean the same
      // thing to a reader, so they are collapsed here rather than at each use.
      materials: Array.isArray(row.materials) ? row.materials.filter(Boolean) : [],
      // Read through an index for the same reason readLastInboundAt is: 0027
      // APPENDS this column to the view, the generated types lead the live
      // schema, and a deploy landing first must drop the address line rather
      // than fail the whole morning read.
      job_address: readOptionalText(row, 'job_address'),
      waiting_on: Array.isArray(row.depends_on_titles) ? row.depends_on_titles.filter(Boolean) : [],
      awaiting_review: row.status === 'pending_review',
      due_date: row.due_date ?? null,
    };

    const push = (workerId: string, task: BriefingTask) => {
      byWorker.set(workerId, [...(byWorker.get(workerId) ?? []), task]);
    };

    if (leadId) {
      push(leadId, { ...shared, role: 'lead', collaborator_names: collaborators.map(c => c.name) });
    }
    for (const collaborator of collaborators) {
      // `worker_name` is the LEAD's name on this row — task_board joins workers
      // on assignee_worker_id (0013:38). Null when the task has no lead, which
      // the copy handles by naming nobody.
      push(collaborator.id, { ...shared, role: 'collaborator', lead_name: row.worker_name });
    }
  }

  const { messageable: consenting, excludedNoConsent, excludedUnreachable, excludedInactive } =
    partitionCrew(crew ?? []);

  const workers: WorkerBriefing[] = consenting.map(({ worker, recipient }) => ({
    workerId: worker.id,
    name: worker.name,
    recipient,
    // NULL means "inherit the company"; the worker sets this themselves by
    // replying a keyword to their briefing.
    locale: worker.language ? coerceLocale(worker.language) : companyLocale,
    hasChosenLanguage: !!worker.language,
    tasks: byWorker.get(worker.id) ?? [],
    lastInboundAt: readLastInboundAt(worker),
  }));

  return {
    companyId,
    companyLocale,
    workers,
    excludedNoConsent,
    excludedUnreachable,
    excludedInactive,
    counts: {
      today: todayRows.length,
      unassigned: todayRows.filter(r => !r.assignee_worker_id).length,
      overdue: open.filter(r => r.overdue === true).length,
    },
  };
}

/**
 * A crew row, narrowed to the four questions "may we message this person, and
 * where?" actually asks. Deliberately structural rather than the generated
 * `workers` row type, so the same function serves a `select('*')` whose columns
 * lead or lag the live schema (see readLastInboundAt on why that happens).
 */
export interface AddressableCrewRow {
  active?: boolean | null;
  phone?: string | null;
  whatsapp_user_id?: string | null;
  whatsapp_opt_in_at?: string | null;
  whatsapp_opt_out_at?: string | null;
}

export interface CrewPartition<T> {
  /** Active, addressable, consenting — the only people a send may reach. */
  messageable: { worker: T; recipient: WhatsAppRecipient }[];
  excludedNoConsent: number;
  excludedUnreachable: number;
  excludedInactive: number;
}

/**
 * ── THE CONSENT GATE, AND THE ONLY ONE ─────────────────────────────────────
 *
 * Split out of loadCompanyBriefing when the WELCOME send (issue #45) needed the
 * same three questions asked in the same order, over the same crew table, at a
 * completely different time of day. Copying the filter would have put a second
 * copy of a consent rule in the codebase — the one thing 0025 and AGENTS.md
 * both say must never happen, because two copies eventually disagree and the
 * symptom is a person one send reaches and another silently skips.
 *
 * So now every proactive send in the product — the 07:00 briefing, the
 * late-afternoon check-in, and the welcome — reaches its crew through this
 * function, and `hasWhatsAppConsent` is called from exactly one place for them.
 * (Managers are the documented exception: they have no `workers` row, so the
 * routes call the same predicate directly on their profile, as /api/cron/reminders
 * has always done.)
 *
 * The three exclusions PARTITION the crew — nobody is counted twice, and
 * messageable + the three counts equals the input length. That is asserted by
 * `pnpm whatsapp-check`, and it is what makes "Capo has gone quiet" a question
 * with a numeric answer rather than a log dive.
 *
 * `active !== true`, not `active === false`: the column is typed nullable and a
 * null must fall on the skipped side, exactly where `.eq('active', true)` used
 * to put it before the filter moved out of SQL (#54).
 *
 * A worker with NEITHER a phone nor a stored BSUID cannot be reached at all.
 * The BSUID half only ever fills in for someone Meta has stopped giving us a
 * number for, and it cannot be populated out of thin air: a BSUID is revealed
 * only on an inbound message, so a worker reaches that branch only after having
 * written to us at least once (see captureBsuid in the webhook route).
 */
export function partitionCrew<T extends AddressableCrewRow>(crew: T[]): CrewPartition<T> {
  const active = crew.filter(w => w.active === true);

  const reachable = active.flatMap(worker => {
    const recipient = recipientFor(worker);
    return recipient ? [{ worker, recipient }] : [];
  });

  const messageable = reachable.filter(({ worker }) => hasWhatsAppConsent(worker));

  return {
    messageable,
    excludedNoConsent: reachable.length - messageable.length,
    // Against `active`, not the whole crew — otherwise every inactive worker
    // would also be counted as unreachable and the two numbers would
    // double-count the same person.
    excludedUnreachable: active.length - reachable.length,
    excludedInactive: crew.length - active.length,
  };
}

/**
 * Read `last_inbound_at` off a row that may not have the column yet.
 *
 * 0030 adds it; a deploy that lands before the migration gets `undefined` from
 * `select('*')`, and the generated DB types are hand-maintained and may lead or
 * lag either way. Rather than let that be a `tsc` error or a runtime surprise,
 * the value is read through an index and validated: anything that is not a
 * non-empty string becomes null, which withinFreeFormWindow reads as "no proof"
 * and answers with a template. One narrow cast, in one place, with the failure
 * pointing the safe way.
 */
export function readLastInboundAt(row: object): string | null {
  return readOptionalText(row, 'last_inbound_at');
}

/**
 * Read a text column off a row that may not have it yet.
 *
 * The general form of readLastInboundAt's narrow cast, extracted when
 * `job_address` needed the same treatment (0027 APPENDS it to `task_board`).
 * Anything that is not a non-empty string reads as absent, which every caller
 * treats as "say nothing" rather than "say something wrong".
 */
function readOptionalText(row: object, column: string): string | null {
  const value = (row as Record<string, unknown>)[column];
  return typeof value === 'string' && value ? value : null;
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
export interface WorkerBriefingOptions {
  /**
   * Append "reply PT, ES or EN to change language" to the task-list parameter.
   *
   * ── ISSUE #49, COMPLAINT 2, AND WHY IT LIVES HERE ──────────────────────────
   * That sentence used to be part of the APPROVED TEMPLATE BODY, which meant it
   * went out with every single briefing, to everybody, forever, and no code in
   * this repository could do anything about it. It has been removed from
   * BRIEFING_BODY (scripts/whatsapp-templates.ts) and moved into the {{2}}
   * parameter, where a caller can decide.
   *
   * The caller's rule is in /api/cron/reminders and is deliberately strict:
   * this is true only for a crew member who has NEVER chosen a language and has
   * NEVER written to us. Both facts are already loaded, so it needs no new
   * column and no migration — and the moment they reply anything at all,
   * including the keyword itself, the line stops for good.
   *
   * ⚠ It goes out ONLY on the template path. The free-form briefing never
   * carries it, because being inside the free-form window is itself proof that
   * this person has written to us. That was already #46's rule and it is
   * unchanged.
   *
   * ⚠ The live Meta template still carries the old sentence until it is
   * re-approved by hand. Until then a first-contact worker reads it twice. That
   * is strictly better than every worker reading it every day, and it heals
   * itself the moment the template is updated — see the runbook.
   */
  languageHint?: boolean;
}

export function renderWorkerBriefing(
  briefing: WorkerBriefing,
  options: WorkerBriefingOptions = {},
): [name: string, taskList: string] {
  const t = getCatalog(briefing.locale).reminders;

  /**
   * Appended, never prepended: what the person needs is their work, and a
   * control-surface note that pushed the task list down the message would be
   * the same defect in a different place.
   *
   * The trailing full stop is normalised rather than assumed. `workerNothing`
   * ends in one and a task list does not, and the hint itself deliberately
   * carries none — because the approved template continues with a sentence of
   * its own right after {{2}}. Get this wrong in either direction and the
   * message reads "…de idioma.. Responde STOP…" or "…hoje Responde PT…", and
   * only on the live send, to a crew member, on their first ever contact.
   */
  const withHint = (base: string): string =>
    options.languageHint ? `${base.replace(/\.\s*$/, '')}. ${t.languageHint}` : base;

  if (briefing.tasks.length === 0) return [briefing.name, withHint(t.workerNothing)];

  const ordered = [...briefing.tasks].sort((a, b) => Number(b.overdue) - Number(a.overdue));
  const shown = ordered.slice(0, MAX_LISTED);

  const parts = shown.map(task => {
    const labelled = taskHeadline(task, t);
    return task.overdue && task.days_overdue > 0 ? t.taskOverdue(labelled, task.days_overdue) : labelled;
  });
  if (ordered.length > shown.length) parts.push(t.andMore(ordered.length - shown.length));

  return [briefing.name, withHint(parts.join(t.taskSeparator))];
}

// ── the free-form briefing (issue #46) ──────────────────────────────────────
//
// The SAME day, in the other envelope. When the recipient wrote to us in the
// last 23 hours, Meta lets us answer with ordinary text: free of charge, free of
// the approved template's wrapper, and free of its one-line constraint.
//
// So this renderer says the thing renderWorkerBriefing structurally cannot.
// "Canalização" on its own tells a plumber nothing they did not already know;
// what they need at 07:00 is what the job is and what to put in the van. Both
// have been sitting in task_board's `description` and `materials` all along, and
// neither could ever fit in a template parameter.
//
// Still DETERMINISTIC — no model call, for the reason at the top of this file.
// The upgrade here is that more of the row is shown, not that anything is
// generated.
//
// Everything is capped, because there is no second message: a briefing that
// spills past WhatsApp's 4096-char body would be split into two pushes at
// 07:00, which reads worse than a trimmed one. Truncation is preferred to
// splitting, per the same judgement MAX_LISTED already makes.

/** Materials shown per task before the rest becomes "+N". A van load, not an order form. */
const MAX_MATERIALS = 6;

/** Predecessors named before the rest becomes "+N". Beyond this it is a plan, not a warning. */
const MAX_WAITING_ON = 3;

/** Fellow crew named on the LEAD's line before the rest becomes "+N" (issue #44).
 *  The database caps a task at 20 collaborators; this caps what is worth reading
 *  on a phone. Past a handful the useful fact is the number. */
const MAX_HELPERS = 4;

/** The `reminders` slice, in the reader's own language. */
export type RemindersCopy = ReturnType<typeof getCatalog>['reminders'];

/**
 * ONE task's headline, WITHOUT its lateness — the obra, and whose job it is.
 *
 * ── FEDERICO: this is the sentence that answers issue #44. ──────────────────
 * Three surfaces render a task headline — the 07:00 template, the 07:00
 * free-form briefing, and the guided menu's task sheet — and before #44 each
 * built it inline. That was survivable while a task had exactly one reader.
 * With collaborators it is not: a surface that forgot the role clause would
 * tell a helper the job is theirs, which is precisely the confusion this
 * feature exists to remove. So it is one function, called by all of them.
 *
 * ORDER MATTERS AND IS DELIBERATE. The role clause is applied here, and
 * lateness by the caller AFTERWARDS, so a late task reads
 *
 *     Pintar tecto (Casa de Paco) — a ajudar Miguel — atrasada 3d
 *
 * with the thing that changes what you do first sitting last, where the eye
 * lands. Swapping them buries the deadline mid-sentence.
 *
 * A LEAD's headline is byte-identical to what it was before this feature —
 * that is asserted implicitly by every existing morning message and is the
 * reason nothing about today's crew changes on the day this ships.
 */
export function taskHeadline(task: BriefingTask, t: RemindersCopy): string {
  const named = task.job_name ? t.taskWithJob(task.title, task.job_name) : task.title;
  if (task.role !== 'collaborator') return named;
  // The lead's name, when there is one. `taskAsTeam` covers the task whose
  // assignee was cleared while helpers stayed on it — it names nobody, because
  // there is nobody to name, and claiming otherwise would be worse than vague.
  return task.lead_name ? t.taskAsCollaborator(named, task.lead_name) : t.taskAsTeam(named);
}

/**
 * Everything worth saying about ONE task, one fact per line, in the order
 * somebody about to start work needs them.
 *
 * ── FEDERICO: this is the dial for issue #49's first complaint. ──
 * "It names a task and nothing else." Every line below is a reason not to
 * phone the manager, and every one of them is already sitting in the database.
 * Adding another means adding a column to this function, a key to all three
 * dictionaries, and nothing else.
 *
 * ONE function, TWO surfaces, on purpose: the 07:00 briefing and the guided
 * menu's task sheet render from it identically. Two renderers would eventually
 * disagree about what a task is, and the crew member reading both would have no
 * way to tell which was right — the same reasoning that keeps the briefing and
 * the check-in on one renderer.
 *
 * Returns bare lines with NO indentation. The caller indents.
 */
export function taskDetailLines(task: BriefingTask, t: RemindersCopy): string[] {
  const lines: string[] = [];
  if (task.job_address) lines.push(t.freeFormAddress(clamp(task.job_address, 120)));
  if (task.description) lines.push(t.freeFormDescription(clamp(task.description, MAX_DESCRIPTION)));

  if (task.materials.length > 0) {
    const listed = task.materials.slice(0, MAX_MATERIALS);
    const names = listed.map(m => clamp(m, 60));
    if (task.materials.length > listed.length) names.push(t.andMore(task.materials.length - listed.length));
    lines.push(t.freeFormMaterials(names.join(t.freeFormMaterialSeparator)));
  }

  if (task.waiting_on.length > 0) {
    const listed = task.waiting_on.slice(0, MAX_WAITING_ON);
    const names = listed.map(w => clamp(w, 60));
    if (task.waiting_on.length > listed.length) names.push(t.andMore(task.waiting_on.length - listed.length));
    lines.push(t.freeFormWaitingOn(names.join(t.freeFormMaterialSeparator)));
  }

  // ── who else is coming (issue #44) ────────────────────────────────────────
  // The LEAD's line only. A collaborator has already been told whose job it is,
  // on the headline; listing their fellow helpers back at them would push the
  // one fact that matters — the address — further down a phone screen at 07:00.
  //
  // Capped the same way materials and dependencies are, and for the same
  // reason: a crew of twelve on one task is a message nobody finishes reading.
  const helpers = (task.role === 'lead' ? (task.collaborator_names ?? []) : []).filter(Boolean);
  if (helpers.length > 0) {
    const listed = helpers.slice(0, MAX_HELPERS);
    const names = listed.map(w => clamp(w, 40));
    if (helpers.length > listed.length) names.push(t.andMore(helpers.length - listed.length));
    lines.push(t.freeFormWith(names.join(t.freeFormMaterialSeparator)));
  }

  // Last, and never in the 07:00 briefing (BRIEFABLE excludes pending_review).
  // It is here for the guided menu, where a task the worker already declared
  // finished IS shown — and where seeing it without this line would read as
  // Capo having forgotten.
  if (task.awaiting_review) lines.push(t.freeFormAwaitingReview);

  return lines;
}

/** A task description is a note, not a spec. Longer than this and it stops being scannable. */
const MAX_DESCRIPTION = 200;

/**
 * The last-resort cap on the whole body. WhatsApp's own limit is 4096; this
 * sits well below it so that even a pathological row — five tasks with 300-char
 * titles — is trimmed here rather than split into two morning pushes by
 * splitForWhatsApp. Nothing in normal use comes close.
 */
const FREE_FORM_MAX_CHARS = 3000;

export function clamp(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * ── FEDERICO: this is the product-voice dial for the message people actually
 * read. ── Everything renderWorkerBriefing's note says about MAX_LISTED, obra
 * names and overdue-first still applies; this adds two lines per task.
 *
 * Shape, per task:
 *
 *   Bom dia, Miguel.
 *
 *   Hoje tens 2 tarefas:
 *
 *   1. Canalização (Casa de Paco)
 *      Morada: Rua das Flores 12, Lisboa
 *      Substituir os tubos da cozinha e ligar a máquina.
 *      Material: tubo PVC 50mm, cola, fita
 *      Depende de: Demolir parede
 *      Contigo: Zé
 *
 *   2. Pintar tecto (Casa de Paco) — a ajudar Miguel — atrasada 3d
 *
 * The second line is issue #44 in one sentence. That task appears in Miguel's
 * briefing too — same obra, same address, same materials, ONE task — and his
 * copy of it says "Contigo: João" instead. Neither of them reads a message
 * implying the other is not there, and neither of them loads the van twice.
 *
 * A task with no description, address, materials or dependencies is just its
 * numbered line, which is exactly what the template used to send — so this is
 * never worse than what it replaces, only better when the data is there.
 *
 * The ORDER of those lines is a judgement about a person standing next to a
 * van: where first (you cannot start anywhere else), then what, then what to
 * bring, then what might stop you.
 */
export function renderWorkerFreeForm(briefing: WorkerBriefing): string {
  const t = getCatalog(briefing.locale).reminders;
  const greeting = t.freeFormGreeting(briefing.name);

  if (briefing.tasks.length === 0) return `${greeting}\n\n${t.workerNothing}`;

  // Same ordering and same cap as the template path, deliberately: the two
  // envelopes must not disagree about which tasks are "today's", only about how
  // much room there is to describe them.
  const ordered = [...briefing.tasks].sort((a, b) => Number(b.overdue) - Number(a.overdue));
  const shown = ordered.slice(0, MAX_LISTED);

  const blocks = shown.map((task, index) => {
    const labelled = taskHeadline(task, t);
    const headline =
      task.overdue && task.days_overdue > 0 ? t.taskOverdue(labelled, task.days_overdue) : labelled;
    return [`${index + 1}. ${headline}`, ...taskDetailLines(task, t).map(line => `   ${line}`)].join('\n');
  });

  if (ordered.length > shown.length) blocks.push(t.andMore(ordered.length - shown.length));

  const body = [greeting, '', t.freeFormHeader(ordered.length), '', blocks.join('\n\n')].join('\n');
  // Clamped on the RAW body, not through clamp(), which flattens newlines —
  // the whole point of this renderer is that it may have them.
  return body.length <= FREE_FORM_MAX_CHARS
    ? body
    : `${body.slice(0, FREE_FORM_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * The manager's free-form briefing. Their counts, unchanged — this fixes the
 * COST defect for the manager (who is, per issue #46, the person who noticed
 * it), not the content one. What the manager needs is the board, and the board
 * is one screen away.
 */
export function renderManagerFreeForm(name: string, counts: ManagerCounts, locale: Locale): string {
  const t = getCatalog(locale).reminders;
  const summary = counts.today === 0 ? t.managerNothing : t.managerSummary(counts);
  return `${t.freeFormGreeting(name)}\n\n${summary}`;
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

// ── the chat-thread notes (issue #47) ───────────────────────────────────────
//
// Not template parameters, so these may be longer and may contain newlines —
// and unlike a WhatsApp push they are PERMANENT and MODEL-VISIBLE, which is the
// whole point: the thread is where the manager can later ask "what did you send
// the crew on Tuesday, and who got it?" and where Capo reads the answer.
//
// Everything these renderers put in a note is either our own copy, a count, a
// two-valued enum, or a name the MANAGER wrote on /perfil. Never a word a crew
// member typed. See apps/web/app/notifications/thread.ts for why that is a
// structural boundary rather than a matter of taste.

/**
 * How many people a thread note names before the rest becomes "+N".
 *
 * A crew of thirty would otherwise put thirty names in the manager's thread
 * every morning AND in the model's context on every later turn, where the
 * summarizer then merges it forward indefinitely. Eight is enough to answer
 * "did Zé get it?" for a real crew; past that the count is the useful part.
 */
const MAX_NAMED = 8;

/**
 * A capped, locale-joined list of crew names. Empty string for nobody.
 *
 * Exported since #45 so the welcome note joins names exactly as the three
 * older notes do — the cap and the separator are the same judgement about the
 * manager's thread and about the model's context, and two of them would drift.
 */
export function nameList(names: readonly string[], locale: Locale): string {
  const t = getCatalog(locale).reminders;
  if (names.length === 0) return '';
  const shown = names.slice(0, MAX_NAMED);
  // clamp() flattens whitespace as well as trimming: a name is manager-authored
  // free text, so a pasted newline would otherwise break the one-line shape.
  const parts = shown.map(name => clamp(name, 40));
  if (names.length > shown.length) parts.push(t.andMore(names.length - shown.length));
  return parts.join(t.nameSeparator);
}

/**
 * The MORNING note: what today holds, and who was actually sent their briefing.
 *
 * `notified` and `names` describe the same people — the crew members a send
 * genuinely went out to, not everyone who was considered. A worker skipped for
 * want of consent, an address or an active crew row appears in neither, which
 * is correct and is why the three exclusion counters are logged separately.
 */
export function renderManagerEvent(
  counts: ManagerCounts,
  notified: number,
  names: readonly string[],
  locale: Locale,
): string {
  return getCatalog(locale).reminders.managerEvent({ ...counts, notified, names: nameList(names, locale) });
}

/**
 * The LATE-AFTERNOON note: who was asked whether they had finished.
 *
 * Written by the check-in cron, which before issue #47 wrote nothing at all —
 * so the manager's phone showed a conversation Capo had never been told about.
 */
export function renderCheckinEvent(asked: number, names: readonly string[], locale: Locale): string {
  return getCatalog(locale).reminders.checkinEvent({ asked, names: nameList(names, locale) });
}

/**
 * ONE crew member's answer to that check-in.
 *
 * `answer` is the quick-reply button they tapped — one of exactly two payload
 * strings our own cron minted hours earlier — and `tasks` is the size of the
 * snapshot they were asked about. There is no third input, and deliberately so:
 * a tap carries no text, and the moment this function grew a `note` parameter
 * it would be writing crew prose into the manager's thread.
 */
export function renderCheckinAnswerEvent(
  args: { name: string; answer: CheckinAnswer; tasks: number },
  locale: Locale,
): string {
  return getCatalog(locale).reminders.checkinAnswer({
    name: clamp(args.name, 40),
    answer: args.answer,
    tasks: args.tasks,
  });
}
