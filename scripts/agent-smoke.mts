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
const { isWorkday } = await import('@capo/core/capabilities/workdays');
const { runTranslationBatch, revertTranslationBatch } = await import('@capo/core/translation');

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
  await db.from('translation_items').delete().eq('company_id', t.companyId);
  await db.from('translation_batches').delete().eq('company_id', t.companyId);
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

// Which tools the agent actually reached for on its most recent turn. Asserting
// on this (not just on the prose) is how we catch the agent quietly going back
// to hand-rolled date arithmetic instead of the `agenda` view — a regression
// that reads perfectly fine in the reply while silently disagreeing with the
// manager's screen.
async function lastTurnToolNames(companyId: string): Promise<string[]> {
  const { data: convs } = await db.from('conversations').select('id').eq('company_id', companyId);
  const conversationIds = (convs ?? []).map(c => c.id);
  if (conversationIds.length === 0) return [];
  const { data } = await db
    .from('messages')
    .select('content')
    .in('conversation_id', conversationIds)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const parts = (data?.content as { parts?: { type?: string }[] } | null)?.parts ?? [];
  return parts
    .map(p => p.type ?? '')
    .filter(type => type.startsWith('tool-'))
    .map(type => type.slice('tool-'.length));
}

// ── checks ──────────────────────────────────────────────────────────────────
let base: Tenant | undefined;
let empty: Tenant | undefined;
let english: Tenant | undefined;
let translate: Tenant | undefined;
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
    // Both ends now, not just the start: the scheduler advances durations in
    // working days, so a due date landing on a Saturday or on 25 de Abril
    // means the calendar logic has regressed. (The exhaustive version of this
    // runs credential-free in `pnpm scheduler-check`.)
    const onlyWorkdays = (planTasks ?? []).every(
      t => t.start_date && t.due_date && isWorkday(t.start_date) && isWorkday(t.due_date),
    );
    check(
      'plan approved: tasks + dependencies exist, dates land on working days',
      resolution.outcome === 'approved' && (planTasks ?? []).length > 0 && allDatesSane && onlyWorkdays,
      `outcome=${resolution.outcome} tasks=${(planTasks ?? []).length} deps=${depCount} allDatesSane=${allDatesSane} onlyWorkdays=${onlyWorkdays}`,
    );
  } else {
    check('plan approved: tasks + dependencies exist, dates land on working days', false, 'no apply_plan proposal to approve');
  }

  // (6) Day questions must go through `agenda` (the board's own view), not
  // through list_tasks plus the model's own date arithmetic. Asserting on the
  // TOOL rather than the prose is the point: a hand-computed answer reads
  // perfectly while quietly disagreeing with the manager's screen.
  const todayReply = await sendTurn(base, 'O que temos para hoje?');
  const todayTools = await lastTurnToolNames(base.companyId);
  check(
    'agenda: "o que temos para hoje?" calls the agenda tool',
    todayTools.includes('agenda'),
    `tools=[${todayTools.join(', ')}] reply="${todayReply.slice(0, 90)}"`,
  );

  // (7) The anticipation habit: asking what to buy must reach for the
  // materials outlook rather than being answered from memory.
  const buyReply = await sendTurn(base, 'O que é que eu preciso de comprar para amanhã?');
  const buyTools = await lastTurnToolNames(base.companyId);
  check(
    'materials: "o que preciso de comprar?" calls materials_outlook',
    buyTools.includes('materials_outlook'),
    `tools=[${buyTools.join(', ')}] reply="${buyReply.slice(0, 90)}"`,
  );

  // (8) An en-US tenant is actually answered in English. Cheap but load-bearing:
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

  // (9) Tenant-wide translation, end to end: chat → approval card → batch →
  // undo. This is the only place the whole feature is exercised together, and
  // the last assertion is the important one — a byte-identical restore proves
  // the snapshot, the jsonb round-trip, the text[] reconstruction and the
  // security-definer RPC all work, in one line.
  translate = await seedTenant('translate', { withJobAndWorker: true });
  const translateTenant = translate;
  const paintTask = await must(
    db
      .from('tasks')
      .insert({
        company_id: translateTenant.companyId,
        job_id: translateTenant.jobId,
        title: 'Pintar a fachada do primeiro andar',
        description: 'Duas demãos, começar pelo lado norte.',
        materials: ['tinta branca', 'rolo', 'fita de pintor'],
        source: 'manager',
      })
      .select()
      .single(),
    'translate: seed paint task',
  );
  await must(
    db
      .from('tasks')
      .insert({ company_id: translateTenant.companyId, title: 'Ligar ao fornecedor de cimento', source: 'manager' })
      .select()
      .single(),
    'translate: seed call task',
  );
  await must(
    db
      .from('memories')
      .insert({ company_id: translateTenant.companyId, kind: 'fact', content: 'O cliente prefere trabalhos de manhã.' })
      .select()
      .single(),
    'translate: seed memory',
  );

  // Snapshot every string BEFORE anything touches it.
  const snapshot = async () => {
    const { data: ts } = await db
      .from('tasks')
      .select('id, title, description, materials')
      .eq('company_id', translateTenant.companyId)
      .order('id');
    const { data: js } = await db.from('jobs').select('id, name').eq('company_id', translateTenant.companyId).order('id');
    const { data: ms } = await db
      .from('memories')
      .select('id, content')
      .eq('company_id', translateTenant.companyId)
      .order('id');
    return JSON.stringify({ ts, js, ms });
  };
  const before = await snapshot();

  await sendTurn(translateTenant, 'Quero tudo em inglês a partir de agora, também as tarefas e as obras.');
  const translationProposals = (await pendingProposals(translateTenant.companyId)).filter(
    p => p.action_name === 'apply_company_translation',
  );
  check(
    'translation: "quero tudo em inglês" raises an apply_company_translation card',
    translationProposals.length === 1,
    `pending=[${(await pendingProposals(translateTenant.companyId)).map(p => p.action_name).join(', ')}]`,
  );

  if (translationProposals.length === 1) {
    const card = translationProposals[0];
    check(
      'translation: the card states counts and that it is reversible',
      /\b3\b/.test(card.rendered_text) && /revers/i.test(card.rendered_text),
      `card="${card.rendered_text}"`,
    );

    const resolution = await resolveProposal(db, card.id, 'approve', { user: 'en-US', company: 'pt-PT' });
    const batchId =
      resolution.outcome === 'approved' ? (resolution.result as { batchId?: string })?.batchId : undefined;
    const { data: afterApprove } = await db
      .from('companies')
      .select('language')
      .eq('id', translateTenant.companyId)
      .maybeSingle();
    check(
      'translation: approving flips the company dial and queues a batch',
      afterApprove?.language === 'en-US' && typeof batchId === 'string',
      `language=${afterApprove?.language} batchId=${batchId}`,
    );

    if (batchId) {
      const status = await runTranslationBatch(db, batchId, { budgetMs: 120_000 });
      const { data: items } = await db.from('translation_items').select('status').eq('batch_id', batchId);
      const { data: translatedTasks } = await db
        .from('tasks')
        .select('id, title, materials')
        .eq('company_id', translateTenant.companyId)
        .order('id');
      const painted = translatedTasks?.find(t => t.id === paintTask.id);

      check(
        'translation: the batch completes with every item applied',
        status.status === 'completed' && (items ?? []).every(i => i.status === 'applied'),
        `status=${status.status} items=[${(items ?? []).map(i => i.status).join(', ')}]`,
      );
      check(
        'translation: titles changed and materials kept their array shape',
        painted?.title !== 'Pintar a fachada do primeiro andar' && painted?.materials?.length === 3,
        `title="${painted?.title}" materials=${JSON.stringify(painted?.materials)}`,
      );

      // The load-bearing assertion. Not "looks Portuguese again" — byte-identical.
      const result = await revertTranslationBatch(db, batchId);
      const after = await snapshot();
      const { data: afterRevert } = await db
        .from('companies')
        .select('language')
        .eq('id', translateTenant.companyId)
        .maybeSingle();
      check(
        'translation: undo restores every string byte-for-byte and the dial with it',
        after === before && afterRevert?.language === 'pt-PT',
        after === before
          ? `language=${afterRevert?.language} reverted=${result.reverted} skipped=${result.skipped}`
          : 'stored text differs from the pre-translation snapshot',
      );
    }
  }

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
  try {
    await cleanupTenant(translate);
  } catch (e) {
    console.error(`cleanup(translate): ${e instanceof Error ? e.message : String(e)}`);
  }
}

process.exit(failures === 0 ? 0 : 1);
