// Read-only, cross-tenant queries for mission control. Everything here runs
// on getDb() — the service-role SYSTEM client — because the operator sees all
// companies by design. This app is the reason getDb() exists; nothing in
// apps/web may import this file. All reads, no writes: mutations happen only
// through each tenant's own chat.
import { getDb } from '@capo/db/client';
import type { Tables } from '@capo/db/types';

export type Company = Tables<'companies'>;
export type Task = Tables<'tasks'>;
export type Message = Tables<'messages'>;

export interface CompanyOverview {
  company: Company;
  managers: { full_name: string; phone: string }[];
  workerCount: number;
  taskCounts: Record<string, number>;
  lastMessageAt: string | null;
}

// Pilot-scale aggregation: a handful of companies, so plain selects + JS
// grouping beat premature SQL views. Revisit when company count grows.
export async function loadOverview(): Promise<CompanyOverview[]> {
  const db = getDb();
  const [companies, profiles, workers, tasks, conversations, lastMessages] = await Promise.all([
    db.from('companies').select('*').order('created_at').then(r => r.data ?? []),
    db.from('profiles').select('company_id, full_name, phone').then(r => r.data ?? []),
    db.from('workers').select('id, company_id').eq('active', true).then(r => r.data ?? []),
    db.from('tasks').select('id, company_id, status').then(r => r.data ?? []),
    db.from('conversations').select('id, company_id').then(r => r.data ?? []),
    db
      .from('messages')
      .select('conversation_id, created_at')
      .order('created_at', { ascending: false })
      .limit(500)
      .then(r => r.data ?? []),
  ]);

  const conversationCompany = new Map(conversations.map(c => [c.id, c.company_id]));
  const lastByCompany = new Map<string, string>();
  for (const m of lastMessages) {
    const companyId = conversationCompany.get(m.conversation_id);
    if (companyId && !lastByCompany.has(companyId)) lastByCompany.set(companyId, m.created_at);
  }

  return companies.map(company => ({
    company,
    managers: profiles
      .filter(p => p.company_id === company.id)
      .map(p => ({ full_name: p.full_name, phone: p.phone })),
    workerCount: workers.filter(w => w.company_id === company.id).length,
    taskCounts: tasks
      .filter(t => t.company_id === company.id)
      .reduce<Record<string, number>>((acc, t) => {
        acc[t.status] = (acc[t.status] ?? 0) + 1;
        return acc;
      }, {}),
    lastMessageAt: lastByCompany.get(company.id) ?? null,
  }));
}

export async function loadCompanies(): Promise<Company[]> {
  const db = getDb();
  const { data } = await db.from('companies').select('*').order('created_at');
  return data ?? [];
}

export async function loadCompanyThread(companyId: string): Promise<{
  company: Company | null;
  messages: Message[];
}> {
  const db = getDb();
  const { data: company } = await db.from('companies').select('*').eq('id', companyId).maybeSingle();
  if (!company) return { company: null, messages: [] };

  const { data: conversations } = await db.from('conversations').select('id').eq('company_id', companyId);
  const conversationIds = (conversations ?? []).map(c => c.id);
  if (conversationIds.length === 0) return { company, messages: [] };

  const { data: messages } = await db
    .from('messages')
    .select('*')
    .in('conversation_id', conversationIds)
    .order('created_at', { ascending: false })
    .limit(100);

  return { company, messages: (messages ?? []).reverse() };
}

export interface TaskRow extends Task {
  jobs: { name: string } | null;
  workers: { name: string } | null;
}

export async function loadTasksByCompany(): Promise<{ company: Company; tasks: TaskRow[] }[]> {
  const db = getDb();
  const [companies, tasks] = await Promise.all([
    db.from('companies').select('*').order('created_at').then(r => r.data ?? []),
    db
      .from('tasks')
      .select('*, jobs(name), workers:assignee_worker_id(name)')
      .order('created_at', { ascending: false })
      .limit(500)
      .then(r => (r.data ?? []) as unknown as TaskRow[]),
  ]);
  return companies.map(company => ({
    company,
    tasks: tasks.filter(t => t.company_id === company.id),
  }));
}

export interface DispatchRow extends Tables<'dispatch_log'> {
  workers: { name: string; company_id: string } | null;
}

export interface BriefingRow extends Tables<'notification_log'> {
  workers: { name: string } | null;
  companies: { name: string } | null;
}

export interface SignupRow {
  profileId: string;
  fullName: string;
  phone: string;
  createdAt: string;
  companyId: string;
  companyName: string;
  subscriptionStatus: string;
  trialEndsAt: string | null;
}

