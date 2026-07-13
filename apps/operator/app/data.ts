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
