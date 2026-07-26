// Agent smoke test — the recurring "does the agent still work" QA gate.
//
// Drives handleInbound() directly (the same entry point web chat and
// WhatsApp both call) against a throwaway seeded tenant, asserting on DB
// state and rendered proposal text rather than mocking anything. Modeled on
// scripts/rls-isolation-matrix.mjs (same env loading + seed/cleanup
// discipline), but seeds via service-role inserts (no signed-in client
// needed — handleInbound takes a Db directly, same as the WhatsApp route).
//
// Run with `pnpm agent-smoke` (root: tsx scripts/agent-smoke.mts).
// Exit code 0 = all checks green; 1 = at least one check failed.

import { readFileSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import type { OutboundSink } from '@capo/core/channels/types';

// ── env (must land in process.env before getDb()/getModel() read it) ───────
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envFile = path.join(repoRoot, 'apps/web/.env.local');
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in apps/web/.env.local');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in apps/web/.env.local');
  process.exit(1);
}

const { getDb } = await import('@capo/db/client');
const { handleInbound } = await import('@capo/core/agent');
const { resolveProposal } = await import('@capo/core/capabilities/propose');

const db = getDb();
const run = randomBytes(4).toString('hex');
const results: { name: string; ok: boolean; detail: string }[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
}

async function must<T>(promise: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

// ── seeding ─────────────────────────────────────────────────────────────────
interface Tenant {
  label: string;
  userId: string;
  companyId: string;
  // Both DB dials are seeded to this one value; the smoke test has no case
  // where a tenant's user and company languages differ.
  locale: 'pt-PT' | 'es-ES' | 'en-US';
  jobId?: string;
  workerId?: string;
}

async function seedTenant(
  label: string,
  opts: { withJobAndWorker?: boolean; locale?: Tenant['locale'] } = {},
): Promise<Tenant> {
  const { withJobAndWorker = true, locale = 'pt-PT' } = opts;
  const email = `agent-smoke-${label}-${run}@example.com`;
  const password = randomBytes(16).toString('hex');
  const phone = `+35192${randomInt(1000000, 9999999)}`;

  const { data: userData, error: userErr } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { agent_smoke_run: run },
  });
  if (userErr) throw new Error(`createUser(${label}): ${userErr.message}`);
  const userId = userData.user.id;

  const company = await must(
    db.from('companies').insert({ name: `Agent Smoke ${label} ${run}`, language: locale }).select().single(),
    `company(${label})`,
  );
  const companyId = company.id;

  await must(
    db
      .from('profiles')
      .insert({ id: userId, company_id: companyId, full_name: `Smoke ${label}`, phone, language: locale })
      .select()
      .single(),
    `profile(${label})`,
  );

  let jobId: string | undefined;
  let workerId: string | undefined;
  if (withJobAndWorker) {
    const worker = await must(
      db.from('workers').insert({ company_id: companyId, name: 'Trabalhador Smoke' }).select().single(),
      `worker(${label})`,
    );
    workerId = worker.id;
    const job = await must(
      db.from('jobs').insert({ company_id: companyId, name: 'Obra Smoke Base' }).select().single(),
      `job(${label})`,
    );
    jobId = job.id;
  }

  return { label, userId, companyId, locale, jobId, workerId };
}

async function cleanupTenant(t: Tenant | undefined) {
  if (!t) return;
  const { data: convs } = await db.from('conversations').select('id').eq('company_id', t.companyId);
  const conversationIds = (convs ?? []).map(c => c.id);
  if (conversationIds.length) {
    await db.from('conversation_summaries').delete().in('conversation_id', conversationIds);
    await db.from('messages').delete().in('conversation_id', conversationIds);
  }
  await db.from('proposals').delete().eq('company_id', t.companyId);
  const { data: tasks } = await db.from('tasks').select('id').eq('company_id', t.companyId);
  const taskIds = (tasks ?? []).map(x => x.id);
  if (taskIds.length) await db.from('task_dependencies').delete().in('task_id', taskIds);
  await db.from('tasks').delete().eq('company_id', t.companyId);
  await db.from('memories').delete().eq('company_id', t.companyId);
  await db.from('conversations').delete().eq('company_id', t.companyId);
  await db.from('jobs').delete().eq('company_id', t.companyId);
  await db.from('workers').delete().eq('company_id', t.companyId);
  await db.from('profiles').delete().eq('id', t.userId);
  await db.from('companies').delete().eq('id', t.companyId);
  await db.auth.admin.deleteUser(t.userId);
}

