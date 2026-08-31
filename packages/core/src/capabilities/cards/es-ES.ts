import type { CardStrings, EventStrings } from './types';

export const cards: CardStrings = {
  taskStatus: {
    pending: 'pendiente',
    in_progress: 'en curso',
    pending_review: 'pendiente de control',
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
    if (p.collaboratorNames?.length) bits.push(`con ${p.collaboratorNames.join(', ')} ayudando`);
    if (p.startDate) bits.push(`inicio ${p.startDate}`);
    if (p.dueDate) bits.push(`hasta ${p.dueDate}`);
    if (p.durationDays) bits.push(`duración ${p.durationDays} día${p.durationDays === 1 ? ' hábil' : 's hábiles'}`);
    if (p.materials?.length) bits.push(`materiales: ${p.materials.join(', ')}`);
    if (p.hasDescription) bits.push('con descripción');
    return `${bits.join(', ')}.`;
  },
  updateTask: p => `Modificar tarea «${p.title}»: ${p.changes.join('; ')}.`,
  taskChange: {
    title: v => `título → «${v}»`,
    status: v => `estado → ${v}`,
    assignee: v => `asignar a ${v}`,
    collaborators: names =>
      names.length === 0 ? 'dejar solo al responsable' : `ayudan: ${names.join(', ')}`,
    startDate: v => `inicio → ${v}`,
    dueDate: v => `plazo → ${v}`,
    duration: days => `duración → ${days} día${days === 1 ? ' hábil' : 's hábiles'}`,
    job: v => `obra → ${v}`,
    materials: list =>
      list.length === 0 ? 'quitar todos los materiales' : `materiales → ${list.join(', ')}`,
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
      // Not decoration: the 07:00 WhatsApp briefing to the crew reads task
      // titles and job names straight out of these rows. It is the one
      // consequence the manager cannot foresee from the dashboard he is
      // looking at.
      `Los mensajes del equipo en WhatsApp también pasarán a estar en ${p.toLanguage}.`,
      `Reversible durante ${p.undoDays} días.`,
    ].join(' ');
  },

  reschedule: {
    header: p => {
      const bits: string[] = [];
      const shift = p.triggerShiftDays == null ? 0 : Math.abs(p.triggerShiftDays);
      const habiles = `${shift} día${shift === 1 ? ' hábil' : 's hábiles'}`;
      if (p.triggerTitle) {
        if (p.reason === 'early_completion' && shift > 0) {
          bits.push(`«${p.triggerTitle}» terminó ${habiles} antes.`);
        } else if (p.reason === 'late_completion' && shift > 0) {
          bits.push(`«${p.triggerTitle}» terminó ${habiles} más tarde.`);
        } else {
          bits.push(`«${p.triggerTitle}» está terminada.`);
        }
        // Said out loud, never implied: the manager is being asked to move real
        // dates on the strength of somebody's word.
        if (p.unverified) bits.push('Se dio por terminada y todavía no se ha comprobado.');
      }
      bits.push(`Reprogramación propuesta de ${p.count} tarea${p.count === 1 ? '' : 's'} en la obra «${p.jobName}»:`);
      return bits.join(' ');
    },
    row: p => {
      const before = p.fromStart && p.fromDue ? `${p.fromStart}-${p.fromDue}` : (p.fromDue ?? p.fromStart ?? 'sin fechas');
      const n = Math.abs(p.shiftDays);
      const delta = n === 0 ? '' : ` (${p.shiftDays < 0 ? '-' : '+'}${n} día${n === 1 ? ' hábil' : 's hábiles'})`;
      return `• ${p.title}: ${before} → ${p.toStart}-${p.toDue}${delta}`;
    },
    more: n => `… y ${n} tarea${n === 1 ? '' : 's'} más.`,
    jobEnd: p => (p.from ? `Fin de la obra: ${p.from} → ${p.to}.` : `Fin de la obra: ${p.to}.`),
  },

  jobPause: {
    header: p => {
      const n = `${p.count} tarea${p.count === 1 ? '' : 's'}`;
      const verb = p.alreadyPaused ? 'Mantener la obra' : 'Poner la obra';
      return `${verb} «${p.jobName}» en pausa y quitar las fechas a ${n}:`;
    },
    row: p => {
      const before = p.fromStart && p.fromDue ? `${p.fromStart}-${p.fromDue}` : (p.fromDue ?? p.fromStart ?? 'sin fechas');
      return `• ${p.title}: ${before} → sin fechas`;
    },
    more: n => `… y ${n} tarea${n === 1 ? '' : 's'} más.`,
    footer:
      'Las tareas siguen en la obra y en el panel. Se quedan sin día previsto, dejan de contar como atrasadas y el equipo deja de recibirlas por la mañana. Cuando sepas las fechas nuevas, se las vuelves a poner.',
  },

  plan: {
    header: p => `Plan para la obra «${p.jobName}» — ${p.count} tarea${p.count === 1 ? '' : 's'}, del ${p.from} al ${p.to}`,
    row: p => {
      const head = `${p.index}. ${p.title} — ${p.from} → ${p.to} (${p.days} día${p.days === 1 ? '' : 's'})`;
      return p.workerName ? `${head} · ${p.workerName}` : head;
    },
    dependsOn: indices => `   ⤷ después de: ${indices.join(', ')}`,
    materials: list => `   materiales: ${list.join(', ')}`,
    warnings: {
      header: 'Antes de aprobar, confirma:',
      nameVariants: names =>
        `• ${names.map(n => `«${n}»`).join(', ')} — ¿es el mismo material escrito de formas distintas, o son materiales diferentes?`,
      tradeGap: p =>
        `• Hay más de una tarea de ${p.trade}, pero «${p.title}» no lleva ${p.missing.map(m => `«${m}»`).join(', ')} — ¿está bien?`,
    },
  },
};

export const events: EventStrings = {
  rejected: text => `El jefe rechazó la propuesta: "${text}"`,
  failed: (text, reason) => `La propuesta "${text}" fue aprobada pero falló: ${reason}`,
  approved: text => `El jefe aprobó la propuesta: "${text}". Acción ejecutada correctamente.`,
  unknownAction: action => `acción desconocida (${action})`,
  staleArgs: 'los datos de la propuesta ya no son válidos',
};
