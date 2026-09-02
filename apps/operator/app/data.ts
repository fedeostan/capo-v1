// Cross-tenant queries for mission control. Everything here runs on getDb()
// — the service-role SYSTEM client — because the operator sees all companies
// by design. This app is the reason getDb() exists; nothing in apps/web may
// import this file. THIS FILE is reads only; the operator's one write path —
// #123's welcome resend — lives in the resend route's own actions.ts, behind
// a preview-and-confirm screen.
import { getDb } from '@capo/db/client';
import type { Tables } from '@capo/db/types';
import { hasWhatsAppConsent, type WhatsAppRecipient } from '@capo/core/channels/whatsapp';
// The ONE sanctioned reader of task_board's two appended collaborator arrays.
// Imported from @capo/core — a shared package, not apps/web — for the reason
// the function's own header gives: a second copy of those six lines is how one
// surface ends up saying a helper is free while another says they are on site.
import { everyoneOnTask, readCollaborators } from '@capo/core/capabilities/collaborators';
import { TASK_PHOTO_BUCKET } from '@capo/core/media/photos';
import { coerceLocale, type Locale } from '@capo/i18n/locale';
import {
  OPERATOR_RESEND_WELCOME_KIND,
  decideOperatorResend,
  planWelcomeResend,
  recipientFor,
  type ResendVerdict,
  type WelcomeSendPlan,
} from './welcome-resend';
import {
  WHATSAPP_TEMPLATE_USD,
  estimateCostUsd,
  estimateUncachedCostUsd,
  type PriceConfidence,
  type TokenCounts,
} from '@capo/core/agent/pricing';

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

/**
 * The task statuses the schema allows, in the order the board thinks about
 * them. Mirrors the CHECK constraint on `tasks.status` — 0001's five, widened
 * by 0018 with `pending_review`. Hard-coded rather than derived from the rows
 * on screen, so the filter offers a status that currently has NO tasks: "show
 * me the blocked ones" answering "none" is information, and a filter built
 * from the data can never say it.
 */
export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'pending_review',
  'blocked',
  'done',
  'cancelled',
] as const;

/**
 * How many tasks ONE company contributes to the list.
 *
 * PER COMPANY, and that is the whole fix (issue #155). This used to be a
 * single 500-row estate-wide read ordered newest-first, grouped in JavaScript
 * afterwards — so past 500 tasks in total the oldest-created companies fell off
 * the bottom of the read and rendered as "No tasks." An operator looking at a
 * quiet tenant was shown the same screen a genuinely empty tenant produces,
 * with nothing anywhere saying a cap had been hit. A per-company cap cannot do
 * that: one busy tenant can no longer consume another tenant's rows, and when
 * this cap DOES bite, `matching` is the true total and the screen says so.
 */
export const TASKS_PER_COMPANY = 200;

/**
 * Has anything ever moved this task since it was created?
 *
 * `tasks.updated_at` has no trigger behind it — every writer stamps it by
 * hand — and at insert time both columns take the same statement's `now()`, so
 * equality means untouched. The one-second slack is for a writer that stamps a
 * client-side ISO string a hair off the row's own default (`update_task` and
 * the completion sheet both do), not for clock skew between servers.
 *
 * ONE definition, read by both the list and the detail page. Two copies would
 * eventually disagree about whether the same task had ever been touched, and
 * the operator would have no way to tell which screen was right.
 */
const TASK_TOUCHED_EPSILON_MS = 1000;

export function taskWasTouched(task: { created_at: string; updated_at: string }): boolean {
  return new Date(task.updated_at).getTime() - new Date(task.created_at).getTime() > TASK_TOUCHED_EPSILON_MS;
}

export interface TaskListFilters {
  /** Only this company. Undefined means every company. */
  companyId?: string;
  /** Only this `tasks.status`. Undefined means every status. */
  status?: string;
}

export interface CompanyTasks {
  company: Company;
  /** Newest first, at most TASKS_PER_COMPANY of them. */
  tasks: TaskRow[];
  /**
   * Every task matching the filter for this company, IGNORING the cap — the
   * exact count PostgREST computed, not `tasks.length`. This is what makes a
   * truncated list say "showing 200 of 1,412" instead of quietly lying.
   */
  matching: number;
  truncated: boolean;
  /** The read failed outright. Rendered as an error, never as "no tasks". */
  error: string | null;
}

export interface TaskListing {
  groups: CompanyTasks[];
  /** Every company, filtered or not — the company filter control needs them
   *  all, or filtering to one company empties the control that undoes it. */
  companies: Company[];
  /** The companies read itself failed. Rendered as an error rather than as an
   *  empty estate — the same mistake in a different place. */
  companiesError: string | null;
  /** True when any group hit its cap — the page header says so once. */
  anyTruncated: boolean;
}

/**
 * The Tasks screen, one capped read per company.
 *
 * N+1 by construction, and deliberately: the same pilot-scale stance as
 * loadOverview above. A handful of companies means a handful of parallel
 * selects, and the alternative — one big read plus JavaScript grouping — is
 * precisely the bug this replaced. Revisit when the company count makes the
 * fan-out expensive, not before.
 */
export async function loadTaskListing(filters: TaskListFilters = {}): Promise<TaskListing> {
  const db = getDb();
  const { data: allCompanies, error: companiesError } = await db
    .from('companies')
    .select('*')
    .order('created_at');
  const companies = (allCompanies ?? []).filter(c => !filters.companyId || c.id === filters.companyId);

  const groups = await Promise.all(
    companies.map(async (company): Promise<CompanyTasks> => {
      let query = db
        .from('tasks')
        // count: 'exact' is what makes truncation VISIBLE. PostgREST computes
        // it over the filter and ignores the limit, so it stays the true total
        // however small the cap gets.
        .select('*, jobs(name), workers:assignee_worker_id(name)', { count: 'exact' })
        .eq('company_id', company.id)
        .order('created_at', { ascending: false })
        .limit(TASKS_PER_COMPANY);
      if (filters.status) query = query.eq('status', filters.status);

      const { data, count, error } = await query;
      const tasks = (data ?? []) as unknown as TaskRow[];
      const matching = count ?? tasks.length;
      return {
        company,
        tasks,
        matching,
        truncated: matching > tasks.length,
        error: error?.message ?? null,
      };
    }),
  );

  return {
    groups,
    companies: allCompanies ?? [],
    companiesError: companiesError?.message ?? null,
    anyTruncated: groups.some(g => g.truncated),
  };
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
    briefingsToday: number;
    checkinsToday: number;
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

// Federico's dial: a proposal pending this long means Capo asked for a
// decision and the manager never came back. Fed by loadHealth's cross-company
// alert AND the per-company view — one constant so the two cannot disagree.
export const STALE_PROPOSAL_DAYS = 1;

function lisbonDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
}

function daysAgo(iso: string | null): number | null {
  return iso == null ? null : Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
}

// One definition of "where has this company got to", shared by the health
// overview and the per-company view. The inputs are already company-filtered —
// this function only classifies, it never queries.
function deriveActivation(
  company: Pick<Company, 'id' | 'name' | 'created_at'>,
  companyJobs: { status: string }[],
  companyTasks: { status: string; source: string }[],
  companyWorkers: { active: boolean; phone: string | null }[],
  lastDispatchAt: string | null,
  lastMessageAt: string | null,
): ActivationRow {
  // 'capo' is the actor recorded when an approved proposal executes — i.e.
  // the manager actually accepted a generated plan rather than only chatting.
  const aiTasks = companyTasks.filter(t => t.source === 'capo').length;
  const reachableWorkers = companyWorkers.filter(w => w.active && w.phone).length;

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
    lastMessageAt,
    daysSinceSignup: daysAgo(company.created_at) ?? 0,
  };
}

