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
// the 0023 STORAGE surface (see below), the 0024 notifications table (no
// INSERT grant, read_at-only UPDATE grant, and its two-predicate policy —
// company AND profile), the 0026 push_subscriptions table (the same
// two-predicate policy, no UPDATE grant at all, and the schema's first
// DELETE policy — attacked directly rather than riding on SELECT being
// right), and — run separately, as the no-profiles-row actor — those same
// two RPCs again against a real tenant's task/review, plus
// revert_translation_batch against a real tenant's batch, plus signing and
// downloading a real tenant's photo.
//
// 0027 adds the restricted worker agent's own thread — worker_conversations and
// worker_messages — and with it the one check in this file that is not about
// tenant isolation at all. checkWorkerTextIsolation asks whether worker-authored
// text ever lands in a table the MANAGER'S AGENT reads: `messages` (whose last
// three user rows ARE the write guard's evidence pool), conversation_summaries,
// memories and proposals. A worker able to write into any of them would not be
// persuading the manager's agent of anything — they would be authoring the quote
// that authorizes a direct manager-level write. That claim cannot be checked by
// a visibility matrix, so it is checked by a service-role sweep for a seeded
// tracer string, with a positive control so an empty sweep cannot pass for the
// wrong reason.
//
// 0023 is the first surface here that is not only Postgres. task_photos is an
// ordinary RLS table and rides in the visibility matrix like any other, but
// the PHOTOS THEMSELVES live in Storage, behind policies on storage.objects
// that a different service consults over a different endpoint. Table checks
// say nothing about the bytes. Attacks 12-18 therefore aim at the bytes and at
// the seam between the two: minting a signed URL for another tenant's object
// (a signed URL is a bearer token — a leak there is a leak the attacker can
// hand out), reading and listing without one, WRITING into a foreign folder,
// filing an own-company row that points at a foreign object, forging
// worker attribution past the column-scoped INSERT grant, and rewriting or
// deleting evidence the tenant owns.
//
// notifications (0024) is the first relation in this repo scoped per PROFILE
// and not only per company, which is why seedTenant now creates a COLLEAGUE — a
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