// Most recent signups (profiles, newest first) with their company's billing
// state — the "who's arriving" view, separate from the per-company Overview.
export async function loadSignups(): Promise<SignupRow[]> {
  const db = getDb();
  const { data: profiles } = await db
    .from('profiles')
    .select('id, full_name, phone, created_at, company_id')
    .order('created_at', { ascending: false })
    .limit(100);

  const companyIds = [...new Set((profiles ?? []).map(p => p.company_id))];
  const { data: companies } =
    companyIds.length > 0
      ? await db.from('companies').select('id, name, subscription_status, trial_ends_at').in('id', companyIds)
      : { data: [] };
  const companyById = new Map((companies ?? []).map(c => [c.id, c]));

  return (profiles ?? []).map(p => {
    const company = companyById.get(p.company_id);
    return {
      profileId: p.id,
      fullName: p.full_name,
      phone: p.phone,
      createdAt: p.created_at,
      companyId: p.company_id,
      companyName: company?.name ?? '—',
      subscriptionStatus: company?.subscription_status ?? '—',
      trialEndsAt: company?.trial_ends_at ?? null,
    };
  });
}

// ── Health & activation ─────────────────────────────────────────────────────
// Federico runs this company alone. The question he needs answered before
// anything else is not "what are the numbers" but "does anything need me
// today, and is anyone stuck?" Everything below serves those two questions.

export type AlertLevel = 'critical' | 'warning';

export interface Alert {
  level: AlertLevel;
  title: string;
  detail: string;
  href?: string;
}

/** Where a company has got to in the loop the product promises. */
export type ActivationStage = 'signed_up' | 'has_obra' | 'has_plan' | 'has_crew' | 'dispatching';

export const ACTIVATION_STAGES: { key: ActivationStage; label: string }[] = [
  { key: 'signed_up', label: 'Signed up' },
  { key: 'has_obra', label: 'Created an obra' },
  { key: 'has_plan', label: 'Tasks scheduled' },
  { key: 'has_crew', label: 'Crew reachable' },
  { key: 'dispatching', label: 'Briefings going out' },
];

export interface ActivationRow {
  companyId: string;
  companyName: string;
  createdAt: string;
  stage: ActivationStage;
  obras: number;
  tasks: number;
  aiTasks: number;
  reachableWorkers: number;
  lastDispatchAt: string | null;
  lastMessageAt: string | null;
  daysSinceSignup: number;
}

export interface HealthReport {
  alerts: Alert[];
  activation: ActivationRow[];
  today: {
    dispatchesToday: number;
    messagesToday: number;
    tasksCompletedToday: number;
    proposalsPending: number;
  };
  knowledge: { documents: number; chunks: number };
}

// KNOWN LIMIT (pilot-scale, same stance as loadOverview above): the unbounded
// selects below are silently capped by PostgREST's default 1000-row ceiling.
// With a handful of companies that is never reached. Once `tasks` alone passes
// ~1000 rows the activation tallies start undercounting — at that point move
// these aggregations into SQL views rather than raising the limit.
const DAY_MS = 24 * 60 * 60 * 1000;

function lisbonDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
}

function daysAgo(iso: string | null): number | null {
  return iso == null ? null : Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
}