// The billing dials (past_due/canceled, trial ending within 3 days), shared by
// loadHealth and the per-company view so the thresholds live once.
export function billingAlerts(
  company: Pick<Company, 'name' | 'subscription_status' | 'trial_ends_at'>,
): Alert[] {
  const alerts: Alert[] = [];
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
  return alerts;
}

// The activation dials (2-day no-obra, open tasks with nobody reachable,
// 7-day quiet), shared for the same reason. At most one alert per company —
// the chain is deliberate: each condition only matters if the earlier ones
// don't apply.
export function activationAlerts(row: ActivationRow): Alert[] {
  const quiet = daysAgo(row.lastMessageAt);
  if (row.daysSinceSignup >= 2 && row.stage === 'signed_up') {
    return [{
      level: 'warning',
      title: `${row.companyName} — signed up ${row.daysSinceSignup}d ago, never created an obra`,
      detail: 'Stuck at the very first step. Onboarding, not product.',
    }];
  }
  if (row.tasks > 0 && row.reachableWorkers === 0) {
    return [{
      level: 'warning',
      title: `${row.companyName} — ${row.tasks} open tasks, nobody reachable on WhatsApp`,
      detail: 'No active worker has a phone number, so the 07:00 briefing reaches nobody. The daily loop is dead here.',
    }];
  }
  if (quiet != null && quiet >= 7) {
    return [{
      level: 'warning',
      title: `${row.companyName} — quiet for ${quiet} days`,
      detail: 'No message in either channel. Churn risk.',
      href: `/companies/${row.companyId}`,
    }];
  }
  return [];
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
        // `kind` is not optional here: two daily sends write this table now, and
        // every counter below is about one of them specifically.
        .select('company_id, created_at, notification_date, status, kind')
        .eq('status', 'sent')
        .order('created_at', { ascending: false })
        .limit(500)
        .then(r => r.data ?? []),
      db.from('knowledge_documents').select('id', { count: 'exact', head: true }).then(r => r.count ?? 0),
      db.from('knowledge_chunks').select('id', { count: 'exact', head: true }).then(r => r.count ?? 0),
    ]);

  const companyOfConversation = new Map(conversations.map(c => [c.id, c.company_id]));

  const lastMessageByCompany = new Map<string, string>();
  for (const m of messages) {
    const companyId = companyOfConversation.get(m.conversation_id);
    if (companyId && !lastMessageByCompany.has(companyId)) lastMessageByCompany.set(companyId, m.created_at);
  }

  const lastDispatchByCompany = new Map<string, string>();
  for (const d of dispatches) {
    if (!lastDispatchByCompany.has(d.company_id)) lastDispatchByCompany.set(d.company_id, d.created_at);
  }

  const activation: ActivationRow[] = companies.map(company =>
    deriveActivation(
      company,
      jobs.filter(j => j.company_id === company.id),
      tasks.filter(t => t.company_id === company.id),
      workers.filter(w => w.company_id === company.id),
      lastDispatchByCompany.get(company.id) ?? null,
      lastMessageByCompany.get(company.id) ?? null,
    ),
  );

  // ── Alerts ────────────────────────────────────────────────────────────────
  const alerts: Alert[] = [];

  for (const company of companies) {
    alerts.push(...billingAlerts(company));
  }

  // A proposal that has sat pending for over a day means Capo asked for a
  // decision and the manager never came back — the clearest friction signal
  // the product emits, and invisible everywhere else.
  const stalePending = proposals.filter(
    p => p.status === 'pending' && (daysAgo(p.created_at) ?? 0) >= STALE_PROPOSAL_DAYS,
  );
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
    alerts.push(...activationAlerts(row));
  }

  const dispatchingCompanies = activation.filter(r => r.stage === 'dispatching').length;
  // Filtered by KIND, not just by date. notification_log now carries two daily
  // sends — the 07:00 'daily_briefing' and the late-afternoon 'task_checkin' — and this
  // alert is about the briefing only. Counting every kind would mean a working
  // check-in permanently holds this number above zero, so the briefing could
  // fail every single morning and this alert would never fire again.
  const briefingsToday = dispatches.filter(
    d => d.notification_date === todayKey && d.kind === 'daily_briefing',
  ).length;
  const checkinsToday = dispatches.filter(
    d => d.notification_date === todayKey && d.kind === 'task_checkin',
  ).length;
  if (dispatchingCompanies > 0 && briefingsToday === 0) {
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
      briefingsToday,
      checkinsToday,
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

// ── Cost (issue #53) ────────────────────────────────────────────────────────
//
// The one screen that answers "what is Capo costing me, and on whom". Two
// separate ledgers feed it and they are NOT the same kind of fact:
//
//   ai_usage (0032)         — one row per language-model API request, token
//                             counts only. Priced here, at read time.
//   notification_log (0016) — one row per paid WhatsApp template send. Read on
//                             the SERVICE ROLE, which bypasses RLS legitimately
//                             and adds no policy. Issue #51B owns the question
//                             of whether tenants ever get to read this table;
//                             nothing here touches that.
//
// A third cost exists and is deliberately absent: Vercel hosting. It is a flat
// platform bill for the whole product — one set of functions, one bandwidth
// pool, one cron scheduler serving every tenant at once — and there is no
// per-request meter that would let it be divided between companies honestly.
// Inventing an attribution (per company, per message, per seat) would produce a
// confident number with nothing behind it. The page says so in words instead.

/**
 * Read every page of a window rather than trusting PostgREST's 1000-row cap.
 *
 * Paged by CURSOR (`order by id` + `.gt('id', last)`), never by `.range()`.
 * `.range()` is `LIMIT/OFFSET`, and both ledgers are written by live traffic
 * while the report is being paged. Because `id` is a random `gen_random_uuid()`,
 * a row inserted between two fetches lands at an arbitrary point in the `order
 * by id` sequence and shifts every later offset — silently double-counting or
 * skipping rows at the page boundaries. A cursor has no such window: rows that
 * arrive mid-read either sort after the cursor and are picked up, or sort before
 * it and are simply outside this snapshot. Neither is a miscount.
 */
const COST_PAGE_SIZE = 1000;
/** Hard ceiling on pages, so a runaway table cannot hang the operator app. */
const COST_MAX_PAGES = 25;

export interface PersonSpend {
  /** profiles.id, workers.id, or the literal 'system'. */
  key: string;
  kind: 'manager' | 'worker' | 'system';
  name: string;
  requests: number;
  tokens: TokenCounts;
  aiUsd: number;
  unpricedRequests: number;
  /** Paid WhatsApp template sends addressed to this person. */
  whatsappSends: number;
  whatsappUsd: number;
}

export interface SurfaceSpend {
  surface: string;
  requests: number;
  tokens: TokenCounts;
  aiUsd: number;
  unpricedRequests: number;
}

export interface CompanyCost {
  companyId: string;
  companyName: string;
  requests: number;
  tokens: TokenCounts;
  aiUsd: number;
  /** What the same tokens would have cost with prompt caching off (#58). */
  aiUsdUncached: number;
  unpricedRequests: number;
  whatsappSends: number;
  whatsappUsd: number;
  people: PersonSpend[];
  surfaces: SurfaceSpend[];
}

export interface CostReport {
  windowDays: number;
  fromDate: string;
  toDate: string;
  companies: CompanyCost[];
  totalAiUsd: number;
  totalAiUsdUncached: number;
  totalWhatsappUsd: number;
  totalRequests: number;
  totalWhatsappSends: number;
  totalUnpricedRequests: number;
  /**
   * True when `ai_usage` does not exist yet — i.e. 0032 has not been applied.
   * Distinguished from "exists and is empty", because the two mean completely
   * different things: a missing migration versus a product nobody used.
   */
  ledgerMissing: boolean;
  /** A read that failed for a reason OTHER than the table not existing. */
  ledgerError: string | null;
  /** True when COST_MAX_PAGES was hit, so every figure below is a FLOOR. */
  truncated: boolean;
  /** Highest-confidence claim we can make about the prices used. */
  whatsappConfidence: PriceConfidence;
}

const ZERO_TOKENS = (): TokenCounts => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
});