// ── driving the agent ────────────────────────────────────────────────────────
function collectingSink(): { sink: OutboundSink; result: Promise<UIMessage | undefined> } {
  let resolveResult!: (msg: UIMessage | undefined) => void;
  const result = new Promise<UIMessage | undefined>(resolve => {
    resolveResult = resolve;
  });
  const sink: OutboundSink = {
    mergeAssistantStream(stream: ReadableStream<UIMessageChunk>) {
      (async () => {
        let final: UIMessage | undefined;
        try {
          for await (const message of readUIMessageStream({ stream })) {
            final = message;
          }
        } finally {
          resolveResult(final);
        }
      })();
    },
  };
  return { sink, result };
}

function messageText(message: UIMessage | undefined): string {
  if (!message) return '';
  return message.parts
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
    .map(p => p.text)
    .join('\n');
}

// Takes the whole Tenant rather than a bare companyId: handleInbound now needs
// the user identity and both language dials, and every caller already has one.
async function sendTurn(tenant: Tenant, text: string): Promise<string> {
  const { sink, result } = collectingSink();
  await handleInbound({
    db,
    companyId: tenant.companyId,
    userId: tenant.userId,
    locales: { user: tenant.locale, company: tenant.locale },
    inbound: { channel: 'web', text },
    sink,
  });
  return messageText(await result);
}

async function pendingProposals(companyId: string) {
  const { data } = await db.from('proposals').select('*').eq('company_id', companyId).eq('status', 'pending');
  return data ?? [];
}

