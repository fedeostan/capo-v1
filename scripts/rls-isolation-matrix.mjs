// RLS isolation matrix — the recurring tenant-boundary QA gate.
//
// Seeds TWO throwaway tenants (auth user + company + one row in every tenant
// table), then, authenticated as each user in turn, verifies the visibility
// matrix: for each RLS-covered relation × 2 tenants, the caller sees its own
// seeded row and nothing from the other tenant. Then runs the adversarial
// cross-tenant attacks and expects every one to be rejected. Everything seeded
// is deleted afterwards. The totals are printed at the end rather than asserted
// against a hardcoded count, because both grow as tables are added.
//
// The adversarial set covers, in order: the two migration-0009 FK triggers
// (own-company task pointing at the other company's job/worker; own-company
// proposal pointing at the other company's conversation), the 0011 billing
// column revoke, and the 0015 revert_translation_batch RPC. That last one
// matters more than it looks: the RPC is SECURITY DEFINER, so RLS does NOT
// cover it and its internal auth.uid() check is the entire tenant boundary.
//
// Runs against the live Supabase project using apps/web/.env.local:
//   pnpm rls-matrix        (root: node scripts/rls-isolation-matrix.mjs)
//
// Exit code 0 = matrix green; 1 = at least one check failed.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── env ─────────────────────────────────────────────────────────────────────
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envFile = path.join(repoRoot, 'apps/web/.env.local');
const env = { ...process.env };
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !(m[1] in process.env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY } = env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !NEXT_PUBLIC_SUPABASE_URL || !NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
  console.error('Missing Supabase env vars in apps/web/.env.local');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const run = randomBytes(4).toString('hex');
const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
}

async function must(promise, what) {
  const { data, error } = await promise;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

// ── seeding ─────────────────────────────────────────────────────────────────
async function seedTenant(label) {
  const email = `rls-matrix-${label}-${run}@example.com`;
  const password = randomBytes(16).toString('hex');
  const phone = `+35191${randomInt(1000000, 9999999)}`;

  const { data: userData, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { rls_matrix_run: run },
  });
  if (userErr) throw new Error(`createUser(${label}): ${userErr.message}`);
  const userId = userData.user.id;

  const company = (await must(
    admin.from('companies').insert({ name: `RLS Matrix ${label} ${run}` }).select().single(),
    `company(${label})`,
  ));
  const companyId = company.id;

  await must(
    admin.from('profiles').insert({ id: userId, company_id: companyId, full_name: `Matrix ${label}`, phone }).select().single(),
    `profile(${label})`,
  );
  const worker = await must(
    admin.from('workers').insert({ company_id: companyId, name: `Worker ${label}` }).select().single(),
    `worker(${label})`,
  );
  const job = await must(
    admin.from('jobs').insert({ company_id: companyId, name: `Obra ${label}` }).select().single(),
    `job(${label})`,
  );
  const task1 = await must(
    admin.from('tasks').insert({
      company_id: companyId, job_id: job.id, assignee_worker_id: worker.id,
      title: `Task 1 ${label}`, source: 'manager',
    }).select().single(),
    `task1(${label})`,
  );
  const task2 = await must(
    admin.from('tasks').insert({ company_id: companyId, title: `Task 2 ${label}`, source: 'manager' }).select().single(),
    `task2(${label})`,
  );
  await must(
    admin.from('task_dependencies').insert({ task_id: task2.id, depends_on_task_id: task1.id }).select(),
    `task_dependency(${label})`,
  );
  const conversation = await must(
    admin.from('conversations').insert({ company_id: companyId }).select().single(),
    `conversation(${label})`,
  );
  const message = await must(
    admin.from('messages').insert({
      conversation_id: conversation.id, role: 'user',
      content: { parts: [{ type: 'text', text: `hello from ${label}` }] },
    }).select().single(),
    `message(${label})`,
  );
  await must(
    admin.from('conversation_summaries').insert({
      conversation_id: conversation.id, summary: `summary ${label}`, covers_until_message_id: message.id,
    }).select(),
    `conversation_summary(${label})`,
  );
  await must(
    admin.from('memories').insert({ company_id: companyId, kind: 'fact', content: `memory ${label}` }).select(),
    `memory(${label})`,
  );
  await must(
    admin.from('proposals').insert({
      company_id: companyId, conversation_id: conversation.id,
      action_name: 'noop', action_args: {}, rendered_text: `proposal ${label}`,
    }).select(),
    `proposal(${label})`,
  );
  await must(
    admin.from('transcription_vocab').insert({ company_id: companyId, term: `term-${label}-${run}` }).select(),
    `transcription_vocab(${label})`,
  );

  // A COMPLETED batch whose single item is APPLIED — i.e. one that
  // revert_translation_batch would genuinely act on. Seeding it 'pending'
  // instead would make the adversarial check below pass for the wrong reason
  // (refused as un-revertible rather than as another tenant's).
  const originalTitle = `ORIGINAL ${label} ${run}`;
  const batch = await must(
    admin.from('translation_batches').insert({
      company_id: companyId, from_locale: 'pt-PT', to_locale: 'en-US',
      status: 'completed', origin: 'web', item_count: 1, done_count: 1,
    }).select().single(),
    `translation_batch(${label})`,
  );
  await must(
    admin.from('translation_items').insert({
      batch_id: batch.id, company_id: companyId,
      table_name: 'tasks', column_name: 'title', row_id: task1.id,
      old_value: originalTitle, new_value: `Task 1 ${label}`, status: 'applied',
    }).select(),
    `translation_item(${label})`,
  );

  // A check-in answer. Written as the service role, which is the ONLY writer in
  // production too — the WhatsApp webhook. There is no insert policy, so the
  // adversarial pass below can assert that a tenant cannot forge one.
  await must(
    admin.from('worker_checkins').insert({
      company_id: companyId, worker_id: worker.id,
      checkin_date: '2026-01-05', answer: 'done', task_ids: [task1.id],
    }).select(),
    `worker_checkin(${label})`,
  );

  const client = createClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false },
  });
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(`signIn(${label}): ${signInErr.message}`);

  return {
    label, userId, companyId, client,
    workerId: worker.id, jobId: job.id, taskIds: [task1.id, task2.id],
    conversationId: conversation.id, batchId: batch.id, originalTitle,
  };
}

