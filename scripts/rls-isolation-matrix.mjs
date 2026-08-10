// RLS isolation matrix — the recurring tenant-boundary QA gate.
//
// Seeds TWO throwaway tenants (auth user + company + one row in every tenant
// table — plus a SECOND profile in each company, see below) PLUS a third
// throwaway actor: an authenticated user with a
// confirmed email and deliberately NO profiles row — Capo's real
// signup-before-onboarding state. Two tenants alone cannot exercise that
// actor's failure mode (every ordinary attacker has a company); it is the
// only way to catch a tenant guard that fails open when
// private.current_company_id() returns NULL. Then, authenticated as each
// tenant user in turn, verifies the visibility matrix: for each RLS-covered
// relation × 2 tenants, the caller sees its own seeded row and nothing from
// the other tenant. Then runs the adversarial cross-tenant attacks and
// expects every one to be rejected. Everything seeded is deleted afterwards.
// The totals are printed at the end rather than asserted against a
// hardcoded count, because both grow as tables are added.
//
// The adversarial set covers, in order: the two migration-0009 FK triggers
// (own-company task pointing at the other company's job/worker; own-company
// proposal pointing at the other company's conversation), the 0011 billing
// column revoke, the 0015 revert_translation_batch RPC, the 0017
// worker_checkins answers a tenant must not be able to forge or rewrite, the
// two 0018 task-review RPCs plus that table's absent INSERT/UPDATE grants,
// the 0022 notifications table (no INSERT grant, read_at-only UPDATE grant,
// and its two-predicate policy — company AND profile),
// and — run separately, as the no-profiles-row actor — those same two RPCs
// again against a real tenant's task/review, plus revert_translation_batch
// against a real tenant's batch.
//
// notifications is the first relation in this repo scoped per PROFILE and not
// only per company, which is why seedTenant now creates a COLLEAGUE — a
// second profile in the same company. Without one, a policy that dropped
// `profile_id = auth.uid()` entirely would still report green here: the owner
// would be the only recipient in their company, so company scoping alone
// would look indistinguishable from correct. Same shape of blind spot as the
// no-profiles-row actor above, one level down.
//
// The SECURITY DEFINER ones matter more than they look: RLS does NOT cover
// them, so their internal auth.uid() checks are the entire tenant boundary —
// which is exactly what the no-profiles-row actor is seeded to probe. Two
// ordinary tenants structurally cannot: every ordinary attacker has a
// company, so private.current_company_id() never returns NULL for them, and
// a guard that fails open only on NULL stays invisible. That is not
// hypothetical twice over: open_task_review (fixed in 0019) and
// revert_translation_batch (fixed in 0021, and confirmed exploitable against
// production before the fix) both shipped with exactly that hole while this
// matrix reported green.
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

  // A SECOND manager in the same company, and the ONLY reason this matrix
  // needs one: notifications (0022) is scoped per profile as well as per
  // company. Every other tenant table is company-scoped, where a colleague is
  // indistinguishable from the owner — which is exactly why one was never
  // needed before, and why a per-profile policy would be untestable without
  // one. Seeded BEFORE open_task_review below, because the notification
  // fan-out reads the profiles that exist at the moment the review is filed.
  const colleagueEmail = `rls-matrix-${label}-mate-${run}@example.com`;
  const { data: colleagueData, error: colleagueErr } = await admin.auth.admin.createUser({
    email: colleagueEmail,
    password: randomBytes(16).toString('hex'),
    email_confirm: true,
    user_metadata: { rls_matrix_run: run },
  });
  if (colleagueErr) throw new Error(`createUser(${label}-mate): ${colleagueErr.message}`);
  const colleagueId = colleagueData.user.id;
  await must(
    admin.from('profiles').insert({
      id: colleagueId, company_id: companyId, full_name: `Matrix ${label} mate`,
      phone: `+35192${randomInt(1000000, 9999999)}`,
    }).select().single(),
    `profile(${label}-mate)`,
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

  // A live completion claim on task1, so the visibility matrix and the two
  // adversarial RPC attacks below all have a real row to act on. Seeded
  // through the RPC rather than a raw insert, so the seed exercises the same
  // path the app does — and so task1 genuinely lands in 'pending_review',
  // which incidentally proves the new status survives the whole matrix.
  const reviewId = await must(
    admin.rpc('open_task_review', {
      p_task: task1.id,
      p_worker: worker.id,
      p_note: `seed note ${label} ${run}`,
    }),
    `task_review(${label})`,
  );

  // The notifications that review just produced, via the 0022 trigger. Read
  // back rather than inserted: this IS the producer assertion — PRD 6 requires
  // a pending review to notify EVERY manager of the company, and the throw
  // below is what fails loudly if the fan-out ever reaches only the actor, or
  // only one profile, or nobody. auth.uid() is null here (service role), so
  // the "never notify the actor" clause excludes no one and both profiles must
  // be present.
  const notifications = await must(
    admin.from('notifications').select('id, profile_id').eq('company_id', companyId),
    `notifications(${label})`,
  );
  const ownNotificationId = notifications.find(n => n.profile_id === userId)?.id;
  const colleagueNotificationId = notifications.find(n => n.profile_id === colleagueId)?.id;
  if (!ownNotificationId || !colleagueNotificationId) {
    throw new Error(
      `notifications(${label}): the review fan-out produced ${notifications.length} row(s); expected one per profile in the company`,
    );
  }

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
    conversationId: conversation.id, batchId: batch.id, originalTitle, reviewId,
    colleagueId, ownNotificationId, colleagueNotificationId,
  };
}