function addTokens(into: TokenCounts, row: TokenCounts): void {
  into.input_tokens += row.input_tokens;
  into.output_tokens += row.output_tokens;
  into.cache_read_tokens += row.cache_read_tokens;
  into.cache_write_tokens += row.cache_write_tokens;
}

export function totalTokens(t: TokenCounts): number {
  return t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens;
}

/** Lisbon date, N days back, in the ISO form both ledgers store dates as. */
function lisbonDateNDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * DAY_MS);
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
}

type SendRow = Pick<Tables<'notification_log'>, 'id' | 'company_id' | 'worker_id' | 'profile_id'>;

type UsageRow = Pick<
  Tables<'ai_usage'>,
  | 'id'
  | 'company_id'
  | 'actor'
  | 'profile_id'
  | 'worker_id'
  | 'surface'
  | 'model_id'
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_read_tokens'
  | 'cache_write_tokens'
>;

export async function loadCostReport(windowDays = 30): Promise<CostReport> {
  const db = getDb();
  const toDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
  const fromDate = lisbonDateNDaysAgo(windowDays - 1);

  // ── ai_usage, paged ──────────────────────────────────────────────────────
  // One row per model REQUEST means this table grows far faster than anything
  // else the operator reads, so the unbounded-select convention used elsewhere
  // in this file would silently cap at 1000 rows and understate the bill. Page
  // until exhausted, and say so when the ceiling is reached.
  const usage: UsageRow[] = [];
  let ledgerMissing = false;
  let ledgerError: string | null = null;
  let truncated = false;

  let usageCursor: string | null = null;

  for (let page = 0; page < COST_MAX_PAGES; page++) {
    const query = db
      .from('ai_usage')
      .select(
        'id, company_id, actor, profile_id, worker_id, surface, model_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens',
      )
      .gte('usage_date', fromDate)
      .order('id')
      .limit(COST_PAGE_SIZE);
    const { data, error } = await (usageCursor ? query.gt('id', usageCursor) : query);

    if (error) {
      // Two different facts, kept apart on purpose. 42P01 ("relation does not
      // exist") means 0032 has not been applied — a deployment state with a
      // known fix. Anything else is a read that failed for some other reason,
      // and telling Federico "the migration is missing" when it is not would
      // send him looking in the wrong place. Neither throws: this is a
      // read-only report, and a page that 500s says less than one that says
      // why it is empty.
      if (error.code === '42P01') ledgerMissing = true;
      else ledgerError = error.message;
      break;
    }
    const rows = (data ?? []) as UsageRow[];
    usage.push(...rows);
    if (rows.length < COST_PAGE_SIZE) break;
    usageCursor = rows[rows.length - 1].id;
    if (page === COST_MAX_PAGES - 1) truncated = true;
  }

  // ── notification_log: the paid WhatsApp sends in the same window ─────────
  // status='sent' only. A 'failed' send is not billed, and 'pending'/'skipped'
  // never reached Meta at all — counting them would inflate the one figure on
  // this page that maps to a real invoice line.
  //
  // Paged for the same reason ai_usage is: two sends per worker per day means a
  // 30-day window over a real crew passes 1000 rows quickly, and a capped read
  // would understate the WhatsApp bill with nothing on screen to say so.
  const sends: SendRow[] = [];
  let sendCursor: string | null = null;

  for (let page = 0; page < COST_MAX_PAGES; page++) {
    const query = db
      .from('notification_log')
      .select('id, company_id, worker_id, profile_id')
      .eq('status', 'sent')
      .gte('notification_date', fromDate)
      .order('id')
      .limit(COST_PAGE_SIZE);
    const { data, error } = await (sendCursor ? query.gt('id', sendCursor) : query);

    if (error) break;
    // Annotated rather than inferred: `sendCursor` is read back out of `data`
    // on the next iteration, which makes the inference circular (TS7022).
    const rows = (data ?? []) as SendRow[];
    sends.push(...rows);
    if (rows.length < COST_PAGE_SIZE) break;
    sendCursor = rows[rows.length - 1].id;
    if (page === COST_MAX_PAGES - 1) truncated = true;
  }

  const [companies, profiles, workers] = await Promise.all([
    db.from('companies').select('id, name').order('created_at').then(r => r.data ?? []),
    db.from('profiles').select('id, full_name, company_id').then(r => r.data ?? []),
    db.from('workers').select('id, name, company_id').then(r => r.data ?? []),
  ]);

  const profileName = new Map(profiles.map(p => [p.id, p.full_name]));
  const workerName = new Map(workers.map(w => [w.id, w.name]));

  // A company appears if EITHER ledger has anything for it, so a tenant that
  // only receives briefings (no chat at all) is still visible with its WhatsApp
  // bill rather than vanishing.
  const active = new Set<string>([
    ...usage.map(u => u.company_id),
    ...sends.map(s => s.company_id),
  ]);

  const report: CompanyCost[] = [];

  for (const company of companies) {
    if (!active.has(company.id)) continue;

    const rows = usage.filter(u => u.company_id === company.id);
    const companySends = sends.filter(s => s.company_id === company.id);

    const people = new Map<string, PersonSpend>();
    const surfaces = new Map<string, SurfaceSpend>();
    const tokens = ZERO_TOKENS();
    let aiUsd = 0;
    let aiUsdUncached = 0;
    let unpricedRequests = 0;

    for (const row of rows) {
      const t: TokenCounts = {
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_read_tokens: row.cache_read_tokens,
        cache_write_tokens: row.cache_write_tokens,
      };
      const cost = estimateCostUsd(row.model_id, t);
      const uncached = estimateUncachedCostUsd(row.model_id, t);

      addTokens(tokens, t);
      aiUsd += cost.usd;
      aiUsdUncached += uncached.usd;
      if (!cost.priced) unpricedRequests++;

      // Per person. `system` collapses into one synthetic row rather than being
      // dropped: company-wide work (a bulk translation) is real money and has
      // to appear somewhere, just not under anybody's name.
      const kind = row.actor === 'manager' ? 'manager' : row.actor === 'worker' ? 'worker' : 'system';
      const key =
        kind === 'manager' ? (row.profile_id ?? 'system') : kind === 'worker' ? (row.worker_id ?? 'system') : 'system';
      const name =
        kind === 'manager'
          ? (profileName.get(key) ?? 'Unknown manager')
          : kind === 'worker'
            ? (workerName.get(key) ?? 'Unknown worker')
            : 'Company-wide';

      const person =
        people.get(key) ??
        {
          key,
          kind: key === 'system' ? ('system' as const) : kind,
          name: key === 'system' ? 'Company-wide' : name,
          requests: 0,
          tokens: ZERO_TOKENS(),
          aiUsd: 0,
          unpricedRequests: 0,
          whatsappSends: 0,
          whatsappUsd: 0,
        };
      person.requests++;
      addTokens(person.tokens, t);
      person.aiUsd += cost.usd;
      if (!cost.priced) person.unpricedRequests++;
      people.set(key, person);

      const surface =
        surfaces.get(row.surface) ??
        { surface: row.surface, requests: 0, tokens: ZERO_TOKENS(), aiUsd: 0, unpricedRequests: 0 };
      surface.requests++;
      addTokens(surface.tokens, t);
      surface.aiUsd += cost.usd;
      if (!cost.priced) surface.unpricedRequests++;
      surfaces.set(row.surface, surface);
    }

    // WhatsApp attaches to the RECIPIENT, and this is the one place per-worker
    // cost is genuinely knowable: notification_log records exactly who each
    // paid template went to. Token cost is not like this — a manager's chat
    // turn is a manager cost even when it is entirely about one crew member.
    for (const send of companySends) {
      const key = send.worker_id ?? send.profile_id ?? 'system';
      const isWorker = Boolean(send.worker_id);
      const person =
        people.get(key) ??
        {
          key,
          kind: key === 'system' ? ('system' as const) : isWorker ? ('worker' as const) : ('manager' as const),
          name:
            key === 'system'
              ? 'Company-wide'
              : isWorker
                ? (workerName.get(key) ?? 'Unknown worker')
                : (profileName.get(key) ?? 'Unknown manager'),
          requests: 0,
          tokens: ZERO_TOKENS(),
          aiUsd: 0,
          unpricedRequests: 0,
          whatsappSends: 0,
          whatsappUsd: 0,
        };
      person.whatsappSends++;
      person.whatsappUsd += WHATSAPP_TEMPLATE_USD;
      people.set(key, person);
    }

    report.push({
      companyId: company.id,
      companyName: company.name,
      requests: rows.length,
      tokens,
      aiUsd,
      aiUsdUncached,
      unpricedRequests,
      whatsappSends: companySends.length,
      whatsappUsd: companySends.length * WHATSAPP_TEMPLATE_USD,
      people: [...people.values()].sort((a, b) => b.aiUsd + b.whatsappUsd - (a.aiUsd + a.whatsappUsd)),
      surfaces: [...surfaces.values()].sort((a, b) => b.aiUsd - a.aiUsd),
    });
  }

  report.sort((a, b) => b.aiUsd + b.whatsappUsd - (a.aiUsd + a.whatsappUsd));

  return {
    windowDays,
    fromDate,
    toDate,
    companies: report,
    totalAiUsd: report.reduce((s, c) => s + c.aiUsd, 0),
    totalAiUsdUncached: report.reduce((s, c) => s + c.aiUsdUncached, 0),
    totalWhatsappUsd: report.reduce((s, c) => s + c.whatsappUsd, 0),
    totalRequests: report.reduce((s, c) => s + c.requests, 0),
    totalWhatsappSends: report.reduce((s, c) => s + c.whatsappSends, 0),
    totalUnpricedRequests: report.reduce((s, c) => s + c.unpricedRequests, 0),
    ledgerMissing,
    ledgerError,
    truncated,
    whatsappConfidence: 'estimated',
  };
}