async function cleanupTenant(t) {
  if (!t) return;
  // Reverse dependency order; every delete is scoped to this run's rows only.
  const companyEq = (q) => q.eq('company_id', t.companyId);
  await companyEq(admin.from('translation_items').delete());
  await companyEq(admin.from('translation_batches').delete());
  await companyEq(admin.from('proposals').delete());
  await admin.from('conversation_summaries').delete().eq('conversation_id', t.conversationId);
  await admin.from('messages').delete().eq('conversation_id', t.conversationId);
  await admin.from('task_dependencies').delete().in('task_id', t.taskIds);
  await companyEq(admin.from('tasks').delete());
  await companyEq(admin.from('memories').delete());
  await companyEq(admin.from('transcription_vocab').delete());
  await companyEq(admin.from('conversations').delete());
  // Before workers: worker_checkins.worker_id is a FK.
  await companyEq(admin.from('worker_checkins').delete());
  await companyEq(admin.from('workers').delete());
  await companyEq(admin.from('jobs').delete());
  await admin.from('profiles').delete().eq('id', t.userId);
  await admin.from('companies').delete().eq('id', t.companyId);
  await admin.auth.admin.deleteUser(t.userId);
}

// ── the matrix ──────────────────────────────────────────────────────────────
async function runMatrix(self, other) {
  const db = self.client;
  const L = self.label;

  // Relations carrying company_id directly: own rows visible, zero foreign
  // rows. task_board is a view, not a table — it is here because a
  // security_invoker view is a real tenant read surface, and the /tarefas
  // screen reads the whole board through it. If it were ever recreated
  // without security_invoker it would leak every company's tasks, and nothing
  // else in this repo would notice.
  for (const table of ['companies', 'workers', 'jobs', 'tasks', 'memories', 'conversations', 'proposals', 'transcription_vocab', 'task_board', 'translation_batches', 'translation_items', 'worker_checkins']) {
    const { data, error } = await db.from(table).select('*');
    const rows = data ?? [];
    const ownKey = table === 'companies' ? 'id' : 'company_id';
    const foreign = rows.filter(r => r[ownKey] !== self.companyId);
    const ownVisible = rows.some(r => r[ownKey] === self.companyId);
    check(`${L}: ${table}`, !error && ownVisible && foreign.length === 0,
      error ? error.message : `${rows.length} rows, ${foreign.length} foreign`);
  }

  // profiles: strictly own row.
  {
    const { data, error } = await db.from('profiles').select('*');
    const rows = data ?? [];
    check(`${L}: profiles`, !error && rows.length === 1 && rows[0].id === self.userId,
      error ? error.message : `${rows.length} rows`);
  }

  // Conversation-scoped tables: every visible row must hang off an own-company
  // conversation (this tenant has exactly one).
  {
    const { data, error } = await db.from('messages').select('conversation_id');
    const rows = data ?? [];
    const foreign = rows.filter(r => r.conversation_id !== self.conversationId);
    check(`${L}: messages`, !error && rows.length >= 1 && foreign.length === 0,
      error ? error.message : `${rows.length} rows, ${foreign.length} foreign`);
  }
  {
    const { data, error } = await db.from('conversation_summaries').select('conversation_id');
    const rows = data ?? [];
    const foreign = rows.filter(r => r.conversation_id !== self.conversationId);
    check(`${L}: conversation_summaries`, !error && rows.length >= 1 && foreign.length === 0,
      error ? error.message : `${rows.length} rows, ${foreign.length} foreign`);
  }

  // Task-scoped join table.
  {
    const { data, error } = await db.from('task_dependencies').select('task_id');
    const rows = data ?? [];
    const foreign = rows.filter(r => !self.taskIds.includes(r.task_id));
    check(`${L}: task_dependencies`, !error && rows.length >= 1 && foreign.length === 0,
      error ? error.message : `${rows.length} rows, ${foreign.length} foreign`);
  }

  // Deny-all tables (not part of the 24): the two dispatch ledgers must be
  // invisible. Both are RLS-enabled with no policies and written only by a
  // system actor — dispatch_log by the external n8n workflow, notification_log
  // by the reminder cron. A tenant reading either would see every company's
  // send history, since neither is scoped by a policy.
  {
    const { data, error } = await db.from('dispatch_log').select('id');
    check(`${L}: dispatch_log deny-all (bonus)`, !error && (data ?? []).length === 0,
      error ? error.message : `${(data ?? []).length} rows`);
  }
  {
    const { data, error } = await db.from('notification_log').select('id');
    check(`${L}: notification_log deny-all (bonus)`, !error && (data ?? []).length === 0,
      error ? error.message : `${(data ?? []).length} rows`);
  }
}

