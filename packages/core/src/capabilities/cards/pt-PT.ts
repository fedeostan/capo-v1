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
    pending_review: 'a aguardar controlo',
    blocked: 'bloqueada',
    done: 'concluída',
    cancelled: 'cancelada',
  },
  jobStatus: { active: 'ativa', paused: 'pausada', done: 'concluída' },

  languageName: { 'pt-PT': 'Português', 'es-ES': 'Espanhol', 'en-US': 'Inglês' },

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
    companyNotFound: 'Empresa não encontrada',
    sameLanguage: 'Os dados já estão nessa língua',
    languageMoved: 'A língua dos dados da empresa entretanto mudou',
    nothingToTranslate: 'Não há nada para traduzir',
  },

  createTask: p => {
    const bits = [`Criar tarefa: «${p.title}»`];
    if (p.jobName) bits.push(`na obra ${p.jobName}`);
    if (p.workerName) bits.push(`para ${p.workerName}`);
    if (p.collaboratorNames?.length) bits.push(`com ${p.collaboratorNames.join(', ')} a ajudar`);
    if (p.startDate) bits.push(`início ${p.startDate}`);
    if (p.dueDate) bits.push(`até ${p.dueDate}`);
    return `${bits.join(', ')}.`;
  },
  updateTask: p => `Alterar tarefa «${p.title}»: ${p.changes.join('; ')}.`,
  taskChange: {
    title: v => `título → «${v}»`,
    status: v => `estado → ${v}`,
    assignee: v => `atribuir a ${v}`,
    collaborators: names =>
      names.length === 0 ? 'deixar só o responsável' : `a ajudar: ${names.join(', ')}`,
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
    language: v => `idioma das mensagens → ${v}`,
  },

  translateCompany: p => {
    const parts: string[] = [];
    if (p.tasks) parts.push(`${p.tasks} tarefa${p.tasks === 1 ? '' : 's'}`);
    if (p.jobs) parts.push(`${p.jobs} obra${p.jobs === 1 ? '' : 's'}`);
    if (p.workers) parts.push(`${p.workers} ofício${p.workers === 1 ? '' : 's'}`);
    if (p.memories) parts.push(`${p.memories} nota${p.memories === 1 ? '' : 's'}`);
    return [
      `Traduzir todos os dados da empresa de ${p.fromLanguage} para ${p.toLanguage}:`,
      `${parts.join(' · ')} serão reescritos.`,
      // Not decoration: the 07:00 WhatsApp briefing to the crew reads task
      // titles and job names straight out of these rows. It is the one
      // consequence the manager cannot foresee from the dashboard he is
      // looking at.
      `As mensagens da equipa no WhatsApp também passam a ser em ${p.toLanguage}.`,
      `Reversível durante ${p.undoDays} dias.`,
    ].join(' ');
  },

  reschedule: {
    header: p => {
      const bits: string[] = [];
      const shift = p.triggerShiftDays == null ? 0 : Math.abs(p.triggerShiftDays);
      const uteis = `${shift} dia${shift === 1 ? ' útil' : 's úteis'}`;
      if (p.triggerTitle) {
        if (p.reason === 'early_completion' && shift > 0) {
          bits.push(`«${p.triggerTitle}» terminou ${uteis} mais cedo.`);
        } else if (p.reason === 'late_completion' && shift > 0) {
          bits.push(`«${p.triggerTitle}» terminou ${uteis} mais tarde.`);
        } else {
          bits.push(`«${p.triggerTitle}» está terminada.`);
        }
        // Said out loud, never implied: the manager is being asked to move real
        // dates on the strength of somebody's word.
        if (p.unverified) bits.push('Foi dada como concluída e ainda não foi controlada.');
      }
      bits.push(`Reagendamento proposto de ${p.count} tarefa${p.count === 1 ? '' : 's'} na obra «${p.jobName}»:`);
      return bits.join(' ');
    },
    row: p => {
      const before = p.fromStart && p.fromDue ? `${p.fromStart}-${p.fromDue}` : (p.fromDue ?? p.fromStart ?? 'sem datas');
      const n = Math.abs(p.shiftDays);
      const delta = n === 0 ? '' : ` (${p.shiftDays < 0 ? '-' : '+'}${n} dia${n === 1 ? ' útil' : 's úteis'})`;
      return `• ${p.title}: ${before} → ${p.toStart}-${p.toDue}${delta}`;
    },
    more: n => `… e mais ${n} tarefa${n === 1 ? '' : 's'}.`,
    jobEnd: p => (p.from ? `Fim da obra: ${p.from} → ${p.to}.` : `Fim da obra: ${p.to}.`),
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