// A third actor, deliberately thinner than seedTenant: an authenticated user
// with a confirmed email and NO profiles row — Capo's real
// signup-before-onboarding state (apps/web/app/(public)/registar/actions.ts;
// signup and onboarding are separate steps, and the profiles row is written
// only by complete_onboarding). private.current_company_id() returns NULL for
// this user, and that NULL has now made the SAME guard fail OPEN twice:
//
//   open_task_review        — `v_company <> NULL` is NULL, fixed in 0019.
//   revert_translation_batch — the original of that pattern, which
//                              open_task_review was copied from. Fixed in 0021,
//                              and confirmed exploitable against production
//                              first: the RPC did not error, it returned
//                              {"reverted": 1} and looked like a success.
//
// Three-valued logic in both cases: `x <> NULL` is NULL, `true and NULL` is
// NULL, and `if NULL` does not fire, so the guard is skipped entirely.
//
// No ordinary two-tenant attack can reach that path. Every ordinary attacker
// has a company, so the comparison always yields a real boolean for them and
// the guard fires correctly — which is precisely why both bugs survived a green
// matrix. The class of defect needs this third actor.
async function seedOrphanUser() {
  const email = `rls-matrix-orphan-${run}@example.com`;
  const password = randomBytes(16).toString('hex');

  const { data: userData, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { rls_matrix_run: run },
  });
  if (userErr) throw new Error(`createUser(orphan): ${userErr.message}`);
  const userId = userData.user.id;

  const client = createClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false },
  });
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(`signIn(orphan): ${signInErr.message}`);

  return { userId, client };
}

async function cleanupOrphanUser(o) {
  if (!o) return;
  // No company, no profile, no seeded rows — just the auth user.
  await admin.auth.admin.deleteUser(o.userId);
}