async function runAdversarial(attacker, victim) {
  const db = attacker.client;

  // Attack 1: own-company task referencing the victim's job + worker. RLS
  // passes (company_id is the attacker's own) — the 0009 trigger must reject.
  {
    const { error } = await db.from('tasks').insert({
      company_id: attacker.companyId, job_id: victim.jobId,
      assignee_worker_id: victim.workerId, title: 'cross-tenant task', source: 'manager',
    });
    check('adversarial: task → foreign job/worker blocked', error?.code === '23514',
      error ? `code=${error.code}` : 'INSERT SUCCEEDED (leak!)');
    if (!error) await admin.from('tasks').delete().eq('company_id', attacker.companyId).eq('title', 'cross-tenant task');
  }

  // Attack 2: own-company proposal referencing the victim's conversation.
  {
    const { error } = await db.from('proposals').insert({
      company_id: attacker.companyId, conversation_id: victim.conversationId,
      action_name: 'noop', action_args: {}, rendered_text: 'cross-tenant proposal',
    });
    check('adversarial: proposal → foreign conversation blocked', error?.code === '23514',
      error ? `code=${error.code}` : 'INSERT SUCCEEDED (leak!)');
    if (!error) await admin.from('proposals').delete().eq('company_id', attacker.companyId).eq('rendered_text', 'cross-tenant proposal');
  }

  // Attack 3 (billing, 0011): a tenant must never be able to grant itself an
  // active subscription by writing subscription_status directly — the
  // column-level revoke should reject this with a permission error (42501),
  // not a policy check_violation (there's no row-level policy to fail; the
  // grant itself no longer exists for this column).
  {
    const { error } = await db.from('companies').update({ subscription_status: 'active' }).eq('id', attacker.companyId);
    check('adversarial: tenant self-upgrade of subscription_status blocked', error != null,
      error ? `code=${error.code}` : 'UPDATE SUCCEEDED (billing bypass!)');
  }

  // Attack 4 (translation undo, 0015): revert_translation_batch is SECURITY
  // DEFINER, so RLS does not protect it — its own auth.uid() clause is the
  // whole boundary. A leak here would let any tenant rewrite another tenant's
  // task titles back to arbitrary stored values, so assert BOTH that the call
  // errors and that the victim's row is untouched.
  {
    const { error } = await db.rpc('revert_translation_batch', { p_batch: victim.batchId });
    const { data: victimTask } = await admin.from('tasks').select('title').eq('id', victim.taskIds[0]).maybeSingle();
    const untouched = victimTask?.title !== victim.originalTitle;
    check('adversarial: revert of foreign translation batch blocked', error != null && untouched,
      error == null ? 'RPC SUCCEEDED (cross-tenant write!)' : !untouched ? 'victim row was reverted (leak!)' : `code=${error.code}`);
  }

  // Attack 5 (0015 grants): the snapshot undo replays must be immutable. A
  // tenant that could rewrite its own old_value could make "undo" restore
  // anything it liked — the column grant, not a policy, is what stops it.
  {
    const { error } = await db.from('translation_items').update({ old_value: 'tampered' }).eq('batch_id', attacker.batchId);
    check('adversarial: tenant rewrite of own translation snapshot blocked', error != null,
      error ? `code=${error.code}` : 'UPDATE SUCCEEDED (undo is forgeable!)');
  }

  // Attack 6 (0017): worker check-in answers must be unforgeable. The table is
  // readable by its tenant but has NO insert or update policy and no grant
  // beyond select — the only writer is the WhatsApp webhook on the service
  // role. A tenant that could write here could manufacture "the crew said they
  // finished", which is exactly what a later PRD will trust when deciding
  // whether a task is done. Assert BOTH directions: cannot insert a new answer,
  // cannot rewrite the one it can see.
  {
    const { error } = await db.from('worker_checkins').insert({
      company_id: attacker.companyId, worker_id: attacker.workerId,
      checkin_date: '2026-01-06', answer: 'done', task_ids: [],
    });
    check('adversarial: tenant INSERT of a check-in answer blocked', error != null,
      error ? `code=${error.code}` : 'INSERT SUCCEEDED (answers are forgeable!)');
    if (!error) {
      await admin.from('worker_checkins').delete()
        .eq('company_id', attacker.companyId).eq('checkin_date', '2026-01-06');
    }
  }
  {
    const { error } = await db.from('worker_checkins').update({ answer: 'done' })
      .eq('company_id', attacker.companyId);
    check('adversarial: tenant UPDATE of a check-in answer blocked', error != null,
      error ? `code=${error.code}` : 'UPDATE SUCCEEDED (answers are forgeable!)');
  }
}

