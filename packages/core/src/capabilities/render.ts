import type { Db } from '@capo/db/client';
import type { Locale } from '@capo/i18n/locale';
import { countTranslatable } from '../translation';
import { shiftDaysBetween } from './reschedule';
import { cards, type CardStrings, type JobStatus, type TaskStatus } from './cards';

// Deterministic proposal card templates. The card text is ALWAYS a pure
// function of action_args + DB lookups — never model-authored — so the card
// cannot describe one thing while the payload does another. Lookups double as
// referential validation: a dangling job/worker id fails here, before the
// manager ever sees (or approves) the card.
//
// The wording lives in ./cards/<locale>.ts; this file is only assembly.
//
// Locale note: `locale` is the USER dial — the card is a sentence spoken to a
// human. The proper nouns INSIDE it (job names, task titles, worker names) come
// from the DB and are therefore in the COMPANY dial. When the two differ you get
// an English sentence wrapped around a Portuguese job name. That is correct and
// unavoidable: the alternative is machine-translating stored rows on render,
// which would make the card stop matching the dashboard.

export class RenderError extends Error {}

/** Must match translation_batches.expires_at in 0015 — the card promises this
 *  number to the manager, so the two cannot be allowed to drift silently. */
const UNDO_DAYS = 30;

async function jobName(db: Db, companyId: string, id: string, t: CardStrings): Promise<string> {
  const { data } = await db.from('jobs').select('name').eq('id', id).eq('company_id', companyId).maybeSingle();
  if (!data) throw new RenderError(t.errors.jobNotFound(id));
  return data.name;
}

async function workerName(db: Db, companyId: string, id: string, t: CardStrings): Promise<string> {
  const { data } = await db.from('workers').select('name').eq('id', id).eq('company_id', companyId).maybeSingle();
  if (!data) throw new RenderError(t.errors.workerNotFound(id));
  return data.name;
}

/**
 * Several worker ids to their names, in the order given (issue #44).
 *
 * `undefined` in, `undefined` out — "the payload did not mention collaborators"
 * has to stay distinguishable from "the payload says: nobody". An empty array
 * in gives an empty array out, which every locale renders as its own sentence.
 *
 * Sequential rather than Promise.all deliberately: each lookup is also a
 * REFERENTIAL CHECK that throws RenderError on a dangling or foreign id, and
 * the first bad id is the one worth reporting. A crew is a handful of rows.
 */
async function workerNames(
  db: Db,
  companyId: string,
  ids: string[] | undefined | null,
  t: CardStrings,
): Promise<string[] | undefined> {
  if (!ids) return undefined;
  const names: string[] = [];
  for (const id of ids) names.push(await workerName(db, companyId, id, t));
  return names;
}

async function taskRow(
  db: Db,
  companyId: string,
  id: string,
  t: CardStrings,
): Promise<{ title: string; status: string }> {
  const { data } = await db.from('tasks').select('title, status').eq('id', id).eq('company_id', companyId).maybeSingle();
  if (!data) throw new RenderError(t.errors.taskNotFound(id));
  return data;
}

async function taskTitle(db: Db, companyId: string, id: string, t: CardStrings): Promise<string> {
  return (await taskRow(db, companyId, id, t)).title;
}