// ── Per-company detail (issue #122) ─────────────────────────────────────────
//
// One company, everything the support question needs: what is broken, what
// shape the account is in, and what has actually been said and sent. Strictly
// read-only — every write action (resend, message a worker) is #123's.
//
// SCOPING RULE for everything below: this runs on the SERVICE ROLE, which sees
// every tenant, so RLS scopes nothing here. Every query MUST carry an explicit
// .eq('company_id', companyId) (or derive its ids from one that does). A
// missing filter is not an error — it is another tenant's data on the screen.

export type Job = Tables<'jobs'>;
export type Worker = Tables<'workers'>;
export type Profile = Tables<'profiles'>;
export type Proposal = Tables<'proposals'>;
export type CronRun = Tables<'cron_runs'>;
export type SendLogRow = Tables<'notification_log'>;
export type WorkerMessage = Tables<'worker_messages'>;

/** How many recent notification_log rows the detail view reads. */
const SEND_WINDOW_ROWS = 1000;

export interface CrewMemberView {
  worker: Worker;
  /** hasWhatsAppConsent() — the same latest-wins predicate the crons apply. */
  consent: boolean;
  /** Sends inside the loaded window, by status. */
  sends: { sent: number; failed: number; skipped: number; pending: number };
  lastSendAt: string | null;
  /** A worker_conversations row exists — they have talked to the worker agent. */
  hasThread: boolean;
}

export interface ManagerView {
  profile: Profile;
  consent: boolean;
}

export interface ProposalView {
  id: string;
  actionName: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  renderedText: string;
  ageDays: number;
}

export interface WorkerThreadView {
  workerId: string;
  workerName: string;
  updatedAt: string;
  /** Chronological, most recent tail of the thread. */
  messages: WorkerMessage[];
}

export interface OnboardingChecks {
  hasObra: boolean;
  /** An apply_plan proposal was approved, or tasks with source='capo' exist. */
  planApplied: boolean;
  hasTasks: boolean;
  activeCrew: number;
  reachableCrew: number;
  consentedCrew: number;
  briefingEverSent: boolean;
}

export interface TaskShape {
  total: number;
  byStatus: Record<string, number>;
  assigned: number;
  unassigned: number;
  dated: number;
  /** Neither start_date nor due_date — e.g. after an indefinite obra pause. */
  undated: number;
  doneLast7Days: number;
  /** From task_board — the one clock. Never re-derived here. */
  overdue: number;
  atRisk: number;
}

export interface CompanyDetail {
  company: Company;
  activation: ActivationRow;
  alerts: Alert[];
  onboarding: OnboardingChecks;
  /** notification_log rows that never went out (status='failed'). */
  failedSends: SendLogRow[];
  /** Claimed but deliberately not sent (status='skipped'), reason in error. */
  skippedSends: SendLogRow[];
  /** Claimed and never resolved — the cron died mid-run (status='pending'). */
  unresolvedSends: SendLogRow[];
  /** Sent, but Meta later reported a delivery failure (failed_at stamped). */
  deliveryFailures: SendLogRow[];
  /** Every send in the window, newest first — communication section groups it. */
  sends: SendLogRow[];
  /** True when the window cap was hit, so per-person tallies are floors. */
  sendsTruncated: boolean;
  proposals: {
    pending: ProposalView[];
    rejected: ProposalView[];
    failed: ProposalView[];
    executing: ProposalView[];
  };
  cronRuns: CronRun[];
  obras: Job[];
  taskShape: TaskShape;
  crew: CrewMemberView[];
  managers: ManagerView[];
  /** Chronological tail of the manager thread (web + WhatsApp). */
  managerMessages: Message[];
  workerThreads: WorkerThreadView[];
}

function toProposalView(p: Proposal): ProposalView {
  return {
    id: p.id,
    actionName: p.action_name,
    status: p.status,
    createdAt: p.created_at,
    resolvedAt: p.resolved_at,
    renderedText: p.rendered_text,
    ageDays: daysAgo(p.created_at) ?? 0,
  };
}

