import type { CardStrings, EventStrings } from './types';

// ── FEDERICO: these templates are product voice. Reword freely; keep them pure
// functions of their arguments. ──
//
// Type annotation, not `satisfies`: this way pt-PT is checked against the
// interface exactly as strictly as the other two, and a typo'd key here fails
// the build rather than silently widening the shape everyone else must match.
export const cards: CardStrings = {
  taskStatus: {
    pending: 'pendente',
    in_progress: 'em curso',
    blocked: 'bloqueada',
    done: 'concluída',
    cancelled: 'cancelada',
  },
  jobStatus: { active: 'ativa', paused: 'pausada', done: 'concluída' },

  formatDate: iso => {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  },

  errors: {
    jobNotFound: id => `Obra não encontrada (${id})`,
    workerNotFound: id => `Trabalhador não encontrado (${id})`,
    taskNotFound: id => `Tarefa não encontrada (${id})`,
    emptyChange: 'Alteração vazia',
    emptyPlan: 'Plano vazio',
    noTemplate: action => `Sem modelo para a ação "${action}"`,
  },

  createTask: p => {
    const bits = [`Criar tarefa: «${p.title}»`];
    if (p.jobName) bits.push(`na obra ${p.jobName}`);
    if (p.workerName) bits.push(`para ${p.workerName}`);
    if (p.startDate) bits.push(`início ${p.startDate}`);
    if (p.dueDate) bits.push(`até ${p.dueDate}`);
    return `${bits.join(', ')}.`;
  },
  updateTask: p => `Alterar tarefa «${p.title}»: ${p.changes.join('; ')}.`,
  taskChange: {
    title: v => `título → «${v}»`,
    status: v => `estado → ${v}`,
    assignee: v => `atribuir a ${v}`,
    startDate: v => `início → ${v}`,
    dueDate: v => `prazo → ${v}`,
    job: v => `obra → ${v}`,
    description: 'atualizar descrição',
  },

  createJob: p => {
    const bits = [`Criar obra: «${p.name}»`];
    if (p.address) bits.push(`morada ${p.address}`);
    if (p.clientName) bits.push(`cliente ${p.clientName}`);
    if (p.startsOn) bits.push(`início ${p.startsOn}`);
    return `${bits.join(', ')}.`;
  },
  updateJob: p => `Alterar obra «${p.name}»: ${p.changes.join('; ')}.`,
  jobChange: {
    name: v => `nome → «${v}»`,
    address: v => `morada → ${v}`,
    client: v => `cliente → ${v}`,
    status: v => `estado → ${v}`,
    startsOn: v => `início → ${v}`,
    endsOn: v => `fim → ${v}`,
  },

  addWorker: p => {
    const bits = [`Adicionar trabalhador: ${p.name}`];
    if (p.trade) bits.push(`(${p.trade})`);
    if (p.phone) bits.push(`tel. ${p.phone}`);
    return `${bits.join(' ')}.`;
  },
  updateWorker: p => `Alterar trabalhador ${p.name}: ${p.changes.join('; ')}.`,
  workerChange: {
    name: v => `nome → ${v}`,
    trade: v => `ofício → ${v}`,
    phone: v => `telemóvel → ${v}`,
  },

  plan: {
    header: p =>
      `Plano para a obra «${p.jobName}» — ${p.count} tarefa${p.count === 1 ? '' : 's'}, ${p.from} a ${p.to}`,
    row: p => {
      const head = `${p.index}. ${p.title} — ${p.from} → ${p.to} (${p.days} dia${p.days === 1 ? '' : 's'})`;
      return p.workerName ? `${head} · ${p.workerName}` : head;
    },
    dependsOn: indices => `   ⤷ depois de: ${indices.join(', ')}`,
    materials: list => `   materiais: ${list.join(', ')}`,
  },
};

export const events: EventStrings = {
  rejected: text => `O gerente rejeitou a proposta: "${text}"`,
  failed: (text, reason) => `A proposta "${text}" foi aprovada mas falhou: ${reason}`,
  approved: text => `O gerente aprovou a proposta: "${text}". Ação executada com sucesso.`,
  unknownAction: action => `ação desconhecida (${action})`,
  staleArgs: 'os dados da proposta já não são válidos',
};