async function cleanupTenant(t) {
  if (!t) return;
  // Reverse dependency order; every delete is scoped to this run's rows only.
  const companyEq = (q) => q.eq('company_id', t.companyId);
  // Before profiles: notifications.profile_id is a FK (on delete cascade, but
  // the delete is explicit here so a leftover row is never mistaken for one
  // the app wrote).
  await companyEq(admin.from('notifications').delete());
  await companyEq(admin.from('translation_items').delete());
  await companyEq(admin.from('translation_batches').delete());
  await companyEq(admin.from('proposals').delete());
  await admin.from('conversation_summaries').delete().eq('conversation_id', t.conversationId);
  await admin.from('messages').delete().eq('conversation_id', t.conversationId);
  await companyEq(admin.from('task_reviews').delete());
  await admin.from('task_dependencies').delete().in('task_id', t.taskIds);
  await companyEq(admin.from('tasks').delete());
  await companyEq(admin.from('memories').delete());
  await companyEq(admin.from('transcription_vocab').delete());
  await companyEq(admin.from('conversations').delete());
  // Before workers: worker_checkins.worker_id is a FK.
  await companyEq(admin.from('worker_checkins').delete());
  await companyEq(admin.from('workers').delete());
  await companyEq(admin.from('jobs').delete());
  await companyEq(admin.from('profiles').delete());
  await admin.from('companies').delete().eq('id', t.companyId);
  await admin.auth.admin.deleteUser(t.userId);
  if (t.colleagueId) await admin.auth.admin.deleteUser(t.colleagueId);
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
  for (const table of ['companies', 'workers', 'jobs', 'tasks', 'memories', 'conversations', 'proposals', 'transcription_vocab', 'task_board', 'translation_batches', 'translation_items', 'task_reviews', 'worker_checkins']) {
    const { data, error } = await db.from(table).select('*');
    const rows = data ?? [];
    const ownKey = table === 'companies' ? 'id' : 'company_id';
    const foreign = rows.filter(r => r[ownKey] !== self.companyId);
    const ownVisible = rows.some(r => r[ownKey] === self.companyId);
    check(`${L}: ${table}`, !error && ownVisible && foreign.length === 0,
      error ? error.message : `${rows.length} rows, ${foreign.length} foreign`);
  }

  // profiles: strictly own row — still one, even though this company now has
  // two profiles. profiles_select_own is `id = auth.uid()`, not company-scoped.
  {
    const { data, error } = await db.from('profiles').select('*');
    const rows = data ?? [];
    check(`${L}: profiles`, !error && rows.length === 1 && rows[0].id === self.userId,
      error ? error.message : `${rows.length} rows`);
  }

  // notifications (0022): company AND profile, checked separately rather than
  // in the loop above. The seeded review fanned out TWO rows in this company —
  // one for this user, one for their colleague — so `foreignProfile` is the
  // assertion the generic loop structurally cannot make: a policy missing its
  // `profile_id = auth.uid()` clause returns both rows, every one of them with
  // the right company_id.
  {
    const { data, error } = await db.from('notifications').select('*');
    const rows = data ?? [];
    const foreignCompany = rows.filter(r => r.company_id !== self.companyId);
    const foreignProfile = rows.filter(r => r.profile_id !== self.userId);
    check(`${L}: notifications`,
      !error && rows.length === 1 && foreignCompany.length === 0 && foreignProfile.length === 0,
      error ? error.message : `${rows.length} rows, ${foreignCompany.length} foreign company, ${foreignProfile.length} foreign profile`);
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
  // Attack 7 (0017): and the same tenant cannot rewrite the answer it CAN see.
  {
    const { error } = await db.from('worker_checkins').update({ answer: 'done' })
      .eq('company_id', attacker.companyId);
    check('adversarial: tenant UPDATE of a check-in answer blocked', error != null,
      error ? `code=${error.code}` : 'UPDATE SUCCEEDED (answers are forgeable!)');
  }

  // Attack 8 (review resolution): resolve_task_review is SECURITY DEFINER, so
  // RLS does NOT cover it — its internal auth.uid() check is the whole tenant
  // boundary. Same class of risk as revert_translation_batch, and a successful
  // attack here would let one tenant mark another tenant's work done.
  {
    const { error } = await db.rpc('resolve_task_review', {
      p_review: victim.reviewId,
      p_resolution: 'approved',
    });
    const { data: after } = await admin
      .from('task_reviews')
      .select('status')
      .eq('id', victim.reviewId)
      .single();
    const untouched = after?.status === 'pending';
    check(
      'adversarial: resolve of foreign task review blocked',
      error != null && untouched,
      error ? `rejected (${error.code ?? 'err'}), victim review still ${after?.status}` : 'ACCEPTED — boundary broken',
    );
  }

  // Attack 9 (review creation): open_task_review is likewise SECURITY DEFINER.
  // Filing a claim on a foreign task would flip that task to pending_review —
  // a cross-tenant WRITE to the tasks table.
  //
  // taskIds[1], NOT taskIds[0]: the seed already put a pending review on
  // task1, so aiming there would trip task_reviews_one_pending_idx and the
  // check would pass for the wrong reason — refused as a duplicate rather than
  // as another tenant's. Same trap the translation-batch seed comment calls
  // out. task2 has no review, so the tenant boundary is the only thing that
  // can stop this.
  {
    const foreignTask = victim.taskIds[1];
    const { error } = await db.rpc('open_task_review', {
      p_task: foreignTask,
      p_worker: null,
      p_note: 'cross-tenant claim',
    });
    const { data: after } = await admin.from('tasks').select('status').eq('id', foreignTask).single();
    check(
      'adversarial: open review on foreign task blocked',
      error != null && after?.status === 'pending',
      error ? `rejected (${error.code ?? 'err'}), victim task still ${after?.status}` : 'ACCEPTED — boundary broken',
    );
  }

  // Attack 10 (grant layer): task_reviews has NO update grant for authenticated,
  // so a tenant cannot resolve its OWN review by hand and strand the task open.
  {
    const { error } = await db
      .from('task_reviews')
      .update({ status: 'approved' })
      .eq('id', attacker.reviewId);
    check(
      'adversarial: direct update of own task review blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — update grant leaked',
    );
  }

  // Attack 11 (grant layer): task_reviews has NO insert grant for authenticated
  // either (0019, M6) — every write goes through the two RPCs above. Scoped to
  // the attacker's OWN company/task (not cross-tenant) because this is a
  // grant-layer check, not a boundary check: even a well-formed, same-tenant
  // direct insert must fail, or a tenant could create a task_reviews row that
  // never flips its task to 'pending_review' — breaking the "a review exists
  // => the task is in review" invariant Tasks 4-5 depend on. taskIds[1], same
  // reasoning as attack 7: task1 already has a pending review, and aiming
  // there would risk tripping task_reviews_one_pending_idx instead of the
  // grant revoke.
  {
    const { error } = await db
      .from('task_reviews')
      .insert({ company_id: attacker.companyId, task_id: attacker.taskIds[1], declared_by_worker_id: attacker.workerId });
    check(
      'adversarial: direct insert into task_reviews blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — insert grant leaked',
    );
  }

  // ── 0022 notifications ─────────────────────────────────────────────────
  // Attack 12 (grant layer): no INSERT grant for authenticated. Every row is
  // written by the triggers, so a tenant cannot manufacture a notification —
  // which would otherwise be a way to put attacker-chosen text in front of a
  // COLLEAGUE under the app's own chrome, inside the app's own inbox. Scoped
  // to the attacker's own company and own profile, so only the grant can
  // reject it.
  {
    const { error } = await db.from('notifications').insert({
      company_id: attacker.companyId, profile_id: attacker.userId,
      kind: 'review_pending', title: 'forged',
    });
    check(
      'adversarial: direct insert into notifications blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — insert grant leaked',
    );
  }

  // Attack 13 (grant layer): the UPDATE grant is `(read_at)` only. The policy
  // alone would happily pass this — it is the attacker's own row, in their own
  // company — so this is purely a column-grant check. If it leaks, a manager
  // reads notification text their own browser chose.
  {
    const { error } = await db
      .from('notifications')
      .update({ title: 'tampered' })
      .eq('id', attacker.ownNotificationId);
    check(
      'adversarial: update of a non-read_at notification column blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — column grant leaked',
    );
  }

  // Attack 14 (policy, same company): marking a COLLEAGUE's notification read.
  // The one attack in this file that is not cross-tenant — it is same-tenant,
  // cross-PROFILE, and it is the whole reason the colleague exists. A
  // company-only policy would let whichever manager opened the app first clear
  // everyone else's badge, silently.
  //
  // Asserting on `error` would be wrong here: RLS filters rows, it does not
  // raise. A blocked UPDATE matches zero rows and returns no error at all, so
  // the row's own state is the only truthful signal.
  {
    const { error } = await db
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', attacker.colleagueNotificationId);
    const { data: after } = await admin
      .from('notifications').select('read_at').eq('id', attacker.colleagueNotificationId).single();
    check(
      "adversarial: marking a colleague's notification read blocked",
      after?.read_at === null,
      after?.read_at === null
        ? `no row matched${error ? ` (${error.code ?? 'err'})` : ''}`
        : 'ACCEPTED — per-profile scoping broken',
    );
  }

  // Attack 15 (policy, cross-tenant): the same write against the OTHER
  // company's manager. Weaker than attack 14 — company scoping alone stops
  // this one — but it is the boundary every other row in this matrix asserts,
  // and leaving it out would make notifications the only tenant table with no
  // cross-tenant check of its own.
  {
    const { error } = await db
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', victim.ownNotificationId);
    const { data: after } = await admin
      .from('notifications').select('read_at').eq('id', victim.ownNotificationId).single();
    check(
      "adversarial: marking a foreign tenant's notification read blocked",
      after?.read_at === null,
      after?.read_at === null
        ? `no row matched${error ? ` (${error.code ?? 'err'})` : ''}`
        : 'ACCEPTED — boundary broken',
    );
  }
}

// A third actor's attacks: an authenticated user with a confirmed email and
// NO profiles row (see seedOrphanUser above). Two ordinary tenants cannot
// exercise this path — every ordinary attacker has a company, so
// private.current_company_id() never returns NULL for them. This is the
// actor that would have caught the fail-open bug fix round 1 found in
// open_task_review (0019): before that fix, `v_company <> NULL` evaluated to
// NULL under three-valued logic, the guard silently did not fire, and this
// exact user could write to any tenant's tasks/task_reviews. Attack 18 is the
// same defect in revert_translation_batch, which is where open_task_review
// inherited it from.
//
// Runs LAST on purpose. If a boundary is broken these calls genuinely mutate
// the victim's rows, and every earlier check has already read the state it
// needed by then — so a failure here reports one clean defect instead of
// cascading into unrelated noise.
async function runOrphanAttack(orphan, victim) {
  const db = orphan.client;

  // Attack 16: filing a claim on a real tenant's real task. Targets
  // taskIds[1] for the same reason as attack 9 — task1 already carries the
  // seeded pending review, so aiming there would risk tripping
  // task_reviews_one_pending_idx instead of exercising the tenant guard.
  {
    const foreignTask = victim.taskIds[1];
    const { error } = await db.rpc('open_task_review', {
      p_task: foreignTask,
      p_worker: null,
      p_note: 'orphan claim, no profiles row',
    });
    const { data: after } = await admin.from('tasks').select('status').eq('id', foreignTask).single();
    check(
      'adversarial: orphan (no profiles row) open_task_review blocked',
      error != null && after?.status === 'pending',
      error ? `rejected (${error.code ?? 'err'}), victim task still ${after?.status}` : 'ACCEPTED — boundary broken',
    );
  }

  // Attack 17: resolving a real tenant's real review. Note this one was
  // already safe even before the 0019 fix — the guard lives inside the
  // UPDATE's WHERE clause (`company_id = private.current_company_id()`),
  // and `real_uuid = NULL` is NULL, which WHERE treats as no match, not as
  // true. It is included anyway so this actor's coverage of both RPCs is
  // complete and the asymmetry between the two guards is visible in the
  // output rather than assumed.
  {
    const { error } = await db.rpc('resolve_task_review', {
      p_review: victim.reviewId,
      p_resolution: 'approved',
    });
    const { data: after } = await admin
      .from('task_reviews')
      .select('status')
      .eq('id', victim.reviewId)
      .single();
    check(
      'adversarial: orphan (no profiles row) resolve_task_review blocked',
      error != null && after?.status === 'pending',
      error ? `rejected (${error.code ?? 'err'}), victim review still ${after?.status}` : 'ACCEPTED — boundary broken',
    );
  }

  // Attack 18 (0015 + 0021): revert_translation_batch is SECURITY DEFINER, so
  // RLS does not cover it and its auth.uid() clause is the entire tenant
  // boundary. Before 0021 that clause used `<>`, which three-valued logic
  // turned into a no-op for exactly this caller — the RPC did not merely allow
  // the write, it returned {"reverted": 1} and looked like a success.
  //
  // Asserting on the error alone would therefore be weak: assert the victim's
  // row too. The seeded batch is 'completed' with one 'applied' item whose
  // old_value is victim.originalTitle, so a leak is directly observable as the
  // victim's task title reverting to that string.
  //
  // Note the batch's other side-effect (companies.language back to from_locale)
  // is NOT assertable here: companies.language defaults to 'pt-PT' (0014) and
  // the seeded batch is pt-PT → en-US, so that UPDATE's `and language =
  // to_locale` guard never matches a seeded company. A check on it could not
  // fail, which is worse than no check.
  {
    const { error } = await db.rpc('revert_translation_batch', { p_batch: victim.batchId });
    const { data: victimTask } = await admin
      .from('tasks').select('title').eq('id', victim.taskIds[0]).maybeSingle();
    const untouched = victimTask?.title !== victim.originalTitle;
    check(
      'adversarial: orphan (no profiles row) revert of foreign batch blocked',
      error != null && untouched,
      error == null
        ? 'RPC SUCCEEDED (cross-tenant write!)'
        : !untouched
          ? 'victim task title was reverted (leak!)'
          : `rejected (${error.code ?? 'err'})`,
    );
  }
}

// ── main ────────────────────────────────────────────────────────────────────
let tenantA, tenantB, orphan;
try {
  console.log(`Seeding two throwaway tenants (run ${run})…`);
  tenantA = await seedTenant('a');
  tenantB = await seedTenant('b');
  console.log('Seeding the third actor (confirmed email, no profiles row)…');
  orphan = await seedOrphanUser();

  await runMatrix(tenantA, tenantB);
  await runMatrix(tenantB, tenantA);
  await runAdversarial(tenantA, tenantB);
  await runOrphanAttack(orphan, tenantB);

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
  try { await cleanupOrphanUser(orphan); } catch (e) { console.error(`cleanup orphan: ${e.message}`); }
}

process.exit(failures === 0 ? 0 : 1);
