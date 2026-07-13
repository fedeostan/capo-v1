import type { Db } from '@capo/db/client';

// Deterministic EU-PT proposal card templates. The card text is ALWAYS a pure
// function of action_args + DB lookups — never model-authored — so the card
// cannot describe one thing while the payload does another. Lookups double as
// referential validation: a dangling job/worker id fails here, before the
// manager ever sees (or approves) the card.
//
// ── FEDERICO: these templates are product voice. Rewrite the wording freely;
// keep them pure functions of the args. ──

export class RenderError extends Error {}

const STATUS_PT: Record<string, string> = {
  pending: 'pendente',
  in_progress: 'em curso',
  blocked: 'bloqueada',
  done: 'concluída',
  cancelled: 'cancelada',
};

const JOB_STATUS_PT: Record<string, string> = {
  active: 'ativa',
  paused: 'pausada',
  done: 'concluída',
};

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

async function jobName(db: Db, companyId: string, id: string): Promise<string> {
  const { data } = await db.from('jobs').select('name').eq('id', id).eq('company_id', companyId).maybeSingle();
  if (!data) throw new RenderError(`Obra não encontrada (${id})`);
  return data.name;
}

async function workerName(db: Db, companyId: string, id: string): Promise<string> {
  const { data } = await db.from('workers').select('name').eq('id', id).eq('company_id', companyId).maybeSingle();
  if (!data) throw new RenderError(`Trabalhador não encontrado (${id})`);
  return data.name;
}

async function taskTitle(db: Db, companyId: string, id: string): Promise<string> {
  const { data } = await db.from('tasks').select('title').eq('id', id).eq('company_id', companyId).maybeSingle();
  if (!data) throw new RenderError(`Tarefa não encontrada (${id})`);
  return data.title;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function renderProposal(db: Db, companyId: string, actionName: string, args: any): Promise<string> {
  switch (actionName) {
    case 'create_task': {
      const bits = [`Criar tarefa: «${args.title}»`];
      if (args.job_id) bits.push(`na obra ${await jobName(db, companyId, args.job_id)}`);
      if (args.assignee_worker_id) bits.push(`para ${await workerName(db, companyId, args.assignee_worker_id)}`);
      if (args.start_date) bits.push(`início ${fmtDate(args.start_date)}`);
      if (args.due_date) bits.push(`até ${fmtDate(args.due_date)}`);
      return `${bits.join(', ')}.`;
    }
    case 'update_task': {
      const title = await taskTitle(db, companyId, args.task_id);
      const changes: string[] = [];
      if (args.title) changes.push(`título → «${args.title}»`);
      if (args.status) changes.push(`estado → ${STATUS_PT[args.status] ?? args.status}`);
      if (args.assignee_worker_id) changes.push(`atribuir a ${await workerName(db, companyId, args.assignee_worker_id)}`);
      if (args.start_date) changes.push(`início → ${fmtDate(args.start_date)}`);
      if (args.due_date) changes.push(`prazo → ${fmtDate(args.due_date)}`);
      if (args.job_id) changes.push(`obra → ${await jobName(db, companyId, args.job_id)}`);
      if (args.description) changes.push('atualizar descrição');
      if (changes.length === 0) throw new RenderError('Alteração vazia');
      return `Alterar tarefa «${title}»: ${changes.join('; ')}.`;
    }
    case 'create_job': {
      const bits = [`Criar obra: «${args.name}»`];
      if (args.address) bits.push(`morada ${args.address}`);
      if (args.client_name) bits.push(`cliente ${args.client_name}`);
      if (args.starts_on) bits.push(`início ${fmtDate(args.starts_on)}`);
      return `${bits.join(', ')}.`;
    }
    case 'update_job': {
      const name = await jobName(db, companyId, args.job_id);
      const changes: string[] = [];
      if (args.name) changes.push(`nome → «${args.name}»`);
      if (args.address) changes.push(`morada → ${args.address}`);
      if (args.client_name) changes.push(`cliente → ${args.client_name}`);
      if (args.status) changes.push(`estado → ${JOB_STATUS_PT[args.status] ?? args.status}`);
      if (args.starts_on) changes.push(`início → ${fmtDate(args.starts_on)}`);
      if (args.ends_on) changes.push(`fim → ${fmtDate(args.ends_on)}`);
      if (changes.length === 0) throw new RenderError('Alteração vazia');
      return `Alterar obra «${name}»: ${changes.join('; ')}.`;
    }
    case 'add_worker': {
      const bits = [`Adicionar trabalhador: ${args.name}`];
      if (args.trade) bits.push(`(${args.trade})`);
      if (args.phone) bits.push(`tel. ${args.phone}`);
      return `${bits.join(' ')}.`;
    }
    case 'update_worker': {
      const name = await workerName(db, companyId, args.worker_id);
      const changes: string[] = [];
      if (args.name) changes.push(`nome → ${args.name}`);
      if (args.trade) changes.push(`ofício → ${args.trade}`);
      if (args.phone) changes.push(`telemóvel → ${args.phone}`);
      if (changes.length === 0) throw new RenderError('Alteração vazia');
      return `Alterar trabalhador ${name}: ${changes.join('; ')}.`;
    }
    case 'apply_plan': {
      const jn = await jobName(db, companyId, args.job_id);
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
      if (tasks.length === 0) throw new RenderError('Plano vazio');

      const keyToIndex = new Map(tasks.map((t, i) => [t.key, i + 1]));
      const allDates = tasks.flatMap(t => [t.start_date, t.due_date]).sort();
      const rangeStart = fmtDate(allDates[0]);
      const rangeEnd = fmtDate(allDates[allDates.length - 1]);

      const lines = await Promise.all(
        tasks.map(async (t, i) => {
          const head = [`${i + 1}. ${t.title} — ${fmtDate(t.start_date)} → ${fmtDate(t.due_date)} (${t.duration_days} dia${t.duration_days === 1 ? '' : 's'})`];
          if (t.assignee_worker_id) head.push(`· ${await workerName(db, companyId, t.assignee_worker_id)}`);
          const extra: string[] = [];
          if (t.depends_on?.length) {
            const nums = t.depends_on.map(k => keyToIndex.get(k)).filter((n): n is number => n != null);
            if (nums.length > 0) extra.push(`   ⤷ depois de: ${nums.join(', ')}`);
          }
          if (t.materials?.length) extra.push(`   materiais: ${t.materials.join(', ')}`);
          return [head.join(' '), ...extra].join('\n');
        }),
      );

      return `Plano para a obra «${jn}» — ${tasks.length} tarefa${tasks.length === 1 ? '' : 's'}, ${rangeStart} a ${rangeEnd}\n${lines.join('\n')}`;
    }
    default:
      throw new RenderError(`No template for action "${actionName}"`);
  }
}
