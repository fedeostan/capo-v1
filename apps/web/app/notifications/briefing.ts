import type { Db } from '@capo/db/client';
import type { CheckinAnswer, WhatsAppRecipient } from '@capo/core/channels/whatsapp';
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
    if (!row.assignee_worker_id || !row.id || !row.title) continue;
    const list = byWorker.get(row.assignee_worker_id) ?? [];
    list.push({
      id: row.id,
      title: row.title,
      job_name: row.job_name,
      overdue: row.overdue === true,
      days_overdue: row.days_overdue ?? 0,
      description: row.description,
      // `materials` is a Postgres text[]; null and an empty array mean the same
      // thing to a reader, so they are collapsed here rather than at each use.
      materials: Array.isArray(row.materials) ? row.materials.filter(Boolean) : [],
    });
    byWorker.set(row.assignee_worker_id, list);
  }

  // A worker with NEITHER a phone nor a stored BSUID cannot be reached at all —
  // /perfil already warns the manager about a missing phone, so it is not a
  // silent drop.
  //
  // The BSUID half only ever fills in for someone Meta has stopped giving us a
  // number for. It cannot be populated out of thin air: a BSUID is revealed only
  // on an inbound message, so a worker reaches this branch only after having
  // written to us at least once (see captureBsuid in the webhook route).
  // `active !== true`, not `active === false`: the column is typed nullable, and
  // a null must fall on the skipped side exactly as `.eq('active', true)` used
  // to put it there. Everything downstream reads `active`, never `crew`.
  const allCrew = crew ?? [];
  const active = allCrew.filter(w => w.active === true);

  const reachable = active.flatMap(w => {
    const recipient = recipientFor(w);
    return recipient ? [{ worker: w, recipient }] : [];
  });

  // THE CONSENT GATE, and the only one. Both proactive sends — the 07:00
  // briefing and the late-afternoon check-in — reach their recipients through
  // this function, so a worker filtered out here cannot be messaged by either.
  // Putting it in the routes instead would mean two copies of a rule that must
  // never disagree. See hasWhatsAppConsent() and 0025_whatsapp_optin.sql.
  const consenting = reachable.filter(({ worker }) => hasWhatsAppConsent(worker));

  const workers: WorkerBriefing[] = consenting.map(({ worker, recipient }) => ({
    workerId: worker.id,
    name: worker.name,
    recipient,
    // NULL means "inherit the company"; the worker sets this themselves by
    // replying a keyword to their briefing.
    locale: worker.language ? coerceLocale(worker.language) : companyLocale,
    tasks: byWorker.get(worker.id) ?? [],
    lastInboundAt: readLastInboundAt(worker),
  }));

  return {
    companyId,
    companyLocale,
    workers,
    excludedNoConsent: reachable.length - consenting.length,
    // Against `active`, not `allCrew` — otherwise every inactive worker would
    // also be counted as unreachable and the two numbers would double-count the
    // same person.
    excludedUnreachable: active.length - reachable.length,
    excludedInactive: allCrew.length - active.length,
    counts: {
      today: todayRows.length,
      unassigned: todayRows.filter(r => !r.assignee_worker_id).length,
      overdue: open.filter(r => r.overdue === true).length,
    },
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
  const value = (row as Record<string, unknown>).last_inbound_at;
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

/** A task description is a note, not a spec. Longer than this and it stops being scannable. */
const MAX_DESCRIPTION = 200;

/**
 * The last-resort cap on the whole body. WhatsApp's own limit is 4096; this
 * sits well below it so that even a pathological row — five tasks with 300-char
 * titles — is trimmed here rather than split into two morning pushes by
 * splitForWhatsApp. Nothing in normal use comes close.
 */
const FREE_FORM_MAX_CHARS = 3000;

function clamp(value: string, max: number): string {
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
 *      Substituir os tubos da cozinha e ligar a máquina.
 *      Material: tubo PVC 50mm, cola, fita
 *
 *   2. Pintar tecto (Casa de Paco) — atrasada 3d
 *
 * A task with no description and no materials is just its numbered line, which
 * is exactly what the template used to send — so this is never worse than what
 * it replaces, only better when the data is there.
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
    const labelled = task.job_name ? t.taskWithJob(task.title, task.job_name) : task.title;
    const headline =
      task.overdue && task.days_overdue > 0 ? t.taskOverdue(labelled, task.days_overdue) : labelled;
    const lines = [`${index + 1}. ${headline}`];

    if (task.description) lines.push(`   ${t.freeFormDescription(clamp(task.description, MAX_DESCRIPTION))}`);

    if (task.materials.length > 0) {
      const listed = task.materials.slice(0, MAX_MATERIALS);
      const names = listed.map(m => clamp(m, 60));
      if (task.materials.length > listed.length) names.push(t.andMore(task.materials.length - listed.length));
      lines.push(`   ${t.freeFormMaterials(names.join(t.freeFormMaterialSeparator))}`);
    }

    return lines.join('\n');
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

/** A capped, locale-joined list of crew names. Empty string for nobody. */
function nameList(names: readonly string[], locale: Locale): string {
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