// ── main ────────────────────────────────────────────────────────────────────
let tenantA, tenantB;
try {
  console.log(`Seeding two throwaway tenants (run ${run})…`);
  tenantA = await seedTenant('a');
  tenantB = await seedTenant('b');

  await runMatrix(tenantA, tenantB);
  await runMatrix(tenantB, tenantA);
  await runAdversarial(tenantA, tenantB);

  const matrixChecks = results.filter(r => !r.name.includes('bonus') && !r.name.startsWith('adversarial'));
  const adversarialChecks = results.filter(r => r.name.startsWith('adversarial'));
  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? ` — ${r.detail}` : ''}`);
  }
  console.log('');
  console.log(`Matrix: ${matrixChecks.filter(r => r.ok).length}/${matrixChecks.length} visibility checks passed; ` +
    `adversarial: ${adversarialChecks.filter(r => r.ok).length}/${adversarialChecks.length} blocked; failures: ${failures}`);
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  failures += 1;
} finally {
  console.log('\nCleaning up seeded tenants…');
  try { await cleanupTenant(tenantA); } catch (e) { console.error(`cleanup A: ${e.message}`); }
  try { await cleanupTenant(tenantB); } catch (e) { console.error(`cleanup B: ${e.message}`); }
}

process.exit(failures === 0 ? 0 : 1);
