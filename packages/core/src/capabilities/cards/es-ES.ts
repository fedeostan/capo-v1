import type { CardStrings, EventStrings } from './types';

export const cards: CardStrings = {
  taskStatus: {
    pending: 'pendiente',
    in_progress: 'en curso',
    blocked: 'bloqueada',
    done: 'terminada',
    cancelled: 'cancelada',
  },
  jobStatus: { active: 'activa', paused: 'en pausa', done: 'terminada' },

  languageName: { 'pt-PT': 'portugués', 'es-ES': 'español', 'en-US': 'inglés' },

  formatDate: iso => {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  },

  errors: {
    jobNotFound: id => `Obra no encontrada (${id})`,
    workerNotFound: id => `Trabajador no encontrado (${id})`,
    taskNotFound: id => `Tarea no encontrada (${id})`,
    emptyChange: 'Cambio vacío',
    emptyPlan: 'Plan vacío',
    noTemplate: action => `No hay plantilla para la acción "${action}"`,
    companyNotFound: 'Empresa no encontrada',
    sameLanguage: 'Los datos ya están en ese idioma',
    languageMoved: 'El idioma de los datos de la empresa ha cambiado mientras tanto',
    nothingToTranslate: 'No hay nada que traducir',
  },

  createTask: p => {
    const bits = [`Crear tarea: «${p.title}»`];
    if (p.jobName) bits.push(`en la obra ${p.jobName}`);
    if (p.workerName) bits.push(`para ${p.workerName}`);
    if (p.startDate) bits.push(`inicio ${p.startDate}`);
    if (p.dueDate) bits.push(`hasta ${p.dueDate}`);
    return `${bits.join(', ')}.`;
  },
  updateTask: p => `Modificar tarea «${p.title}»: ${p.changes.join('; ')}.`,
  taskChange: {
    title: v => `título → «${v}»`,
    status: v => `estado → ${v}`,
    assignee: v => `asignar a ${v}`,
    startDate: v => `inicio → ${v}`,
    dueDate: v => `plazo → ${v}`,
    job: v => `obra → ${v}`,
    description: 'actualizar descripción',
  },

  createJob: p => {
    const bits = [`Crear obra: «${p.name}»`];
    if (p.address) bits.push(`dirección ${p.address}`);
    if (p.clientName) bits.push(`cliente ${p.clientName}`);
    if (p.startsOn) bits.push(`inicio ${p.startsOn}`);
    return `${bits.join(', ')}.`;
  },
  updateJob: p => `Modificar obra «${p.name}»: ${p.changes.join('; ')}.`,
  jobChange: {
    name: v => `nombre → «${v}»`,
    address: v => `dirección → ${v}`,
    client: v => `cliente → ${v}`,
    status: v => `estado → ${v}`,
    startsOn: v => `inicio → ${v}`,
    endsOn: v => `fin → ${v}`,
  },

  addWorker: p => {
    const bits = [`Añadir trabajador: ${p.name}`];
    if (p.trade) bits.push(`(${p.trade})`);
    if (p.phone) bits.push(`tel. ${p.phone}`);
    return `${bits.join(' ')}.`;
  },
  updateWorker: p => `Modificar trabajador ${p.name}: ${p.changes.join('; ')}.`,
  workerChange: {
    name: v => `nombre → ${v}`,
    trade: v => `oficio → ${v}`,
    phone: v => `móvil → ${v}`,
    language: v => `idioma de los mensajes → ${v}`,
  },

  translateCompany: p => {
    const parts: string[] = [];
    if (p.tasks) parts.push(`${p.tasks} tarea${p.tasks === 1 ? '' : 's'}`);
    if (p.jobs) parts.push(`${p.jobs} obra${p.jobs === 1 ? '' : 's'}`);
    if (p.workers) parts.push(`${p.workers} oficio${p.workers === 1 ? '' : 's'}`);
    if (p.memories) parts.push(`${p.memories} nota${p.memories === 1 ? '' : 's'}`);
    return [
      `Traducir todos los datos de la empresa de ${p.fromLanguage} a ${p.toLanguage}:`,
      `se reescribirán ${parts.join(' · ')}.`,
      // Not decoration: the 07:00 SMS to the crew reads task titles and job
      // names straight out of these rows. It is the one consequence the manager
      // cannot foresee from the dashboard he is looking at.
      `Los SMS del equipo también pasarán a estar en ${p.toLanguage}.`,
      `Reversible durante ${p.undoDays} días.`,
    ].join(' ');
  },

  plan: {
    header: p => `Plan para la obra «${p.jobName}» — ${p.count} tarea${p.count === 1 ? '' : 's'}, del ${p.from} al ${p.to}`,
    row: p => {
      const head = `${p.index}. ${p.title} — ${p.from} → ${p.to} (${p.days} día${p.days === 1 ? '' : 's'})`;
      return p.workerName ? `${head} · ${p.workerName}` : head;
    },
    dependsOn: indices => `   ⤷ después de: ${indices.join(', ')}`,
    materials: list => `   materiales: ${list.join(', ')}`,
  },
};

export const events: EventStrings = {
  rejected: text => `El jefe rechazó la propuesta: "${text}"`,
  failed: (text, reason) => `La propuesta "${text}" fue aprobada pero falló: ${reason}`,
  approved: text => `El jefe aprobó la propuesta: "${text}". Acción ejecutada correctamente.`,
  unknownAction: action => `acción desconocida (${action})`,
  staleArgs: 'los datos de la propuesta ya no son válidos',
};
