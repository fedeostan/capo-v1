import type { CardStrings, EventStrings } from './types';

export const cards: CardStrings = {
  taskStatus: {
    pending: 'pending',
    in_progress: 'in progress',
    blocked: 'blocked',
    done: 'done',
    cancelled: 'cancelled',
  },
  jobStatus: { active: 'active', paused: 'paused', done: 'done' },

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
  },

  createTask: p => {
    const bits = [`Create task: "${p.title}"`];
    if (p.jobName) bits.push(`on the ${p.jobName} job`);
    if (p.workerName) bits.push(`for ${p.workerName}`);
    if (p.startDate) bits.push(`starting ${p.startDate}`);
    if (p.dueDate) bits.push(`due ${p.dueDate}`);
    return `${bits.join(', ')}.`;
  },
  updateTask: p => `Update task "${p.title}": ${p.changes.join('; ')}.`,
  taskChange: {
    title: v => `title → "${v}"`,
    status: v => `status → ${v}`,
    assignee: v => `assign to ${v}`,
    startDate: v => `start → ${v}`,
    dueDate: v => `due → ${v}`,
    job: v => `job → ${v}`,
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
    return `${bits.join(' ')}.`;
  },
  updateWorker: p => `Update worker ${p.name}: ${p.changes.join('; ')}.`,
  workerChange: {
    name: v => `name → ${v}`,
    trade: v => `trade → ${v}`,
    phone: v => `phone → ${v}`,
  },

  plan: {
    header: p => `Plan for the "${p.jobName}" job — ${p.count} task${p.count === 1 ? '' : 's'}, ${p.from} to ${p.to}`,
    row: p => {
      const head = `${p.index}. ${p.title} — ${p.from} → ${p.to} (${p.days} day${p.days === 1 ? '' : 's'})`;
      return p.workerName ? `${head} · ${p.workerName}` : head;
    },
    dependsOn: indices => `   ⤷ after: ${indices.join(', ')}`,
    materials: list => `   materials: ${list.join(', ')}`,
  },
};

export const events: EventStrings = {
  rejected: text => `The manager rejected the proposal: "${text}"`,
  failed: (text, reason) => `The proposal "${text}" was approved but failed: ${reason}`,
  approved: text => `The manager approved the proposal: "${text}". Action executed successfully.`,
  unknownAction: action => `unknown action (${action})`,
  staleArgs: 'the proposal data is no longer valid',
};