export async function renderProposal(
  db: Db,
  companyId: string,
  actionName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any,
  locale: Locale,
): Promise<string> {
  const t = cards[locale];
  const fmt = t.formatDate;

  switch (actionName) {
    case 'create_task':
      return t.createTask({
        title: args.title,
        jobName: args.job_id ? await jobName(db, companyId, args.job_id, t) : undefined,
        workerName: args.assignee_worker_id
          ? await workerName(db, companyId, args.assignee_worker_id, t)
          : undefined,
        collaboratorNames: await workerNames(db, companyId, args.collaborator_worker_ids, t),
        startDate: args.start_date ? fmt(args.start_date) : undefined,
        dueDate: args.due_date ? fmt(args.due_date) : undefined,
      });

    case 'update_task': {
      const title = await taskTitle(db, companyId, args.task_id, t);
      const changes: string[] = [];
      if (args.title) changes.push(t.taskChange.title(args.title));
      // Fall back to the raw value if the DB ever carries a status the
      // dictionary has not caught up with.
      if (args.status) changes.push(t.taskChange.status(t.taskStatus[args.status as TaskStatus] ?? args.status));
      if (args.assignee_worker_id) {
        changes.push(t.taskChange.assignee(await workerName(db, companyId, args.assignee_worker_id, t)));
      }
      // `!= null`, not truthiness: an EMPTY array is the explicit "take
      // everybody off this task" and has to produce its own line. Treating it
      // as absent would let a card silently omit the only change it makes.
      if (args.collaborator_worker_ids != null) {
        changes.push(
          t.taskChange.collaborators(
            (await workerNames(db, companyId, args.collaborator_worker_ids, t)) ?? [],
          ),
        );
      }
      if (args.start_date) changes.push(t.taskChange.startDate(fmt(args.start_date)));
      if (args.due_date) changes.push(t.taskChange.dueDate(fmt(args.due_date)));
      if (args.job_id) changes.push(t.taskChange.job(await jobName(db, companyId, args.job_id, t)));
      if (args.description) changes.push(t.taskChange.description);
      if (changes.length === 0) throw new RenderError(t.errors.emptyChange);
      return t.updateTask({ title, changes });
    }

    case 'create_job':
      return t.createJob({
        name: args.name,
        address: args.address,
        clientName: args.client_name,
        startsOn: args.starts_on ? fmt(args.starts_on) : undefined,
      });

    case 'update_job': {
      const name = await jobName(db, companyId, args.job_id, t);
      const changes: string[] = [];
      if (args.name) changes.push(t.jobChange.name(args.name));
      if (args.address) changes.push(t.jobChange.address(args.address));
      if (args.client_name) changes.push(t.jobChange.client(args.client_name));
      if (args.status) changes.push(t.jobChange.status(t.jobStatus[args.status as JobStatus] ?? args.status));
      if (args.starts_on) changes.push(t.jobChange.startsOn(fmt(args.starts_on)));
      if (args.ends_on) changes.push(t.jobChange.endsOn(fmt(args.ends_on)));
      if (changes.length === 0) throw new RenderError(t.errors.emptyChange);
      return t.updateJob({ name, changes });
    }

    case 'add_worker':
      return t.addWorker({ name: args.name, trade: args.trade, phone: args.phone });

    case 'update_worker': {
      const name = await workerName(db, companyId, args.worker_id, t);
      const changes: string[] = [];
      if (args.name) changes.push(t.workerChange.name(args.name));
      if (args.trade) changes.push(t.workerChange.trade(args.trade));
      if (args.phone) changes.push(t.workerChange.phone(args.phone));
      if (args.language) changes.push(t.workerChange.language(args.language));
      if (changes.length === 0) throw new RenderError(t.errors.emptyChange);
      return t.updateWorker({ name, changes });
    }

    case 'apply_plan': {
      const jn = await jobName(db, companyId, args.job_id, t);
      const tasks: {
        key: string;
        title: string;
        start_date: string;
        due_date: string;
        duration_days: number;
        materials?: string[];
        assignee_worker_id?: string;
        depends_on?: string[];
      }[] = args.tasks;
      if (tasks.length === 0) throw new RenderError(t.errors.emptyPlan);

      const keyToIndex = new Map(tasks.map((task, i) => [task.key, i + 1]));
      const allDates = tasks.flatMap(task => [task.start_date, task.due_date]).sort();

      const lines = await Promise.all(
        tasks.map(async (task, i) => {
          const head = t.plan.row({
            index: i + 1,
            title: task.title,
            from: fmt(task.start_date),
            to: fmt(task.due_date),
            days: task.duration_days,
            workerName: task.assignee_worker_id
              ? await workerName(db, companyId, task.assignee_worker_id, t)
              : undefined,
          });
          const extra: string[] = [];
          if (task.depends_on?.length) {
            const nums = task.depends_on.map(k => keyToIndex.get(k)).filter((n): n is number => n != null);
            if (nums.length > 0) extra.push(t.plan.dependsOn(nums));
          }
          if (task.materials?.length) extra.push(t.plan.materials(task.materials));
          return [head, ...extra].join('\n');
        }),
      );

      const header = t.plan.header({
        jobName: jn,
        count: tasks.length,
        from: fmt(allDates[0]),
        to: fmt(allDates[allDates.length - 1]),
      });
      return `${header}\n${lines.join('\n')}`;
    }

    case 'apply_reschedule': {
      const jn = await jobName(db, companyId, args.job_id, t);
      const changes: {
        task_id: string;
        from_start_date: string | null;
        from_due_date: string | null;
        to_start_date: string;
        to_due_date: string;
      }[] = args.changes;
      if (changes.length === 0) throw new RenderError(t.errors.emptyChange);

      let triggerTitle: string | undefined;
      let unverified = false;
      if (args.trigger_task_id) {
        const trigger = await taskRow(db, companyId, args.trigger_task_id, t);
        triggerTitle = trigger.title;
        // A task sitting in pending_review has been DECLARED finished and not
        // yet checked. Read here rather than carried in action_args so the
        // card cannot claim a verification that never happened — and read on
        // the trigger's status rather than on task_reviews.declared_by_worker_id
        // because the property that matters to the manager is "nobody has
        // looked yet", which is equally true of a check he opened himself.
        unverified = trigger.status === 'pending_review';
      }

      // Truncation must be honest and the "+N" exact: rendered_text is the
      // persisted audit artifact, quoted byte-identically in the resolution
      // event when the manager approves or rejects.
      const MAX_ROWS = 12;
      const rows = await Promise.all(
        changes.slice(0, MAX_ROWS).map(async change =>
          t.reschedule.row({
            // One referential re-check per row, same as plan's worker lookups.
            title: await taskTitle(db, companyId, change.task_id, t),
            fromStart: change.from_start_date ? fmt(change.from_start_date) : undefined,
            fromDue: change.from_due_date ? fmt(change.from_due_date) : undefined,
            toStart: fmt(change.to_start_date),
            toDue: fmt(change.to_due_date),
            shiftDays: shiftDaysBetween(
              { start_date: change.from_start_date, due_date: change.from_due_date },
              { start_date: change.to_start_date, due_date: change.to_due_date },
            ),
          }),
        ),
      );
      if (changes.length > MAX_ROWS) rows.push(t.reschedule.more(changes.length - MAX_ROWS));

      // The job's end date, before and after — the one number that tells the
      // manager whether this cascade actually bought him anything. Recomputed
      // from the live rows plus this payload's overrides rather than carried in
      // action_args, so it can never disagree with what approving would do.
      const { data: jobTasks } = await db
        .from('tasks')
        .select('id, due_date, status')
        .eq('company_id', companyId)
        .eq('job_id', args.job_id)
        .limit(500);
      const overrides = new Map(changes.map(c => [c.task_id, c.to_due_date]));
      let endBefore: string | undefined;
      let endAfter: string | undefined;
      for (const row of jobTasks ?? []) {
        if (row.status === 'cancelled') continue;
        if (row.due_date && (!endBefore || row.due_date > endBefore)) endBefore = row.due_date;
        const after = overrides.get(row.id) ?? row.due_date;
        if (after && (!endAfter || after > endAfter)) endAfter = after;
      }
      if (endAfter) {
        rows.push(
          t.reschedule.jobEnd({
            from: endBefore && endBefore !== endAfter ? fmt(endBefore) : undefined,
            to: fmt(endAfter),
          }),
        );
      }

      const header = t.reschedule.header({
        reason: args.reason,
        jobName: jn,
        count: changes.length,
        unverified,
        triggerTitle,
        triggerShiftDays: args.trigger_shift_days,
      });
      return `${header}\n${rows.join('\n')}`;
    }

    case 'apply_company_translation': {
      const { data: company } = await db.from('companies').select('language').eq('id', companyId).maybeSingle();
      if (!company) throw new RenderError(t.errors.companyNotFound);
      if (args.from_language === args.to_language) throw new RenderError(t.errors.sameLanguage);
      // Referential re-check, the analogue of jobName() throwing on a dangling
      // id: the dial may have moved between propose and approve (another
      // manager, or a card left open overnight). Approving then would translate
      // FROM a language the rows are no longer in.
      if (company.language !== args.from_language) throw new RenderError(t.errors.languageMoved);

      // Counts are re-read here rather than carried in action_args, so the card
      // always describes the tenant as it is now and can never drift from what
      // the approval will actually rewrite.
      const n = await countTranslatable(db, companyId);
      if (n.total === 0) throw new RenderError(t.errors.nothingToTranslate);

      return t.translateCompany({
        fromLanguage: t.languageName[args.from_language as Locale],
        toLanguage: t.languageName[args.to_language as Locale],
        tasks: n.tasks,
        jobs: n.jobs,
        workers: n.workers,
        memories: n.memories,
        undoDays: UNDO_DAYS,
      });
    }

    default:
      throw new RenderError(t.errors.noTemplate(actionName));
  }
}
