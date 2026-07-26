import type { Db } from '@capo/db/client';
import type { Locale } from '@capo/i18n/locale';
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

async function taskTitle(db: Db, companyId: string, id: string, t: CardStrings): Promise<string> {
  const { data } = await db.from('tasks').select('title').eq('id', id).eq('company_id', companyId).maybeSingle();
  if (!data) throw new RenderError(t.errors.taskNotFound(id));
  return data.title;
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

    default:
      throw new RenderError(t.errors.noTemplate(actionName));
  }
}