export async function loadHealth(): Promise<HealthReport> {
  const db = getDb();
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });

  const [companies, jobs, tasks, workers, proposals, conversations, messages, dispatches, kbDocs, kbChunks] =
    await Promise.all([
      db.from('companies').select('id, name, created_at, subscription_status, trial_ends_at').then(r => r.data ?? []),
      db.from('jobs').select('id, company_id, status').then(r => r.data ?? []),
      db.from('tasks').select('id, company_id, status, source, assignee_worker_id, updated_at').then(r => r.data ?? []),
      db.from('workers').select('id, company_id, active, phone').then(r => r.data ?? []),
      db.from('proposals').select('id, company_id, status, action_name, created_at').then(r => r.data ?? []),
      db.from('conversations').select('id, company_id').then(r => r.data ?? []),
      db
        .from('messages')
        .select('conversation_id, created_at')
        .order('created_at', { ascending: false })
        .limit(1000)
        .then(r => r.data ?? []),
      // notification_log, NOT dispatch_log. The SMS dispatch is switched off,
      // so dispatch_log is now a frozen historical record — reading it here
      // would mean the "nothing went out today" alert fires as critical every
      // single morning, which is worse than no alert at all. The live daily
      // briefing writes notification_log (see apps/web/app/api/cron/reminders).
      db
        .from('notification_log')
        .select('company_id, created_at, notification_date, status')
        .eq('status', 'sent')
        .order('created_at', { ascending: false })
        .limit(500)
        .then(r => r.data ?? []),
      db.from('knowledge_documents').select('id', { count: 'exact', head: true }).then(r => r.count ?? 0),
      db.from('knowledge_chunks').select('id', { count: 'exact', head: true }).then(r => r.count ?? 0),
    ]);

  const companyOfConversation = new Map(conversations.map(c => [c.id, c.company_id]));
  const companyOfWorker = new Map(workers.map(w => [w.id, w.company_id]));

  const lastMessageByCompany = new Map<string, string>();
  for (const m of messages) {
    const companyId = companyOfConversation.get(m.conversation_id);
    if (companyId && !lastMessageByCompany.has(companyId)) lastMessageByCompany.set(companyId, m.created_at);
  }

  const lastDispatchByCompany = new Map<string, string>();
  for (const d of dispatches) {
    if (!lastDispatchByCompany.has(d.company_id)) lastDispatchByCompany.set(d.company_id, d.created_at);
  }

  const activation: ActivationRow[] = companies.map(company => {
    const companyJobs = jobs.filter(j => j.company_id === company.id);
    const companyTasks = tasks.filter(t => t.company_id === company.id);
    // 'capo' is the actor recorded when an approved proposal executes — i.e.
    // the manager actually accepted a generated plan rather than only chatting.
    const aiTasks = companyTasks.filter(t => t.source === 'capo').length;
    const reachableWorkers = workers.filter(w => w.company_id === company.id && w.active && w.phone).length;
    const lastDispatchAt = lastDispatchByCompany.get(company.id) ?? null;

    const stage: ActivationStage = lastDispatchAt
      ? 'dispatching'
      : reachableWorkers > 0 && companyTasks.length > 0
        ? 'has_crew'
        : companyTasks.length > 0
          ? 'has_plan'
          : companyJobs.length > 0
            ? 'has_obra'
            : 'signed_up';

    return {
      companyId: company.id,
      companyName: company.name,
      createdAt: company.created_at,
      stage,
      obras: companyJobs.filter(j => j.status === 'active').length,
      tasks: companyTasks.filter(t => !['done', 'cancelled'].includes(t.status)).length,
      aiTasks,
      reachableWorkers,
      lastDispatchAt,
      lastMessageAt: lastMessageByCompany.get(company.id) ?? null,
      daysSinceSignup: daysAgo(company.created_at) ?? 0,
    };
  });

  // ── Alerts ────────────────────────────────────────────────────────────────
  const alerts: Alert[] = [];

  for (const company of companies) {
    const trialDaysLeft = Math.ceil((new Date(company.trial_ends_at).getTime() - Date.now()) / DAY_MS);
    if (company.subscription_status === 'past_due' || company.subscription_status === 'canceled') {
      alerts.push({
        level: 'critical',
        title: `${company.name} — subscription ${company.subscription_status}`,
        detail: 'The manager is locked out of the chat and every write path. WhatsApp still works.',
        href: '/signups',
      });
    } else if (company.subscription_status === 'trialing' && trialDaysLeft <= 3) {
      alerts.push({
        level: trialDaysLeft < 0 ? 'critical' : 'warning',
        title: `${company.name} — trial ${trialDaysLeft < 0 ? 'expired' : `ends in ${trialDaysLeft}d`}`,
        detail: 'Worth a call before it lapses rather than after.',
        href: '/signups',
      });
    }
  }

  // A proposal that has sat pending for over a day means Capo asked for a
  // decision and the manager never came back — the clearest friction signal
  // the product emits, and invisible everywhere else.
  const stalePending = proposals.filter(p => p.status === 'pending' && (daysAgo(p.created_at) ?? 0) >= 1);
  if (stalePending.length > 0) {
    const names = new Map(companies.map(c => [c.id, c.name]));
    const byCompany = [...new Set(stalePending.map(p => names.get(p.company_id) ?? '—'))];
    alerts.push({
      level: 'warning',
      title: `${stalePending.length} proposal${stalePending.length === 1 ? '' : 's'} pending over 24h`,
      detail: `Capo asked and nobody decided — ${byCompany.join(', ')}. Either the card is unclear or the manager never saw it.`,
    });
  }

  const failedProposals = proposals.filter(p => p.status === 'failed');
  if (failedProposals.length > 0) {
    alerts.push({
      level: 'critical',
      title: `${failedProposals.length} proposal${failedProposals.length === 1 ? '' : 's'} approved but failed to execute`,
      detail: `The manager said yes and nothing happened: ${[...new Set(failedProposals.map(p => p.action_name))].join(', ')}.`,
    });
  }

  // Proposals stuck in 'executing' mean a crash mid-execution — by design they
  // are never retried, so they need a human to look.
  const stuckExecuting = proposals.filter(p => p.status === 'executing');
  if (stuckExecuting.length > 0) {
    alerts.push({
      level: 'critical',
      title: `${stuckExecuting.length} proposal${stuckExecuting.length === 1 ? '' : 's'} stuck mid-execution`,
      detail: 'A crash between claim and finalize. These are never retried automatically — inspect them.',
    });
  }

  for (const row of activation) {
    const quiet = daysAgo(row.lastMessageAt);
    if (row.daysSinceSignup >= 2 && row.stage === 'signed_up') {
      alerts.push({
        level: 'warning',
        title: `${row.companyName} — signed up ${row.daysSinceSignup}d ago, never created an obra`,
        detail: 'Stuck at the very first step. Onboarding, not product.',
      });
    } else if (row.tasks > 0 && row.reachableWorkers === 0) {
      alerts.push({
        level: 'warning',
        title: `${row.companyName} — ${row.tasks} open tasks, nobody reachable on WhatsApp`,
        detail: 'No active worker has a phone number, so the 07:00 briefing reaches nobody. The daily loop is dead here.',
      });
    } else if (quiet != null && quiet >= 7) {
      alerts.push({
        level: 'warning',
        title: `${row.companyName} — quiet for ${quiet} days`,
        detail: 'No message in either channel. Churn risk.',
        href: `/conversations/${row.companyId}`,
      });
    }
  }

  const dispatchingCompanies = activation.filter(r => r.stage === 'dispatching').length;
  const dispatchesToday = dispatches.filter(d => d.notification_date === todayKey).length;
  if (dispatchingCompanies > 0 && dispatchesToday === 0) {
    alerts.push({
      level: 'critical',
      title: 'No briefings sent today',
      detail:
        'At least one company has been briefed before but nothing went out today — check the Vercel cron on capo-v1 (/api/cron/reminders), CRON_SECRET, and that the capo_daily_briefing template is still approved in WhatsApp Manager.',
      href: '/dispatch',
    });
  }

  if (kbDocs === 0) {
    alerts.push({
      level: 'warning',
      title: 'Knowledge base is empty',
      detail: 'search_knowledge returns nothing, so Capo answers legal/technical questions without a source.',
    });
  }

  const order: Record<AlertLevel, number> = { critical: 0, warning: 1 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);

  return {
    alerts,
    activation: activation.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    today: {
      dispatchesToday,
      messagesToday: messages.filter(m => lisbonDateKey(m.created_at) === todayKey).length,
      tasksCompletedToday: tasks.filter(t => t.status === 'done' && lisbonDateKey(t.updated_at) === todayKey).length,
      proposalsPending: proposals.filter(p => p.status === 'pending').length,
    },
    knowledge: { documents: kbDocs, chunks: kbChunks },
  };
}

