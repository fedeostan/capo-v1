import type { CardStrings, EventStrings } from './types';

export const cards: CardStrings = {
  taskStatus: {
    pending: 'pending',
    in_progress: 'in progress',
    pending_review: 'awaiting review',
    blocked: 'blocked',
    done: 'done',
    cancelled: 'cancelled',
  },
  jobStatus: { active: 'active', paused: 'paused', done: 'done' },

  languageName: { 'pt-PT': 'Portuguese', 'es-ES': 'Spanish', 'en-US': 'English' },

  // MM/DD/YYYY — the one locale where the date order differs.
  formatDate: iso => {
    const [y, m, d] = iso.split('-');
    return `${m}/${d}/${y}`;
  },

  errors: {
    jobNotFound: id => `Job not found (${id})`,
    workerNotFound: id => `Worker not found (${id})`,
    taskNotFound: id => `Task not found (${id})`,
    emptyChange: 'Empty change',
    emptyPlan: 'Empty plan',
    noTemplate: action => `No template for action "${action}"`,
    companyNotFound: 'Company not found',
    sameLanguage: 'The data is already in that language',
    languageMoved: 'The company data language has changed in the meantime',
    nothingToTranslate: 'There is nothing to translate',
  },

  createTask: p => {
    const bits = [`Create task: "${p.title}"`];
    if (p.jobName) bits.push(`on the ${p.jobName} job`);
    if (p.workerName) bits.push(`for ${p.workerName}`);
    if (p.collaboratorNames?.length) bits.push(`with ${p.collaboratorNames.join(', ')} helping`);
    if (p.startDate) bits.push(`starting ${p.startDate}`);
    if (p.dueDate) bits.push(`due ${p.dueDate}`);
    if (p.durationDays) bits.push(`duration ${p.durationDays} working day${p.durationDays === 1 ? '' : 's'}`);
    if (p.materials?.length) bits.push(`materials: ${p.materials.join(', ')}`);
    if (p.hasDescription) bits.push('with a description');
    return `${bits.join(', ')}.`;
  },
  updateTask: p => `Update task "${p.title}": ${p.changes.join('; ')}.`,
  taskChange: {
    title: v => `title → "${v}"`,
    status: v => `status → ${v}`,
    assignee: v => `assign to ${v}`,
    collaborators: names =>
      names.length === 0 ? 'leave only the assignee' : `helping: ${names.join(', ')}`,
    startDate: v => `start → ${v}`,
    dueDate: v => `due → ${v}`,
    duration: days => `duration → ${days} working day${days === 1 ? '' : 's'}`,
    job: v => `job → ${v}`,
    materials: list =>
      list.length === 0 ? 'remove all the materials' : `materials → ${list.join(', ')}`,
    description: 'update description',
  },

  createJob: p => {
    const bits = [`Create job: "${p.name}"`];
    if (p.address) bits.push(`address ${p.address}`);
    if (p.clientName) bits.push(`client ${p.clientName}`);
    if (p.startsOn) bits.push(`starting ${p.startsOn}`);
    return `${bits.join(', ')}.`;
  },
  updateJob: p => `Update job "${p.name}": ${p.changes.join('; ')}.`,
  jobChange: {
    name: v => `name → "${v}"`,
    address: v => `address → ${v}`,
    client: v => `client → ${v}`,
    status: v => `status → ${v}`,
    startsOn: v => `start → ${v}`,
    endsOn: v => `end → ${v}`,
  },

  addWorker: p => {
    const bits = [`Add worker: ${p.name}`];
    if (p.trade) bits.push(`(${p.trade})`);
    if (p.phone) bits.push(`ph. ${p.phone}`);
    const line = `${bits.join(' ')}.`;
    // ONE line, and only when Capo will actually have somebody to write to.
    if (!p.optIn || !p.phone) return line;
    return `${line} Tell them to reply to Capo's first message, even just "yes" — without that Capo can send them messages, but can't answer them or send them their day.`;
  },
  updateWorker: p => `Update worker ${p.name}: ${p.changes.join('; ')}.`,
  workerChange: {
    name: v => `name → ${v}`,
    trade: v => `trade → ${v}`,
    phone: v => `phone → ${v}`,
    language: v => `message language → ${v}`,
  },

  translateCompany: p => {
    const parts: string[] = [];
    if (p.tasks) parts.push(`${p.tasks} task${p.tasks === 1 ? '' : 's'}`);
    if (p.jobs) parts.push(`${p.jobs} job${p.jobs === 1 ? '' : 's'}`);
    if (p.workers) parts.push(`${p.workers} trade${p.workers === 1 ? '' : 's'}`);
    if (p.memories) parts.push(`${p.memories} note${p.memories === 1 ? '' : 's'}`);
    return [
      `Translate all company data from ${p.fromLanguage} to ${p.toLanguage}:`,
      `${parts.join(' · ')} will be rewritten.`,
      // Not decoration: the 07:00 WhatsApp briefing to the crew reads task
      // titles and job names straight out of these rows. It is the one
      // consequence the manager cannot foresee from the dashboard he is
      // looking at.
      `The crew's morning WhatsApp briefing will switch to ${p.toLanguage} too.`,
      `Reversible for ${p.undoDays} days.`,
    ].join(' ');
  },

  reschedule: {
    header: p => {
      const bits: string[] = [];
      const shift = p.triggerShiftDays == null ? 0 : Math.abs(p.triggerShiftDays);
      const days = `${shift} working day${shift === 1 ? '' : 's'}`;
      if (p.triggerTitle) {
        if (p.reason === 'early_completion' && shift > 0) {
          bits.push(`"${p.triggerTitle}" finished ${days} early.`);
        } else if (p.reason === 'late_completion' && shift > 0) {
          bits.push(`"${p.triggerTitle}" finished ${days} late.`);
        } else {
          bits.push(`"${p.triggerTitle}" is finished.`);
        }
        // Said out loud, never implied: the manager is being asked to move real
        // dates on the strength of somebody's word.
        if (p.unverified) bits.push('It was declared finished and has not been checked yet.');
      }
      bits.push(`Proposed reschedule of ${p.count} task${p.count === 1 ? '' : 's'} on the "${p.jobName}" job:`);
      return bits.join(' ');
    },
    row: p => {
      const before = p.fromStart && p.fromDue ? `${p.fromStart}-${p.fromDue}` : (p.fromDue ?? p.fromStart ?? 'no dates');
      const n = Math.abs(p.shiftDays);
      const delta = n === 0 ? '' : ` (${p.shiftDays < 0 ? '-' : '+'}${n} working day${n === 1 ? '' : 's'})`;
      return `• ${p.title}: ${before} → ${p.toStart}-${p.toDue}${delta}`;
    },
    more: n => `… and ${n} more task${n === 1 ? '' : 's'}.`,
    jobEnd: p => (p.from ? `Job end: ${p.from} → ${p.to}.` : `Job end: ${p.to}.`),
  },

  jobPause: {
    header: p => {
      const n = `${p.count} task${p.count === 1 ? '' : 's'}`;
      const verb = p.alreadyPaused ? 'Keep the' : 'Put the';
      return `${verb} "${p.jobName}" job on hold and take the dates off ${n}:`;
    },
    row: p => {
      const before = p.fromStart && p.fromDue ? `${p.fromStart}-${p.fromDue}` : (p.fromDue ?? p.fromStart ?? 'no dates');
      return `• ${p.title}: ${before} → no dates`;
    },
    more: n => `… and ${n} more task${n === 1 ? '' : 's'}.`,
    footer:
      'The tasks stay on the job and on the board. They lose their booked day, stop counting as overdue, and the crew stops getting them in the morning. Put the dates back when you know them.',
  },

  plan: {
    header: p => `Plan for the "${p.jobName}" job — ${p.count} task${p.count === 1 ? '' : 's'}, ${p.from} to ${p.to}`,
    row: p => {
      const head = `${p.index}. ${p.title} — ${p.from} → ${p.to} (${p.days} day${p.days === 1 ? '' : 's'})`;
      return p.workerName ? `${head} · ${p.workerName}` : head;
    },
    dependsOn: indices => `   ⤷ after: ${indices.join(', ')}`,
    materials: list => `   materials: ${list.join(', ')}`,
    warnings: {
      header: 'Before you approve, double-check:',
      nameVariants: names =>
        `• ${names.map(n => `"${n}"`).join(', ')} — the same material written different ways, or different materials?`,
      tradeGap: p =>
        `• More than one ${p.trade} task, but "${p.title}" doesn't list ${p.missing.map(m => `"${m}"`).join(', ')} — is that right?`,
    },
  },
};

export const events: EventStrings = {
  rejected: text => `The manager rejected the proposal: "${text}"`,
  failed: (text, reason) => `The proposal "${text}" was approved but failed: ${reason}`,
  approved: text => `The manager approved the proposal: "${text}". Action executed successfully.`,
  unknownAction: action => `unknown action (${action})`,
  staleArgs: 'the proposal data is no longer valid',
};