// ── checks ──────────────────────────────────────────────────────────────────
let base: Tenant | undefined;
let empty: Tenant | undefined;
let english: Tenant | undefined;
try {
  console.log(`Seeding agent-smoke tenants (run ${run})…`);
  base = await seedTenant('base');

  // (1) Greeting → non-empty pt-PT reply.
  const greeting = await sendTurn(base, 'Olá');
  check('greeting: non-empty reply', greeting.trim().length > 0, `reply: "${greeting.slice(0, 120)}"`);

  // (2) Explicit manager command → guarded create_job runs directly or proposes.
  await sendTurn(base, 'Cria uma obra chamada Obra Teste Smoke');
  const { data: createdJobs } = await db.from('jobs').select('id').eq('company_id', base.companyId).eq('name', 'Obra Teste Smoke');
  const jobCreated = (createdJobs ?? []).length > 0;
  const proposalsAfterCreate = await pendingProposals(base.companyId);
  const jobProposed = proposalsAfterCreate.some(p => p.action_name === 'create_job');
  check('guarded create: job row or pending proposal', jobCreated || jobProposed, `jobCreated=${jobCreated} jobProposed=${jobProposed}`);

  // (3) Suggestion-shaped ask (not a direct command) → proposal with rendered_text.
  await sendTurn(base, 'Achas que fazia sentido adicionarmos uma tarefa de limpeza final na Obra Smoke Base?');
  const proposalsAfterSuggestion = await pendingProposals(base.companyId);
  const suggestionProposal = proposalsAfterSuggestion.find(p => (p.rendered_text ?? '').length > 0);
  check('suggestion: proposal with rendered_text', Boolean(suggestionProposal), `pending proposals: ${proposalsAfterSuggestion.length}`);

  // (4) Empty tenant (no obras/workers/tasks) → first-run guidance: mentions
  // "obra" and asks a question rather than dumping a form.
  empty = await seedTenant('empty', { withJobAndWorker: false });
  const firstRunReply = await sendTurn(empty, 'Olá');
  const mentionsObra = /obra/i.test(firstRunReply);
  const asksQuestion = firstRunReply.includes('?');
  check('first-run: mentions obra and asks a question', mentionsObra && asksQuestion, `reply: "${firstRunReply.slice(0, 160)}"`);

  // (5) Quote → plan → approve → tasks + dependencies exist, with sane dates.
  const planReply = await sendTurn(
    base,
    'Aqui está o orçamento aprovado para a Obra Smoke Base: demolição da casa de banho, canalização nova, azulejo e loiças. Começa na próxima segunda. Faz-me o plano.',
  );
  const proposalsAfterPlan = await pendingProposals(base.companyId);
  const planProposal = proposalsAfterPlan.find(p => p.action_name === 'apply_plan');
  const numberedLineCount = planProposal ? (planProposal.rendered_text.match(/^\d+\./gm) ?? []).length : 0;
  const hasDateFormat = planProposal ? /\d{2}\/\d{2}\/\d{4}/.test(planProposal.rendered_text) : false;
  check(
    'plan: pending apply_plan proposal with ≥3 numbered lines with dates',
    Boolean(planProposal) && numberedLineCount >= 3 && hasDateFormat,
    `planReply: "${planReply.slice(0, 80)}"; numberedLines=${numberedLineCount}`,
  );

  if (planProposal) {
    const resolution = await resolveProposal(db, planProposal.id, 'approve', { user: base.locale, company: base.locale });
    const jobId = (planProposal.action_args as { job_id: string }).job_id;
    const { data: planTasks } = await db.from('tasks').select('id, start_date, due_date').eq('company_id', base.companyId).eq('job_id', jobId);
    let depCount = 0;
    if ((planTasks ?? []).length > 0) {
      const { data: deps } = await db
        .from('task_dependencies')
        .select('task_id')
        .in('task_id', (planTasks ?? []).map(t => t.id));
      depCount = (deps ?? []).length;
    }
    const allDatesSane = (planTasks ?? []).every(t => t.start_date && t.due_date && t.start_date <= t.due_date);
    const noWeekendStarts = (planTasks ?? []).every(t => {
      if (!t.start_date) return false;
      const day = new Date(`${t.start_date}T00:00:00Z`).getUTCDay();
      return day !== 0 && day !== 6;
    });
    check(
      'plan approved: tasks + dependencies exist with sane dates',
      resolution.outcome === 'approved' && (planTasks ?? []).length > 0 && allDatesSane && noWeekendStarts,
      `outcome=${resolution.outcome} tasks=${(planTasks ?? []).length} deps=${depCount} allDatesSane=${allDatesSane} noWeekendStarts=${noWeekendStarts}`,
    );
  } else {
    check('plan approved: tasks + dependencies exist with sane dates', false, 'no apply_plan proposal to approve');
  }

  // (6) An en-US tenant is actually answered in English. Cheap but load-bearing:
  // the persona registry, the language directive, and the prompt blocks all have
  // to be wired for this to pass, and a regression in any of them silently
  // reverts Capo to Portuguese for every non-PT user.
  english = await seedTenant('english', { withJobAndWorker: false, locale: 'en-US' });
  const englishReply = await sendTurn(english, 'Hi');
  const looksEnglish = /\b(the|and|you|your|what|need)\b/i.test(englishReply);
  // Portuguese-only signals: the ção/ções ending and stopwords that have no
  // English homograph (deliberately not "a"/"o"/"e", which do).
  const looksPortuguese = /ção|ções|\b(uma|não|você|para|obra|tarefa)\b/i.test(englishReply);
  check(
    'en-US tenant: reply is English, not Portuguese',
    englishReply.trim().length > 0 && looksEnglish && !looksPortuguese,
    `reply: "${englishReply.slice(0, 160)}"`,
  );

  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log('');
  console.log(`Agent smoke: ${results.filter(r => r.ok).length}/${results.length} checks passed; failures: ${failures}`);
} catch (err) {
  console.error(`\nFATAL: ${err instanceof Error ? err.message : String(err)}`);
  failures += 1;
} finally {
  console.log('\nCleaning up seeded tenants…');
  try {
    await cleanupTenant(base);
  } catch (e) {
    console.error(`cleanup(base): ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await cleanupTenant(empty);
  } catch (e) {
    console.error(`cleanup(empty): ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await cleanupTenant(english);
  } catch (e) {
    console.error(`cleanup(english): ${e instanceof Error ? e.message : String(e)}`);
  }
}

process.exit(failures === 0 ? 0 : 1);