// The LIVE send log: the 07:00 WhatsApp briefing written by the Vercel cron.
// Failures are included on purpose — a run where every send returned 131030
// (number not allow-listed) is exactly the thing worth seeing, and filtering
// to status='sent' would render it as an empty, blameless table.
export async function loadBriefingLog(): Promise<BriefingRow[]> {
  const db = getDb();
  return await db
    .from('notification_log')
    .select('*, workers(name), companies(name)')
    .order('created_at', { ascending: false })
    .limit(100)
    .then(r => (r.data ?? []) as unknown as BriefingRow[]);
}

// The FROZEN SMS ledger, written by the external n8n/Twilio workflow before it
// was switched off. Nothing new lands here; it is kept so the pilot's history
// stays readable and so SMS can be turned back on without losing continuity.
export async function loadDispatchLog(): Promise<{ rows: DispatchRow[]; companyNames: Map<string, string> }> {
  const db = getDb();
  const [rows, companies] = await Promise.all([
    db
      .from('dispatch_log')
      .select('*, workers(name, company_id)')
      .order('sent_at', { ascending: false })
      .limit(100)
      .then(r => (r.data ?? []) as unknown as DispatchRow[]),
    db.from('companies').select('id, name').then(r => r.data ?? []),
  ]);
  return { rows, companyNames: new Map(companies.map(c => [c.id, c.name])) };
}
