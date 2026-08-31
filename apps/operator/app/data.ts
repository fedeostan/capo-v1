// Read-only, cross-tenant queries for mission control. Everything here runs
// on getDb() — the service-role SYSTEM client — because the operator sees all
// companies by design. This app is the reason getDb() exists; nothing in
// apps/web may import this file. All reads, no writes: mutations happen only
// through each tenant's own chat.
import { getDb } from '@capo/db/client';
import type { Tables } from '@capo/db/types';
import { hasWhatsAppConsent } from '@capo/core/channels/whatsapp';
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