// The smallest thing the seed can put in the task-photos bucket that is
// honestly a JPEG: SOI, an empty APP0/JFIF segment, and EOI. It has to START
// with FF D8 FF because apps/web/lib/task-photos.ts sniffs magic bytes rather
// than trusting the declared mime — a buffer of zeroes would be accepted by
// Storage (which only checks the declared content-type against the bucket's
// allowed_mime_types) but would make this seed diverge from what the app path
// can actually produce.
const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

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
  // needs one: notifications (0024) is scoped per profile as well as per
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

  // Two push_subscriptions registrations per tenant (0026): the owner's and
  // the COLLEAGUE's. The colleague's is what proves per-profile scoping —
  // with only one row per company, a policy that dropped
  // `profile_id = auth.uid()` would still report green here, exactly as it
  // would for notifications.
  //
  // Seeded HERE, immediately after the colleague's profile, rather than
  // after the ~19 rows and the task-photos storage upload that follow — on
  // purpose, and not where the original draft of this block lived. It needs
  // only companyId, userId and colleagueId, all already in scope. If
  // push_subscriptions does not exist yet (this matrix run ahead of
  // migration 0026), `must` throws here and seedTenant never reaches the
  // storage upload below — so the run aborts having leaked a company and two
  // profiles instead of a full tenant plus a bucket object. The bucket
  // object is the one seeded artefact cleanupTenant cannot reach unless
  // photoPath was actually set (see the comment there), so keeping this
  // block ahead of it is what keeps a missing-migration abort cheap.
  const pushEndpoint = `https://push.example/${label}-owner-${randomBytes(16).toString('hex')}`;
  const colleaguePushEndpoint = `https://push.example/${label}-colleague-${randomBytes(16).toString('hex')}`;
  await must(
    admin.from('push_subscriptions').insert([
      { company_id: companyId, profile_id: userId, endpoint: pushEndpoint, p256dh: 'k', auth: 'a' },
      { company_id: companyId, profile_id: colleagueId, endpoint: colleaguePushEndpoint, p256dh: 'k', auth: 'a' },
    ]).select(),
    `push_subscriptions(${label})`,
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

  // The restricted worker agent's OWN thread (0027). Written as the service
  // role, which is the only writer in production too — the WhatsApp webhook —
  // so the adversarial pass below can assert that a tenant can neither forge a
  // worker's words nor rewrite them after the fact.
  //
  // `workerSecret` is the tracer for the CENTRAL CLAIM of PRD 4: this exact
  // string must appear in worker_messages and NOWHERE ELSE. checkWorkerTextIsolation
  // sweeps the manager's own tables for it on the SERVICE ROLE, which is the
  // only way to ask the question honestly — an RLS-scoped read that found
  // nothing would prove only that RLS works, not that the text was never
  // written there.
  const workerSecret = `WORKER-TRACER-${label}-${run}`;
  const workerConversation = await must(
    admin.from('worker_conversations').insert({ company_id: companyId, worker_id: worker.id }).select().single(),
    `worker_conversation(${label})`,
  );
  const workerMessage = await must(
    admin.from('worker_messages').insert({
      conversation_id: workerConversation.id, company_id: companyId, role: 'user',
      content: { parts: [{ type: 'text', text: workerSecret }] },
      photo_count: 2,
    }).select().single(),
    `worker_message(${label})`,
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

  // The notifications that review just produced, via the 0024 trigger. Read
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

  // A real object in the task-photos bucket, plus the task_photos row that
  // points at it (0023). Both are needed: the row is what the visibility
  // matrix reads, and the OBJECT is what the storage.objects policies guard —
  // and those two boundaries are enforced by completely different machinery
  // (Postgres RLS on a public table vs. RLS on storage.objects, consulted by
  // the Storage API when it mints or honours a signed URL). A check that only
  // exercised the table would leave the entire new surface untested.
  //
  // Uploaded on the service role, which bypasses storage RLS — the same way
  // the seed writes every other table. `source: 'worker'` is set here on
  // purpose: it is the value a TENANT must never be able to write (the
  // column-scoped INSERT grant omits it), so the seed proves the column
  // exists and is writable by the system while the adversarial pass proves it
  // is not writable by a manager.
  const photoPath = `${companyId}/${task1.id}/${randomBytes(16).toString('hex')}.jpg`;
  const { error: uploadErr } = await admin.storage
    .from('task-photos')
    .upload(photoPath, JPEG_BYTES, { contentType: 'image/jpeg', upsert: false });
  if (uploadErr) throw new Error(`task_photo_object(${label}): ${uploadErr.message}`);
  await must(
    admin.from('task_photos').insert({
      company_id: companyId, task_id: task1.id, storage_path: photoPath,
      source: 'worker', worker_id: worker.id,
      mime: 'image/jpeg', byte_size: JPEG_BYTES.length,
    }).select(),
    `task_photo(${label})`,
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
    photoPath,
    colleagueId, ownNotificationId, colleagueNotificationId,
    pushEndpoint, colleaguePushEndpoint,
    workerConversationId: workerConversation.id, workerMessageId: workerMessage.id, workerSecret,
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
  // The bucket object first: it is the one seeded artefact that does NOT live
  // in Postgres, so no cascade or FK ordering reaches it. Forgetting this
  // leaves a file behind on every run — invisible, since nothing lists the
  // bucket, and cumulative.
  if (t.photoPath) {
    const { error } = await admin.storage.from('task-photos').remove([t.photoPath]);
    if (error) console.error(`cleanup object(${t.label}): ${error.message}`);
  }
  // Reverse dependency order; every delete is scoped to this run's rows only.
  const companyEq = (q) => q.eq('company_id', t.companyId);
  await companyEq(admin.from('task_photos').delete());
  // Before profiles: notifications.profile_id and push_subscriptions.profile_id
  // are both FKs (on delete cascade, but the deletes are explicit here so a
  // leftover row is never mistaken for one the app wrote).
  await companyEq(admin.from('notifications').delete());
  await companyEq(admin.from('push_subscriptions').delete());
  await companyEq(admin.from('translation_items').delete());
  await companyEq(admin.from('translation_batches').delete());
  await companyEq(admin.from('proposals').delete());
  await admin.from('conversation_summaries').delete().eq('conversation_id', t.conversationId);
  await admin.from('messages').delete().eq('conversation_id', t.conversationId);
  // Before workers and before worker_checkins: worker_messages.checkin_id and
  // worker_conversations.worker_id are both FKs.
  await companyEq(admin.from('worker_messages').delete());
  await companyEq(admin.from('worker_conversations').delete());
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
  //
  // notifications and push_subscriptions are NOT in this array on purpose —
  // both are scoped per PROFILE as well as per company, and this loop's
  // `foreign = rows.filter(r => r[ownKey] !== self.companyId)` only ever
  // compares company_id. A policy missing its `profile_id = auth.uid()`
  // clause would still return only rows whose company_id is the caller's
  // own, so this check would report green on that exact regression. Both
  // tables get their own dedicated block below instead, asserting on
  // profile_id too. Read those before adding another per-profile table here.
  for (const table of ['companies', 'workers', 'jobs', 'tasks', 'memories', 'conversations', 'proposals', 'transcription_vocab', 'task_board', 'translation_batches', 'translation_items', 'task_reviews', 'worker_checkins', 'task_photos', 'worker_conversations', 'worker_messages']) {
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

  // notifications (0024): company AND profile, checked separately rather than
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

  // push_subscriptions (0026): company AND profile, same shape as
  // notifications above and checked the same way rather than folded into the
  // generic per-company loop. The seed put TWO rows in this company — the
  // owner's and the colleague's — so `foreignProfile` is the assertion the
  // generic loop structurally cannot make: a policy missing its
  // `profile_id = auth.uid()` clause returns both rows, every one of them
  // with the right company_id, and the generic loop's company-only check
  // would report green.
  {
    const { data, error } = await db.from('push_subscriptions').select('*');
    const rows = data ?? [];
    const foreignCompany = rows.filter(r => r.company_id !== self.companyId);
    const foreignProfile = rows.filter(r => r.profile_id !== self.userId);
    check(`${L}: push_subscriptions`,
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

  // ── 0023: Supabase Storage ───────────────────────────────────────────────
  // The first storage surface in this project, and the reason this section is
  // longer than it looks like it needs to be: photos are guarded by TWO
  // independent mechanisms that can fail independently. The task_photos table
  // is ordinary Postgres RLS (covered by the visibility matrix above). The
  // BYTES are guarded by policies on storage.objects, consulted by the Storage
  // API — a different service, reached over a different endpoint, which the
  // visibility matrix never touches. Every attack below aims at the bytes or
  // at the seam between the two.

  // Attack 12: mint a signed URL for the victim's photo. This is the one that
  // matters most, because a signed URL is a BEARER TOKEN: it works for anyone
  // who holds it, with no session at all. Minting one for a foreign object
  // would not merely be a read, it would be a read the attacker can hand out.
  {
    const { data, error } = await db.storage.from('task-photos').createSignedUrl(victim.photoPath, 60);
    check(
      'adversarial: signed URL for foreign task photo blocked',
      error != null && !data?.signedUrl,
      error ? `rejected (${error.message})` : 'SIGNED — the URL works for anyone who holds it',
    );
  }

  // Attack 13: skip the signature and read the object straight off the
  // authenticated endpoint. Distinct from attack 12 — a policy could
  // conceivably guard the signing path and not the direct one.
  {
    const { data, error } = await db.storage.from('task-photos').download(victim.photoPath);
    check(
      'adversarial: direct download of foreign task photo blocked',
      error != null && data == null,
      error ? `rejected (${error.message})` : 'DOWNLOADED — raw object readable cross-tenant',
    );
  }

  // Attack 14: enumerate the victim's folder. Even with the bytes unreadable,
  // a listing leaks how much work another company is documenting, and the
  // object keys contain their company and task uuids.
  {
    const { data, error } = await db.storage.from('task-photos').list(victim.companyId);
    check(
      'adversarial: listing a foreign company folder blocked',
      !error && (data ?? []).length === 0,
      error ? error.message : `${(data ?? []).length} objects listed (leak!)`,
    );
  }

  // Attack 15: WRITE into the victim's folder. The storage.objects INSERT
  // policy compares path segment 1 against private.current_company_id(), so
  // this is the check that the boundary is not read-only theatre. A tenant
  // that could plant objects in another company's folder could put anything
  // in front of that manager's eyes on their own task detail screen.
  {
    const path = `${victim.companyId}/${victim.taskIds[0]}/${randomBytes(16).toString('hex')}.jpg`;
    const { error } = await db.storage
      .from('task-photos')
      .upload(path, JPEG_BYTES, { contentType: 'image/jpeg', upsert: false });
    check(
      'adversarial: upload into a foreign company folder blocked',
      error != null,
      error ? `rejected (${error.message})` : 'UPLOADED — foreign folder is writable!',
    );
    if (!error) await admin.storage.from('task-photos').remove([path]);
  }

  // Attack 16: the seam. company_id is honest (the attacker's own, so RLS
  // passes) but storage_path names the VICTIM's folder — a record that would
  // render another company's photo on the attacker's own task detail screen,
  // since the screen signs whatever path the row carries. Nothing in RLS
  // catches this; the task_photos_path_scoped CHECK is the only thing that
  // does, which is exactly why it is a constraint and not app-side validation.
  {
    const { error } = await db.from('task_photos').insert({
      company_id: attacker.companyId,
      task_id: attacker.taskIds[1],
      storage_path: victim.photoPath,
      mime: 'image/jpeg',
      byte_size: JPEG_BYTES.length,
    });
    check(
      'adversarial: task_photos row pointing at a foreign object blocked',
      error?.code === '23514',
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — path scoping is not enforced',
    );
  }

  // Attack 17 (grant layer): forging attribution. `source` and `worker_id` are
  // absent from task_photos' column-scoped INSERT grant, so a manager cannot
  // manufacture "the crew sent proof of this" — the same forgery class
  // worker_checkins is locked down against (attacks 6-7). Own company on
  // purpose: this is a grant check, not a boundary check, so even a
  // well-formed same-tenant write must be refused.
  {
    const path = `${attacker.companyId}/${attacker.taskIds[1]}/${randomBytes(16).toString('hex')}.jpg`;
    const { error } = await db.from('task_photos').insert({
      company_id: attacker.companyId,
      task_id: attacker.taskIds[1],
      storage_path: path,
      source: 'worker',
      worker_id: attacker.workerId,
      mime: 'image/jpeg',
      byte_size: JPEG_BYTES.length,
    });
    check(
      'adversarial: tenant forging a worker-attributed photo blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — attribution is forgeable!',
    );
    if (!error) await admin.from('task_photos').delete().eq('storage_path', path);
  }

  // Attack 18 (grant layer): evidence a tenant can rewrite or delete is not
  // evidence. task_photos has SELECT and a column-scoped INSERT and nothing
  // else — no UPDATE policy, no DELETE policy, and no grant for either.
  {
    const { error: updateError } = await db
      .from('task_photos')
      .update({ storage_path: 'tampered' })
      .eq('company_id', attacker.companyId);
    check(
      'adversarial: tenant UPDATE of its own task photo blocked',
      updateError != null,
      updateError ? `rejected (${updateError.code ?? 'err'})` : 'ACCEPTED — update grant leaked',
    );
    const { error: deleteError } = await db
      .from('task_photos')
      .delete()
      .eq('company_id', attacker.companyId);
    check(
      'adversarial: tenant DELETE of its own task photo blocked',
      deleteError != null,
      deleteError ? `rejected (${deleteError.code ?? 'err'})` : 'ACCEPTED — delete grant leaked',
    );
  }

  // ── 0024 notifications ─────────────────────────────────────────────────
  // Attack 19 (grant layer): no INSERT grant for authenticated. Every row is
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

  // Attack 20 (grant layer): the UPDATE grant is `(read_at)` only. The policy
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

  // Attack 21 (policy, same company): marking a COLLEAGUE's notification read.
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

  // Attack 22 (policy, cross-tenant): the same write against the OTHER
  // company's manager. Weaker than attack 21 — company scoping alone stops
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

  // ── 0026 push_subscriptions ──────────────────────────────────────────────
  // The endpoint IS a capability: anyone holding one can ask the push service
  // to buzz that device. And this is the first table in the schema a tenant
  // can DELETE from, so the delete policy earns its own attacks rather than
  // riding on the select policy being right.

  // Attack 23 (policy, cross-tenant): read another tenant's registration.
  {
    const { data, error } = await db
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', victim.pushEndpoint);
    check(
      "adversarial: read another tenant's push registration blocked",
      !error && (data ?? []).length === 0,
      error ? error.message : `${(data ?? []).length} rows (leak!)`,
    );
  }

  // Attack 24 (policy, same company): read a COLLEAGUE's registration inside
  // the attacker's OWN company. Without this, dropping
  // `profile_id = auth.uid()` from the policies still passes every other
  // check here — the same blind spot notifications needed a second profile
  // to close. This is the most important check in this section, so it is
  // self-validating like attack 25: confirmed via the admin client that the
  // colleague's row actually exists under this exact endpoint first. Without
  // that, a future rename turning `attacker.colleaguePushEndpoint` into
  // `undefined` would make PostgREST return zero rows for an unrelated
  // reason (no `.eq()` match, not RLS), and this check would go green while
  // proving nothing.
  {
    const { data: seeded } = await admin
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', attacker.colleaguePushEndpoint);
    const { data, error } = await db
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', attacker.colleaguePushEndpoint);
    check(
      "adversarial: read a same-company colleague's push registration blocked",
      (seeded ?? []).length === 1 && !error && (data ?? []).length === 0,
      (seeded ?? []).length !== 1
        ? `seed row missing (${(seeded ?? []).length} rows) — check is untestable`
        : error ? error.message : `${(data ?? []).length} rows (leak!)`,
    );
  }

  // Attack 25 (delete policy, cross-tenant): delete another tenant's
  // registration — silencing their alerts. RLS filters rows rather than
  // raising, so a blocked DELETE matches nothing and returns no error; the
  // victim's row surviving is the only truthful signal.
  {
    await db.from('push_subscriptions').delete().eq('endpoint', victim.pushEndpoint);
    const { data: survivor } = await admin
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', victim.pushEndpoint);
    check(
      "adversarial: delete another tenant's push registration blocked",
      (survivor ?? []).length === 1,
      (survivor ?? []).length === 1 ? 'row survives' : 'ACCEPTED — foreign registration deleted (leak!)',
    );
  }

  // Attack 26 (FK guard trigger): register a phone against another tenant's
  // profile — company_id is honest (the attacker's own, so RLS passes) but
  // profile_id names the victim's user. The 0026 cross-company FK guard
  // (same shape as 0009's) is the only thing standing between an honest
  // company_id and a row naming someone else's user.
  {
    const forgedEndpoint = `https://push.example/forged-${randomBytes(16).toString('hex')}`;
    const { error } = await db.from('push_subscriptions').insert({
      company_id: attacker.companyId,
      profile_id: victim.userId,
      endpoint: forgedEndpoint,
      p256dh: 'k',
      auth: 'a',
    });
    check(
      "adversarial: register a phone against another tenant's profile blocked",
      error?.code === '23514',
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — cross-tenant FK guard missing!',
    );
    // Same cleanup shape as attacks 1, 2, 6, 15 and 17: if the guard ever
    // failed and the row got created, don't leave it for the company-wide
    // sweep 400 lines away to find later — remove it right here, by the one
    // value (the endpoint) that uniquely names it.
    if (!error) await admin.from('push_subscriptions').delete().eq('endpoint', forgedEndpoint);
  }

  // Attack 27 (grant layer): push_subscriptions has NO update grant at all —
  // not even for last_failed_at, which 0026:33-35 reserves for the
  // dispatcher on the service role specifically so a tenant cannot launder a
  // failing registration back into a healthy-looking one. notifications got
  // the equivalent check (attack 20); this is push_subscriptions' turn. Own
  // row, own company, on purpose: this is a grant-layer check, not a
  // boundary check, so even a well-formed same-tenant write must be refused.
  // Runs before the delete positive control below, so the row it targets by
  // endpoint still exists when this fires.
  {
    const { error } = await db
      .from('push_subscriptions')
      .update({ last_failed_at: null })
      .eq('endpoint', attacker.pushEndpoint);
    check(
      'adversarial: update of push_subscriptions (no UPDATE grant) blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — update grant leaked',
    );
  }

  // POSITIVE CONTROL 1. Every check above asserts a REFUSAL, so a policy
  // that denied everyone would pass all five (AGENTS.md). The owner must
  // still be able to read their OWN registration.
  {
    const { data, error } = await db
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', attacker.pushEndpoint);
    check(
      "adversarial: owner can still read their OWN push registration (positive control)",
      !error && (data ?? []).length === 1,
      error ? error.message : `${(data ?? []).length} rows`,
    );
  }

  // POSITIVE CONTROL 2. Attack 25 only proves a FOREIGN delete is refused —
  // it passes just as happily if the delete policy or the `delete` grant
  // were removed outright, which would silently break "turn alerts off on
  // this phone" (0026:84-90, and the sign-out cleanup that ships alongside
  // it) with the whole matrix green. The owner must still be able to DELETE
  // their OWN registration. Runs last in this section: nothing later reads
  // `attacker.pushEndpoint`, and cleanupTenant's sweep is indifferent to the
  // row already being gone.
  //
  // Self-validated like attack 24: this check asserts "zero rows remain",
  // so a stale `attacker.pushEndpoint` reference (renamed to `undefined`,
  // say) would make the DELETE match nothing regardless of policy and still
  // report "0 rows remain" — green, proving nothing. Confirming a row
  // existed beforehand closes that.
  {
    const { data: before } = await admin
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', attacker.pushEndpoint);
    const { error } = await db.from('push_subscriptions').delete().eq('endpoint', attacker.pushEndpoint);
    const { data: after } = await admin
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', attacker.pushEndpoint);
    check(
      "adversarial: owner can still DELETE their OWN push registration (positive control)",
      (before ?? []).length === 1 && !error && (after ?? []).length === 0,
      (before ?? []).length !== 1
        ? `seed row missing (${(before ?? []).length} rows) — check is untestable`
        : error ? error.message : `${(after ?? []).length} rows remain`,
    );
  }

  // ── the worker thread (0027) ──────────────────────────────────────────────
  // Attacks 26-27 and their own-tenant counterparts. worker_conversations and
  // worker_messages are SELECT-only for tenants: a manager may read their
  // crew's thread on a screen, and nothing else. The absent policies matter
  // more here than on most tables, because the rows are worker-authored text
  // the manager reads as somebody's own words —
  //
  //   a tenant able to INSERT could put words in a crew member's mouth,
  //   a tenant able to UPDATE could rewrite what one of them actually said,
  //
  // and both would be invisible: the thread would simply read differently.
  // The service role is the only writer in production, so nothing legitimate
  // loses anything by these being refused.
  {
    const { error } = await db.from('worker_messages').insert({
      conversation_id: attacker.workerConversationId,
      company_id: attacker.companyId,
      role: 'user',
      content: { parts: [{ type: 'text', text: 'forged by the manager' }] },
    });
    check(
      'adversarial: tenant cannot INSERT into their OWN worker thread',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — worker words are forgeable',
    );
  }
  {
    const { error } = await db
      .from('worker_messages')
      .update({ content: { parts: [{ type: 'text', text: 'rewritten' }] } })
      .eq('id', attacker.workerMessageId);
    const { data: after } = await admin
      .from('worker_messages')
      .select('content')
      .eq('id', attacker.workerMessageId)
      .single();
    const intact = JSON.stringify(after?.content ?? {}).includes(attacker.workerSecret);
    check(
      'adversarial: tenant cannot REWRITE their own worker thread',
      error != null || intact,
      error ? `rejected (${error.code ?? 'err'})` : intact ? 'no-op' : 'REWRITTEN — worker words are mutable',
    );
  }
  {
    const { error } = await db.from('worker_messages').delete().eq('id', attacker.workerMessageId);
    const { data: after } = await admin.from('worker_messages').select('id').eq('id', attacker.workerMessageId);
    check(
      'adversarial: tenant cannot DELETE from their own worker thread',
      (after ?? []).length === 1,
      error ? `rejected (${error.code ?? 'err'})` : `${(after ?? []).length} rows remain`,
    );
  }
  {
    const { error } = await db
      .from('worker_conversations')
      .insert({ company_id: attacker.companyId, worker_id: victim.workerId });
    check(
      'adversarial: cross-company worker_conversation blocked by the 0027 FK trigger',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — boundary broken',
    );
  }
}

/**
 * THE CENTRAL CLAIM OF PRD 4, MACHINE-CHECKED.
 *
 * Everything else in this file asks "can tenant A read tenant B's rows". This
 * asks something different and, for this feature, more important: does worker-
 * authored text ever land in a table the MANAGER'S AGENT reads?
 *
 * The escalation it rules out is specific. `messages` feeds loadWindow →
 * toThread → thread.recentUserTexts (the last three user rows) →
 * ToolContext.recentUserTexts → runGuarded, which authorizes a DIRECT
 * manager-level write whenever the model can quote the manager. A worker who
 * could write into `messages` would not be persuading the manager's agent of
 * anything — they would be WRITING the evidence its authorization check reads.
 * `conversation_summaries` and `memories` are the same hazard one hop removed:
 * both are injected wholesale into the manager's system prompt.
 *
 * Run on the SERVICE ROLE, deliberately. An RLS-scoped read that found nothing
 * would prove only that RLS works; the claim is that the text was never written
 * there at all, and only a query that bypasses RLS can say so.
 *
 * The tracer is seeded per tenant (workerSecret) and is a string no other seed
 * writes, so a hit is unambiguous. The positive control at the end is what
 * stops this whole function passing for the wrong reason: if the tracer were
 * never written anywhere, every sweep below would come back empty and report
 * green while asserting nothing.
 */
async function checkWorkerTextIsolation(tenant) {
  const L = tenant.label;
  const secret = tenant.workerSecret;

  // POSITIVE CONTROL FIRST: the tracer really is in worker_messages.
  {
    const { data } = await admin
      .from('worker_messages')
      .select('id')
      .eq('conversation_id', tenant.workerConversationId);
    const { data: row } = await admin
      .from('worker_messages')
      .select('content')
      .eq('id', tenant.workerMessageId)
      .single();
    check(
      `${L}: worker text IS in worker_messages (positive control)`,
      (data ?? []).length === 1 && JSON.stringify(row?.content ?? {}).includes(secret),
      `${(data ?? []).length} rows`,
    );
  }

  // `messages` — the one that matters most. Matched on the JSON content cast to
  // text, so a tracer buried anywhere inside the parts array is still found.
  {
    const { data, error } = await admin.from('messages').select('id, content');
    const hits = (data ?? []).filter(r => JSON.stringify(r.content ?? {}).includes(secret));
    check(
      `${L}: worker text NEVER reaches messages (the manager's thread)`,
      !error && hits.length === 0,
      error ? error.message : `${hits.length} hits`,
    );
  }
  {
    const { data, error } = await admin.from('conversation_summaries').select('id, summary');
    const hits = (data ?? []).filter(r => (r.summary ?? '').includes(secret));
    check(
      `${L}: worker text NEVER reaches conversation_summaries`,
      !error && hits.length === 0,
      error ? error.message : `${hits.length} hits`,
    );
  }
  {
    const { data, error } = await admin.from('memories').select('id, content');
    const hits = (data ?? []).filter(r => (r.content ?? '').includes(secret));
    check(
      `${L}: worker text NEVER reaches memories (injected into the manager's prompt)`,
      !error && hits.length === 0,
      error ? error.message : `${hits.length} hits`,
    );
  }
  // proposals.rendered_text is the approval artifact the manager taps. Worker
  // text reaching it would mean a crew phone had authored a card.
  {
    const { data, error } = await admin.from('proposals').select('id, rendered_text, action_args');
    const hits = (data ?? []).filter(
      r => (r.rendered_text ?? '').includes(secret) || JSON.stringify(r.action_args ?? {}).includes(secret),
    );
    check(
      `${L}: worker text NEVER reaches proposals`,
      !error && hits.length === 0,
      error ? error.message : `${hits.length} hits`,
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
// exact user could write to any tenant's tasks/task_reviews. Attack 30 is the
// same defect in revert_translation_batch, which is where open_task_review
// inherited it from.
//
// Runs LAST on purpose. If a boundary is broken these calls genuinely mutate
// the victim's rows, and every earlier check has already read the state it
// needed by then — so a failure here reports one clean defect instead of
// cascading into unrelated noise.
async function runOrphanAttack(orphan, victim) {
  const db = orphan.client;

  // Attack 28: filing a claim on a real tenant's real task. Targets
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

  // Attack 29: resolving a real tenant's real review. Note this one was
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

  // Attack 30 (0015 + 0021): revert_translation_batch is SECURITY DEFINER, so
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

  // Attack 31 (0023): the storage boundary, seen by the actor it is most
  // likely to fail open for. The storage.objects policies read
  // `(storage.foldername(name))[1] = (select private.current_company_id())::text`,
  // and for this user that function returns NULL — the exact input that turned
  // two SECURITY DEFINER guards into no-ops (attacks 19 and 21). Inside a
  // policy the comparison yields NULL, which is not true, so the policy denies
  // and the direction is correct. That reasoning is worth exactly nothing
  // unasserted, which is why it is asserted: the whole point of this third
  // actor is that "it should be fine" is how both earlier holes shipped.
  //
  // Both halves, because signing and reading are different endpoints.
  {
    const { data: signed, error: signError } = await db.storage
      .from('task-photos')
      .createSignedUrl(victim.photoPath, 60);
    check(
      'adversarial: orphan (no profiles row) signed URL for a task photo blocked',
      signError != null && !signed?.signedUrl,
      signError ? `rejected (${signError.message})` : 'SIGNED — NULL company reads as a match!',
    );

    const { data: bytes, error: downloadError } = await db.storage
      .from('task-photos')
      .download(victim.photoPath);
    check(
      'adversarial: orphan (no profiles row) download of a task photo blocked',
      downloadError != null && bytes == null,
      downloadError ? `rejected (${downloadError.message})` : 'DOWNLOADED — boundary broken',
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
  // Before the orphan attacks, which genuinely mutate rows if a boundary is
  // broken — this sweep wants a clean state to read.
  await checkWorkerTextIsolation(tenantA);
  await checkWorkerTextIsolation(tenantB);
  await runOrphanAttack(orphan, tenantB);

  // Positive controls are an ALLOW, not a refusal, so they don't belong in
  // either bucket below: counting one as a "blocked" adversarial check would
  // make the summary line lie about what it asserts. Matched by name rather
  // than given their own prefix, so any future positive control is caught by
  // convention (name it with "(positive control)") without another edit here.
  const isControl = (r) => r.name.includes('positive control');
  const matrixChecks = results.filter(r => !r.name.includes('bonus') && !r.name.startsWith('adversarial') && !isControl(r));
  const adversarialChecks = results.filter(r => r.name.startsWith('adversarial') && !isControl(r));
  const controlChecks = results.filter(isControl);
  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? ` — ${r.detail}` : ''}`);
  }
  console.log('');
  console.log(`Matrix: ${matrixChecks.filter(r => r.ok).length}/${matrixChecks.length} visibility checks passed; ` +
    `adversarial: ${adversarialChecks.filter(r => r.ok).length}/${adversarialChecks.length} blocked; ` +
    `controls: ${controlChecks.filter(r => r.ok).length}/${controlChecks.length} allowed; failures: ${failures}`);
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