export async function loadCompanyDetail(companyId: string): Promise<CompanyDetail | null> {
  const db = getDb();

  const { data: company } = await db.from('companies').select('*').eq('id', companyId).maybeSingle();
  if (!company) return null;

  // select('*') throughout, deliberately: several of these relations have been
  // extended by appended columns before (task_board, notification_log), and a
  // deploy landing ahead of a migration must degrade, not 42703 (AGENTS.md).
  //
  // KNOWN LIMIT (pilot-scale, same stance as loadOverview): the capped windows
  // below mean "ever messaged" and the per-person tallies are really "within
  // the last N rows". At today's volumes N covers the account's whole life;
  // sendsTruncated says so on screen when that stops being true.
  const [jobs, tasks, board, workers, profiles, proposals, sends, cronRuns, workerConversations, workerMessages] =
    await Promise.all([
      db.from('jobs').select('*').eq('company_id', companyId).order('created_at').then(r => r.data ?? []),
      db.from('tasks').select('*').eq('company_id', companyId).then(r => r.data ?? []),
      db.from('task_board').select('*').eq('company_id', companyId).then(r => r.data ?? []),
      db.from('workers').select('*').eq('company_id', companyId).order('created_at').then(r => r.data ?? []),
      db.from('profiles').select('*').eq('company_id', companyId).order('created_at').then(r => r.data ?? []),
      db
        .from('proposals')
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(200)
        .then(r => r.data ?? []),
      db
        .from('notification_log')
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(SEND_WINDOW_ROWS)
        .then(r => r.data ?? []),
      db
        .from('cron_runs')
        .select('*')
        .eq('company_id', companyId)
        .order('ran_at', { ascending: false })
        .limit(30)
        .then(r => r.data ?? []),
      db.from('worker_conversations').select('*').eq('company_id', companyId).then(r => r.data ?? []),
      // worker_messages carries company_id directly (0027), so this is scoped
      // without going through the conversation ids.
      db
        .from('worker_messages')
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(400)
        .then(r => r.data ?? []),
    ]);

  // Manager thread: reuse the exact read the Conversations page makes rather
  // than a second opinion on what "the thread" is.
  const { messages: managerMessages } = await loadCompanyThread(companyId);

  // ── Health ────────────────────────────────────────────────────────────────
  const failedSends = sends.filter(s => s.status === 'failed');
  const skippedSends = sends.filter(s => s.status === 'skipped');
  const unresolvedSends = sends.filter(s => s.status === 'pending');
  const deliveryFailures = sends.filter(s => s.status === 'sent' && s.failed_at != null);

  const pendingProposals = proposals.filter(p => p.status === 'pending').map(toProposalView);
  const rejectedProposals = proposals.filter(p => p.status === 'rejected').map(toProposalView);
  const failedProposals = proposals.filter(p => p.status === 'failed').map(toProposalView);
  const executingProposals = proposals.filter(p => p.status === 'executing').map(toProposalView);

  const planApplied =
    proposals.some(p => p.action_name === 'apply_plan' && p.status === 'approved') ||
    tasks.some(t => t.source === 'capo');

  const activeWorkers = workers.filter(w => w.active);
  const onboarding: OnboardingChecks = {
    hasObra: jobs.length > 0,
    planApplied,
    hasTasks: tasks.length > 0,
    activeCrew: activeWorkers.length,
    reachableCrew: activeWorkers.filter(w => w.phone).length,
    consentedCrew: activeWorkers.filter(w => hasWhatsAppConsent(w)).length,
    briefingEverSent: sends.some(s => s.kind === 'daily_briefing' && s.status === 'sent'),
  };

  // ── Activation + alerts, through the SAME dials the health page uses ──────
  const lastDispatchAt = sends.find(s => s.status === 'sent')?.created_at ?? null;
  const lastMessageAt = managerMessages.at(-1)?.created_at ?? null;
  const activation = deriveActivation(company, jobs, tasks, workers, lastDispatchAt, lastMessageAt);

  const alerts: Alert[] = [...billingAlerts(company), ...activationAlerts(activation)];

  if (failedSends.length > 0) {
    alerts.push({
      level: 'critical',
      title: `${failedSends.length} WhatsApp send${failedSends.length === 1 ? '' : 's'} failed`,
      detail: `Most recent: ${failedSends[0].error ?? 'no error recorded'}. Nothing retries these — #123 adds the resend.`,
    });
  }
  if (unresolvedSends.length > 0) {
    alerts.push({
      level: 'critical',
      title: `${unresolvedSends.length} send claim${unresolvedSends.length === 1 ? '' : 's'} never resolved`,
      detail: 'A claim row stuck at pending means the cron died mid-run — the person got nothing and no failure was recorded.',
    });
  }
  const stalePending = pendingProposals.filter(p => p.ageDays >= STALE_PROPOSAL_DAYS);
  if (stalePending.length > 0) {
    alerts.push({
      level: 'warning',
      title: `${stalePending.length} approval card${stalePending.length === 1 ? '' : 's'} pending over 24h`,
      detail: 'Capo asked and nobody decided. Either the card is unclear or the manager never saw it.',
    });
  }
  if (failedProposals.length > 0) {
    alerts.push({
      level: 'critical',
      title: `${failedProposals.length} approval card${failedProposals.length === 1 ? '' : 's'} approved but failed to execute`,
      detail: `The manager said yes and nothing happened: ${[...new Set(failedProposals.map(p => p.actionName))].join(', ')}.`,
    });
  }
  if (executingProposals.length > 0) {
    alerts.push({
      level: 'critical',
      title: `${executingProposals.length} approval card${executingProposals.length === 1 ? '' : 's'} stuck mid-execution`,
      detail: 'A crash between claim and finalize. These are never retried automatically — inspect them.',
    });
  }
  if (!planApplied && rejectedProposals.some(p => p.actionName === 'apply_plan')) {
    alerts.push({
      level: 'warning',
      title: 'Generated plan rejected, and no plan ever applied',
      detail: 'The manager turned the plan card down and never got another — the board is likely empty. The difference between a working tenant and a hollow one.',
    });
  }

  const order: Record<AlertLevel, number> = { critical: 0, warning: 1 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);

  // ── Shape ─────────────────────────────────────────────────────────────────
  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const taskShape: TaskShape = {
    total: tasks.length,
    byStatus: tasks.reduce<Record<string, number>>((acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    }, {}),
    assigned: tasks.filter(t => t.assignee_worker_id != null).length,
    unassigned: tasks.filter(t => t.assignee_worker_id == null).length,
    dated: tasks.filter(t => t.start_date != null || t.due_date != null).length,
    undated: tasks.filter(t => t.start_date == null && t.due_date == null).length,
    doneLast7Days: tasks.filter(t => t.status === 'done' && t.updated_at >= sevenDaysAgo).length,
    // From the view, never re-derived: "overdue" and "at risk" are the board's
    // own definitions (one clock, AGENTS.md).
    overdue: board.filter(t => t.overdue === true).length,
    atRisk: board.filter(t => t.at_risk === true).length,
  };

  const threadWorkerIds = new Set(workerConversations.map(c => c.worker_id));
  const crew: CrewMemberView[] = workers.map(worker => {
    const workerSends = sends.filter(s => s.worker_id === worker.id);
    return {
      worker,
      consent: hasWhatsAppConsent(worker),
      sends: {
        sent: workerSends.filter(s => s.status === 'sent').length,
        failed: workerSends.filter(s => s.status === 'failed').length,
        skipped: workerSends.filter(s => s.status === 'skipped').length,
        pending: workerSends.filter(s => s.status === 'pending').length,
      },
      lastSendAt: workerSends[0]?.created_at ?? null,
      hasThread: threadWorkerIds.has(worker.id),
    };
  });

  const managers: ManagerView[] = profiles.map(profile => ({
    profile,
    consent: hasWhatsAppConsent(profile),
  }));

  // ── Communication ─────────────────────────────────────────────────────────
  const workerName = new Map(workers.map(w => [w.id, w.name]));
  const workerThreads: WorkerThreadView[] = workerConversations
    .map(conversation => ({
      workerId: conversation.worker_id,
      workerName: workerName.get(conversation.worker_id) ?? 'Unknown worker',
      updatedAt: conversation.updated_at,
      messages: workerMessages
        .filter(m => m.conversation_id === conversation.id)
        .slice(0, 30)
        .reverse(),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return {
    company,
    activation,
    alerts,
    onboarding,
    failedSends,
    skippedSends,
    unresolvedSends,
    deliveryFailures,
    sends,
    sendsTruncated: sends.length === SEND_WINDOW_ROWS,
    proposals: {
      pending: pendingProposals,
      rejected: rejectedProposals,
      failed: failedProposals,
      executing: executingProposals,
    },
    cronRuns,
    obras: jobs,
    taskShape,
    crew,
    managers,
    managerMessages,
    workerThreads,
  };
}

// ── Welcome resend (issue #123, part A) ─────────────────────────────────────
//
// Everything the resend preview and its server action need about ONE person,
// read fresh on every call. The action calls this again at send time rather
// than trusting anything the page rendered — a consent withdrawn or a number
// corrected between render and click must win.
//
// Same scoping rule as loadCompanyDetail: service role sees every tenant, so
// every query carries an explicit company filter. The person is looked up by
// id AND company_id, so a personId belonging to another tenant answers null
// rather than leaking a row.

export type ResendAudience = 'worker' | 'manager';

export interface WelcomeResendContext {
  company: Company;
  audience: ResendAudience;
  personId: string;
  personName: string;
  /** hasWhatsAppConsent() on the row as it is NOW — the gate, fail closed. */
  consent: boolean;
  /** Where a send would go, or null when the person has no usable address. */
  recipient: WhatsAppRecipient | null;
  locale: Locale;
  /** Every 'welcome' and operator-resend ledger row for this person, newest first. */
  ledger: SendLogRow[];
  verdict: ResendVerdict;
  /** What would be sent — template, language, exact params, full preview text. */
  plan: WelcomeSendPlan;
  /** Today's Lisbon date, for the claim row. */
  today: string;
}

export async function loadWelcomeResendContext(
  companyId: string,
  audience: ResendAudience,
  personId: string,
): Promise<WelcomeResendContext | null> {
  const db = getDb();

  const { data: company } = await db.from('companies').select('*').eq('id', companyId).maybeSingle();
  if (!company) return null;

  const person =
    audience === 'worker'
      ? await db.from('workers').select('*').eq('company_id', companyId).eq('id', personId).maybeSingle()
      : await db.from('profiles').select('*').eq('company_id', companyId).eq('id', personId).maybeSingle();
  if (!person.data) return null;

  const ledgerQuery = db
    .from('notification_log')
    .select('*')
    .eq('company_id', companyId)
    .in('kind', ['welcome', OPERATOR_RESEND_WELCOME_KIND])
    .order('created_at', { ascending: false });
  const { data: ledger, error: ledgerError } = await (audience === 'worker'
    ? ledgerQuery.eq('worker_id', personId)
    : ledgerQuery.eq('profile_id', personId));
  // Throws rather than treating a failed read as an empty ledger: an empty
  // ledger means "never attempted", and a send decision made on that guess
  // could introduce Capo twice. Same posture as loadPendingWelcomes.
  if (ledgerError) throw new Error(`notification_log read failed: ${ledgerError.message}`);

  // One clock (AGENTS.md): the claim's notification_date comes from
  // lisbon_today(), never from the runtime's own timezone arithmetic.
  const { data: today, error: todayError } = await db.rpc('lisbon_today');
  if (todayError || !today) throw new Error(`lisbon_today failed: ${todayError?.message}`);

  const row = person.data as Worker | Profile;
  const personName = audience === 'worker' ? (row as Worker).name : (row as Profile).full_name;
  const locale =
    audience === 'worker'
      ? coerceLocale((row as Worker).language ?? company.language)
      : coerceLocale((row as Profile).language);

  return {
    company,
    audience,
    personId,
    personName,
    consent: hasWhatsAppConsent(row),
    recipient: recipientFor(row),
    locale,
    ledger: ledger ?? [],
    verdict: decideOperatorResend(ledger ?? []),
    plan: planWelcomeResend({ audience, personName, companyName: company.name, locale }),
    today,
  };
}

// ── problem reports (0042, issue #120) ──────────────────────────────────────
// The ONLY read surface for `problem_reports`, by design: tenants hold no
// SELECT on it at all (a crew report may be about the manager), so the reports
// exist to be read here, cross-tenant, on the service role.
//
// `text` is untrusted free prose typed by a manager or a crew member. Render
// it as data — React escapes it — and never feed it onward to anything that
// treats text as instructions.

export interface ProblemReportRow {
  id: string;
  created_at: string;
  channel: string;
  text: string;
  context: unknown;
  companyName: string;
  /** The reporter, resolved: a manager's full_name or a worker's name. */
  reporter: string;
  audience: 'manager' | 'worker';
}

export async function loadProblemReports(): Promise<{ rows: ProblemReportRow[]; error: string | null }> {
  const db = getDb();
  const { data, error } = await db
    .from('problem_reports')
    .select('id, created_at, channel, text, context, worker_id, companies(name), workers(name), profiles(full_name)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) {
    // Most likely 42P01 while 0042 is unapplied. Shown on the page rather than
    // swallowed: an operator reading "no reports" off a missing table is the
    // 0038 failure shape all over again.
    return { rows: [], error: error.message };
  }
  return {
    rows: (data ?? []).map(row => ({
      id: row.id,
      created_at: row.created_at,
      channel: row.channel,
      text: row.text,
      context: row.context,
      companyName: row.companies?.name ?? '—',
      reporter: row.worker_id ? (row.workers?.name ?? 'Worker') : (row.profiles?.full_name ?? 'Manager'),
      audience: row.worker_id ? 'worker' : 'manager',
    })),
    error: null,
  };
}

// ── One task, end to end (issue #155) ───────────────────────────────────────
//
// "What has happened to this piece of work" is currently a question you can
// only answer in a SQL client, because the answer is spread over seven
// relations: the task, its obra, the crew on it, both directions of
// task_dependencies, every completion claim, every photo, and every WhatsApp
// send that carried it. This assembles all of them for ONE task.
//
// Same scoping rule as loadCompanyDetail: the service role sees every tenant,
// so every follow-up query carries an explicit company filter derived from the
// task row itself. A dependency edge or a photo that somehow named another
// company is dropped rather than rendered.
//
// Read-only, like the rest of this file. Nothing here writes.

export type TaskBoardRow = Tables<'task_board'>;
export type TaskReviewRow = Tables<'task_reviews'>;

/** One end of a `task_dependencies` edge, resolved to something readable. */
export interface TaskDependencyLink {
  id: string;
  title: string;
  status: string;
  dueDate: string | null;
  jobId: string | null;
  jobName: string | null;
  /**
   * The edge crosses obras. Legal — 0007 only requires both ends be in the
   * same COMPANY, never the same job — and worth saying out loud, because a
   * dependency that reaches outside the obra is the kind of thing an operator
   * is on this screen to find.
   */
  crossJob: boolean;
}

/** One completion claim, with both parties resolved to names. */
export interface TaskReviewView {
  id: string;
  status: string;
  /**
   * Worker-authored free text. It is DATA: rendered as an attributed quote,
   * never as portal copy, and never pasted onward into anything that treats
   * text as instructions.
   */
  note: string | null;
  declaredAt: string;
  declaredByWorkerId: string | null;
  /** `workers.name`, typed by the MANAGER. Null when no worker filed it. */
  declaredByName: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  /** `profiles.full_name`. Null when a trigger resolved the row (0020). */
  resolvedByName: string | null;
}

/**
 * One photo on the task, with a freshly minted signed URL.
 *
 * `url` may be null while the row still renders — deliberately UNLIKE
 * apps/web's loadTaskPhotos, which drops an unsignable row so the manager is
 * never shown a broken frame. The operator is here precisely to discover that
 * a row exists whose object cannot be signed; hiding it would hide the fault.
 */
export interface OperatorTaskPhoto {
  id: string;
  url: string | null;
  /** 'worker' (WhatsApp) or 'manager' (the sheet). Un-forgeable by grant. */
  source: string;
  storagePath: string;
  mime: string;
  byteSize: number;
  takenAt: string | null;
  createdAt: string;
  workerId: string | null;
  workerName: string | null;
  uploadedBy: string | null;
  uploadedByName: string | null;
}

/** One `notification_log` row that carried this task, recipient resolved. */
export interface TaskSendView {
  row: SendLogRow;
  recipientName: string | null;
  recipientKind: 'worker' | 'manager' | 'unknown';
}

/** One risk signal from `task_board`, named exactly as the view names it. */
export interface RiskSignal {
  id: string;
  label: string;
  fired: boolean;
  why: string;
}

export interface TaskDetail {
  task: Task;
  company: Company;
  job: Job | null;
  /** The row from `task_board`, read with select('*'). Never recomputed. */
  board: TaskBoardRow | null;
  /** From `tasks.assignee_worker_id`, which stays the authoritative lead. */
  lead: Worker | null;
  /** Read through readCollaborators(), never by zipping the view's arrays. */
  collaborators: Worker[];
  /** Collaborator ids the view named but no `workers` row was found for. */
  unresolvedCollaboratorIds: string[];
  dependsOn: TaskDependencyLink[];
  blocks: TaskDependencyLink[];
  reviews: TaskReviewView[];
  photos: OperatorTaskPhoto[];
  /** Storage or table read failed — said on screen, never swallowed. */
  photoError: string | null;
  sends: TaskSendView[];
  sendsError: string | null;
}

/** How long an operator's signed photo URL lasts. Minutes, not seconds, so a
 *  long read does not 403 halfway down the page. */
const OPERATOR_SIGNED_URL_TTL_SECONDS = 300;

/**
 * id → display name for a set of people in ONE company.
 *
 * The company filter is the tenant scope: it is what stops an id belonging to
 * another tenant from resolving to that tenant's person's name. An id that
 * does not resolve is simply absent, and callers render the bare id instead.
 */
async function namesFor(
  companyId: string,
  table: 'workers' | 'profiles',
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const db = getDb();
  if (table === 'workers') {
    const { data } = await db.from('workers').select('id, name').eq('company_id', companyId).in('id', ids);
    for (const row of data ?? []) out.set(row.id, row.name);
  } else {
    const { data } = await db.from('profiles').select('id, full_name').eq('company_id', companyId).in('id', ids);
    for (const row of data ?? []) out.set(row.id, row.full_name);
  }
  return out;
}

/**
 * The photos on one task, each with a signed URL minted RIGHT NOW.
 *
 * A signed URL is a bearer token in a query string: whoever holds it can read
 * the object with no session until it expires. Its only caller is
 * /tasks/[taskId], which is `export const dynamic = 'force-dynamic'`. Keep it
 * that way and do not wrap this in a cache — baked into a prerendered page a
 * signed URL is served to whoever asks and then expires, which leaks briefly
 * and renders broken frames for ever.
 *
 * Written here rather than imported from apps/web, and not only because that
 * import is forbidden: loadTaskPhotos runs on the RLS-scoped client, where the
 * storage.objects policy (0023) is the boundary. This runs on the service
 * role, which has no such boundary — so the company filter below is not
 * belt-and-braces here, it is the whole of the scoping.
 */
async function loadOperatorTaskPhotos(
  companyId: string,
  taskId: string,
): Promise<{ photos: OperatorTaskPhoto[]; error: string | null }> {
  const db = getDb();
  const { data: rows, error } = await db
    .from('task_photos')
    .select('*')
    .eq('company_id', companyId)
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });
  if (error) return { photos: [], error: error.message };
  if (!rows || rows.length === 0) return { photos: [], error: null };

  const { data: signed, error: signError } = await db.storage
    .from(TASK_PHOTO_BUCKET)
    .createSignedUrls(
      rows.map(r => r.storage_path),
      OPERATOR_SIGNED_URL_TTL_SECONDS,
    );

  // Matched on PATH, never by position: createSignedUrls reports per-object
  // failures inline rather than throwing, so one unsignable object would shift
  // every later row onto the wrong image if the two lists were zipped. Same
  // rule the translation applier follows, for the same reason (AGENTS.md).
  const urls = new Map((signed ?? []).map(s => [s.path, s.signedUrl]));

  const workerIds = [...new Set(rows.map(r => r.worker_id).filter((v): v is string => v != null))];
  const profileIds = [...new Set(rows.map(r => r.uploaded_by).filter((v): v is string => v != null))];
  const [workerNames, profileNames] = await Promise.all([
    namesFor(companyId, 'workers', workerIds),
    namesFor(companyId, 'profiles', profileIds),
  ]);

  return {
    photos: rows.map(r => ({
      id: r.id,
      url: urls.get(r.storage_path) ?? null,
      source: r.source,
      storagePath: r.storage_path,
      mime: r.mime,
      byteSize: r.byte_size,
      takenAt: r.taken_at,
      createdAt: r.created_at,
      workerId: r.worker_id,
      workerName: r.worker_id ? (workerNames.get(r.worker_id) ?? null) : null,
      uploadedBy: r.uploaded_by,
      uploadedByName: r.uploaded_by ? (profileNames.get(r.uploaded_by) ?? null) : null,
    })),
    error: signError?.message ?? null,
  };
}

/**
 * Every WhatsApp send whose snapshot carried this task.
 *
 * This is the column that answers "did the crew ever actually hear about this
 * task", and until #155 it was unreachable from any screen — `notification_log`
 * is deny-all to tenants and the operator only ever read it per COMPANY.
 *
 * `task_ids` is JSONB, not a Postgres array, so containment has to be
 * expressed as JSON. Passing an ARRAY to .contains() would emit PostgREST's
 * array-literal form `cs.{uuid}`, which is not valid JSON and errors on a
 * jsonb column; the string form below emits `cs.["uuid"]`, i.e.
 * `task_ids @> '["uuid"]'::jsonb`, which is the containment we want.
 *
 * Any error is RETURNED rather than swallowed: an operator reading "never
 * sent" off a failed query is exactly the wrong conclusion to hand somebody
 * silently.
 */
async function loadTaskSends(
  companyId: string,
  taskId: string,
): Promise<{ sends: TaskSendView[]; error: string | null }> {
  const db = getDb();
  const { data, error } = await db
    .from('notification_log')
    .select('*')
    .eq('company_id', companyId)
    .contains('task_ids', JSON.stringify([taskId]))
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return { sends: [], error: error.message };

  const rows = data ?? [];
  const workerIds = [...new Set(rows.map(r => r.worker_id).filter((v): v is string => v != null))];
  const profileIds = [...new Set(rows.map(r => r.profile_id).filter((v): v is string => v != null))];
  const [workerNames, profileNames] = await Promise.all([
    namesFor(companyId, 'workers', workerIds),
    namesFor(companyId, 'profiles', profileIds),
  ]);

  return {
    sends: rows.map(row => ({
      row,
      recipientKind: row.worker_id ? 'worker' : row.profile_id ? 'manager' : 'unknown',
      recipientName: row.worker_id
        ? (workerNames.get(row.worker_id) ?? null)
        : row.profile_id
          ? (profileNames.get(row.profile_id) ?? null)
          : null,
    })),
    error: null,
  };
}

/**
 * The five risk signals `task_board` computes, READ from the view.
 *
 * Named and explained rather than reduced to a boolean, because "at risk" on
 * its own tells an operator nothing: the manager's board shows the same chip
 * for a blocked task, a late start, an approaching deadline, a late
 * predecessor and a paused obra, and those are five different problems.
 *
 * `at_risk` itself is NOT their OR: the view suppresses it for anything
 * already overdue (something late is late, not at risk) while leaving the
 * individual flags set — so a signal can read as fired while `at_risk` is
 * false, and that is the view being right, not a bug here.
 */
export function riskSignals(board: TaskBoardRow | null): RiskSignal[] {
  return [
    {
      id: 'risk_blocked',
      label: 'Blocked',
      fired: board?.risk_blocked === true,
      why: 'open, and its status is `blocked`',
    },
    {
      id: 'risk_late_start',
      label: 'Late start',
      fired: board?.risk_late_start === true,
      why: 'still `pending` and its start_date has passed',
    },
    {
      id: 'risk_due_soon',
      label: 'Due soon',
      fired: board?.risk_due_soon === true,
      why: 'still `pending` and due within the next two WORKING days',
    },
    {
      id: 'risk_late_dependency',
      label: 'Late dependency',
      fired: board?.risk_late_dependency === true,
      why: 'a predecessor is unfinished and past its own deadline',
    },
    {
      id: 'risk_paused_job',
      label: 'Paused obra',
      fired: board?.risk_paused_job === true,
      why: 'the obra this task belongs to is paused',
    },
  ];
}

/**
 * Everything one task can be asked about. Null when no such task exists.
 *
 * `overdue` / `at_risk` and the five signals come from `task_board` and are
 * NEVER re-derived here: the view is the one clock, and a portal that computed
 * its own answer would eventually disagree with the manager's own board with
 * nothing to say which was right (AGENTS.md).
 */
export async function loadTaskDetail(taskId: string): Promise<TaskDetail | null> {
  const db = getDb();

  const { data: task } = await db.from('tasks').select('*').eq('id', taskId).maybeSingle();
  if (!task) return null;
  const companyId = task.company_id;

  const { data: company } = await db.from('companies').select('*').eq('id', companyId).maybeSingle();
  if (!company) return null;

  const [job, board, reviews, dependsOnEdges, blocksEdges, photoResult, sendResult] = await Promise.all([
    task.job_id
      ? db.from('jobs').select('*').eq('id', task.job_id).eq('company_id', companyId).maybeSingle().then(r => r.data)
      : Promise.resolve(null),
    // select('*') on the view, per the house rule: 0035 appended two columns to
    // it and a future migration may append more, so a deploy landing ahead of
    // its migration must degrade rather than 42703.
    db.from('task_board').select('*').eq('id', taskId).eq('company_id', companyId).maybeSingle().then(r => r.data),
    db
      .from('task_reviews')
      .select('*')
      .eq('task_id', taskId)
      .eq('company_id', companyId)
      .order('declared_at', { ascending: false })
      .then(r => r.data ?? []),
    db.from('task_dependencies').select('depends_on_task_id').eq('task_id', taskId).then(r => r.data ?? []),
    db.from('task_dependencies').select('task_id').eq('depends_on_task_id', taskId).then(r => r.data ?? []),
    loadOperatorTaskPhotos(companyId, taskId),
    loadTaskSends(companyId, taskId),
  ]);

  // ── Who is on it ──────────────────────────────────────────────────────────
  //
  // The LEAD is tasks.assignee_worker_id and is never taken from the mirrored
  // `lead` row in task_assignees — 0035's whole safety design. The
  // COLLABORATORS come from readCollaborators(), the one sanctioned reader of
  // the view's two appended arrays: it length-guards them, so on a deploy that
  // lands before 0035 it answers "nobody" rather than naming the wrong person
  // to their own crew.
  const collaboratorRefs = board ? readCollaborators(board) : [];
  const crewIds = board
    ? everyoneOnTask(board)
    : task.assignee_worker_id
      ? [task.assignee_worker_id]
      : [];
  const crew = crewIds.length
    ? await db.from('workers').select('*').eq('company_id', companyId).in('id', crewIds).then(r => r.data ?? [])
    : [];
  const crewById = new Map(crew.map(w => [w.id, w]));
  const collaborators = collaboratorRefs
    .map(c => crewById.get(c.id))
    .filter((w): w is Worker => w != null);
  const unresolvedCollaboratorIds = collaboratorRefs.filter(c => !crewById.has(c.id)).map(c => c.id);

  // ── Dependencies, both directions ─────────────────────────────────────────
  const neighbourIds = [
    ...new Set([...dependsOnEdges.map(e => e.depends_on_task_id), ...blocksEdges.map(e => e.task_id)]),
  ];
  const neighbours = neighbourIds.length
    ? await db
        .from('tasks')
        // The company filter is the tenant scope: 0007 constrains both ends of
        // an edge to one company, and a row that somehow escaped that is
        // dropped here rather than rendered on this tenant's screen.
        .select('id, title, status, due_date, job_id, jobs(name)')
        .eq('company_id', companyId)
        .in('id', neighbourIds)
        .then(r => r.data ?? [])
    : [];
  const neighbourById = new Map<string, TaskDependencyLink>(
    neighbours.map(n => [
      n.id,
      {
        id: n.id,
        title: n.title,
        status: n.status,
        dueDate: n.due_date,
        jobId: n.job_id,
        jobName: n.jobs?.name ?? null,
        crossJob: n.job_id !== task.job_id,
      },
    ]),
  );
  const resolveLinks = (ids: string[]): TaskDependencyLink[] =>
    ids.flatMap(id => {
      const link = neighbourById.get(id);
      return link ? [link] : [];
    });

  // ── Completion claims ─────────────────────────────────────────────────────
  const claimWorkerIds = [
    ...new Set(reviews.map(r => r.declared_by_worker_id).filter((v): v is string => v != null)),
  ];
  const claimProfileIds = [...new Set(reviews.map(r => r.resolved_by).filter((v): v is string => v != null))];
  const [claimWorkerNames, claimProfileNames] = await Promise.all([
    namesFor(companyId, 'workers', claimWorkerIds),
    namesFor(companyId, 'profiles', claimProfileIds),
  ]);

  return {
    task,
    company,
    job: job ?? null,
    board: board ?? null,
    lead: task.assignee_worker_id ? (crewById.get(task.assignee_worker_id) ?? null) : null,
    collaborators,
    unresolvedCollaboratorIds,
    dependsOn: resolveLinks(dependsOnEdges.map(e => e.depends_on_task_id)),
    blocks: resolveLinks(blocksEdges.map(e => e.task_id)),
    reviews: reviews.map(r => ({
      id: r.id,
      status: r.status,
      note: r.note,
      declaredAt: r.declared_at,
      declaredByWorkerId: r.declared_by_worker_id,
      declaredByName: r.declared_by_worker_id ? (claimWorkerNames.get(r.declared_by_worker_id) ?? null) : null,
      resolvedAt: r.resolved_at,
      resolvedBy: r.resolved_by,
      resolvedByName: r.resolved_by ? (claimProfileNames.get(r.resolved_by) ?? null) : null,
    })),
    photos: photoResult.photos,
    photoError: photoResult.error,
    sends: sendResult.sends,
    sendsError: sendResult.error,
  };
}
