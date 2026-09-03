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
// That sweep got MORE load-bearing with #47, which gave the system three new
// reasons to write into `messages` — a note when the 07:00 briefing goes out, a
// note when the late-afternoon check-in goes out, and one note per crew member
// who taps an answer to it. Those notes may carry counts, crew NAMES (typed by
// the manager) and which of two buttons was tapped; they may never carry
// worker-authored prose. So the tracer is seeded in every place a crew
// member's words legitimately live — the worker agent's own thread,
// `task_reviews.note`, `problem_reports.text` (#120) and, since #152,
// `worker_requests.text` — because those are exactly the columns a
// well-meaning "let's also quote what they said" change would draw from. The
// last one is the sharpest: a request is DESIGNED to be shown to the manager on
// three surfaces, and it already has a chat-thread note beside it that is
// allowed to carry a crew NAME and a date and nothing else.
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
// 0034 (issue #52) adds the row that decides WHERE the next photo goes:
// checkin_photo_requests, which records "the next unlabelled photo from this
// crew member is proof of THIS task" for a few hours after they tap "Sim,
// terminei". It is deny-all with every grant revoked — notification_log's
// posture — so it appears twice here: as a deny-all READ in the visibility
// sweep (seeded, so an exposing policy cannot pass for want of rows), and as
// three grant-layer attacks. Insert would let a tenant manufacture a request
// naming a task of their choosing; update would repoint an existing one with no
// worker cooperation at all; delete would erase the trail. All three end in a
// task_photos row that can never be removed, because 0023 has no DELETE policy
// anywhere.
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
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
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

/**
 * "The tenant saw nothing" — spread straight into `check(name, ...)`.
 *
 * Returns `[ok, detail]`. A read counts as denied when it returned zero rows,
 * OR when it was refused outright with 42501 (insufficient_privilege), which is
 * what a table with its SELECT grant revoked answers. See the long comment on
 * the deny-all block below for which tables are in which camp and why.
 *
 * Any OTHER error is a failure, not a pass. 42P01 in particular must never
 * count as denied: a dropped table would report as secure.
 */
function readIsDenied(data, error) {
  if (error) {
    return error.code === '42501'
      ? [true, 'refused at the grant layer (42501)']
      : [false, `unexpected error ${error.code ?? '?'}: ${error.message}`];
  }
  const n = (data ?? []).length;
  return [n === 0, n === 0 ? '0 rows' : `${n} rows LEAKED`];
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

  // The BSUID is seeded on the service role because that is the only writer
  // 0028 leaves — and because the adversarial pass needs a REAL victim
  // identity to try to claim. A literal string invented at the attack site
  // would test the grant just as well but would stop describing the actual
  // threat, which is one tenant claiming another tenant's worker.
  const worker = await must(
    admin.from('workers').insert({
      company_id: companyId,
      name: `Worker ${label}`,
      whatsapp_user_id: `PT.9900000000000000000${label}`,
    }).select().single(),
    `worker(${label})`,
  );
  // A SECOND crew member, seeded for issue #44: somebody to be a COLLABORATOR
  // on task1 while `worker` above leads it. Without two workers a lead/helper
  // pair cannot exist at all, and every task_assignees check below would pass
  // against an empty table — the trap this file's header warns about.
  const helper = await must(
    admin.from('workers').insert({
      company_id: companyId,
      name: `Helper ${label}`,
    }).select().single(),
    `helper(${label})`,
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

  // The collaborator (0035, issue #44). Written through the RPC rather than a
  // raw insert, exactly as the seeded review goes through open_task_review —
  // so the seed exercises the only writer the table has, and so the LEAD row
  // the mirror trigger produced on task1's insert is proved to coexist with a
  // collaborator row under `unique (task_id, worker_id)`.
  //
  // task1, not task2: task1 has an assignee, so this is a real lead + helper
  // pair rather than a lead-less one. auth.uid() is null on the service role,
  // so the RPC's tenant guard is skipped by design here — it is the adversarial
  // pass below that exercises it.
  await must(
    admin.rpc('set_task_collaborators', { p_task: task1.id, p_workers: [helper.id] }),
    `task_collaborator(${label})`,
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
  // THREE memories, one per scope 0037 allows (issue #48). Before it, every
  // memory belonged to the company and a colleague was indistinguishable from
  // the owner — so the two personal rows are what make the new per-profile
  // policy testable at all, exactly as the colleague's notification and push
  // registration do for 0024 and 0026.
  const companyMemory = await must(
    admin.from('memories').insert({ company_id: companyId, kind: 'fact', content: `memory ${label}` }).select().single(),
    `memory(${label})`,
  );
  const ownMemory = await must(
    admin.from('memories').insert({
      company_id: companyId, profile_id: userId, kind: 'preference',
      content: `own memory ${label} ${run}`,
    }).select().single(),
    `memory_own(${label})`,
  );
  const colleagueMemory = await must(
    admin.from('memories').insert({
      company_id: companyId, profile_id: colleagueId, kind: 'preference',
      content: `colleague secret ${label} ${run}`,
    }).select().single(),
    `memory_colleague(${label})`,
  );

  // The nightly review's ledger (0037). Written by the service role in
  // production too — the cron — and tenants have SELECT and nothing else.
  await must(
    admin.from('memory_consolidations').insert({
      company_id: companyId, run_date: '2026-01-05', status: 'done',
      covers_until_at: '2026-01-05T02:00:00Z', messages_read: 12, memories_written: 1,
    }).select(),
    `memory_consolidation(${label})`,
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

  // A worker PROBLEM REPORT (0042, issue #120), carrying the SAME tracer.
  // Written as the service role, which is the only writer of
  // channel='whatsapp' rows in production too — the WhatsApp webhook. A report
  // is worker-authored prose stored for the OPERATOR, which makes it the THIRD
  // seeded source of worker text: checkWorkerTextIsolation asserts it landed
  // here (positive control) and then sweeps the four manager-context tables
  // for the tracer, so the day some change starts quoting a report into the
  // thread, a summary, a memory or a card, that sweep fails.
  const problemReport = await must(
    admin.from('problem_reports').insert({
      company_id: companyId, worker_id: worker.id, channel: 'whatsapp',
      text: `report ${label} ${run} ${workerSecret}`,
      context: { source: 'whatsapp', via: 'armed' },
    }).select().single(),
    `problem_report(${label})`,
  );

  // A CREW REQUEST (0043, issue #152), carrying the SAME tracer. Written as the
  // service role, which is the only writer in production too — the WhatsApp
  // webhook, through the fifth worker tool. A request is worker-authored prose
  // that the MANAGER is meant to read, which makes it the FOURTH seeded source
  // of worker text: checkWorkerTextIsolation asserts it landed here (positive
  // control) and then sweeps the four manager-context tables for the tracer, so
  // the day some change starts quoting a request into the thread, a summary, a
  // memory or a card, that sweep fails. That is the whole reason it is seeded
  // rather than merely attacked: a request is deliberately shown to the manager
  // on three surfaces, and "shown to the manager" is one careless step away
  // from "written into the manager's agent context".
  //
  // `needed_by` is set so the row also exercises the urgency column; nothing in
  // this file asserts on it (the arithmetic is pinned by pnpm whatsapp-check,
  // credential-free).
  const workerRequest = await must(
    admin.from('worker_requests').insert({
      company_id: companyId, worker_id: worker.id, task_id: task1.id,
      text: `request ${label} ${run} ${workerSecret}`,
      category: 'material',
      needed_by: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    }).select().single(),
    `worker_request(${label})`,
  );

  // An OPEN report staging row (0042) for the adversarial repoint/erase
  // attacks below — the same job photoRequest does for 0034.
  const reportRequest = await must(
    admin.from('problem_report_requests').insert({
      company_id: companyId, worker_id: worker.id,
      expires_at: new Date(Date.now() + 1800_000).toISOString(),
    }).select().single(),
    `problem_report_request(${label})`,
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
      // The tracer rides in the NOTE on purpose (issue #47). task_reviews.note
      // is the ONE place worker-authored prose legitimately reaches the
      // manager, and since #47 the system writes several `role='event'` rows
      // into `messages` a day describing exactly the events that produce these
      // reviews — the check-in ask, and each crew member's answer to it. The
      // day one of those notes starts quoting what the worker wrote, this
      // tracer appears in `messages` and checkWorkerTextIsolation fails.
      // Without it that sweep would only cover the worker AGENT's thread.
      p_note: `seed note ${label} ${run} ${workerSecret}`,
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

  // The check-in ask, and the photo request that descends from it (0034,
  // issue #52). Both are written by the WhatsApp webhook on the SERVICE ROLE in
  // production too, and both are deny-all for tenants — notification_log's
  // posture, not worker_checkins'.
  //
  // Seeded rather than left empty because a deny-all check against an empty
  // table passes for the wrong reason: it would report green on a policy that
  // exposed every company's rows, simply because there were none to expose.
  //
  // The request row is the interesting one. It says "the next bare photo from
  // this crew member is proof of THIS task", so a tenant able to insert or
  // update one could redirect another company's worker's next photo onto a task
  // of their choosing — and a task photo cannot be deleted (0023 has no DELETE
  // policy anywhere). The adversarial pass attacks both writes.
  const checkinAsk = await must(
    admin.from('notification_log').insert({
      company_id: companyId, kind: 'task_checkin', audience: 'worker',
      worker_id: worker.id, notification_date: '2026-01-05', status: 'sent',
      task_ids: [task1.id],
    }).select().single(),
    `notification_log(${label})`,
  );
  // The SCHEDULE and the RUN LOG (0036, issue #51). Both are ordinary
  // company-scoped tenant tables — the schedule is readable AND writable by its
  // owner (it is the control on /perfil/automacoes), the run log is read-only
  // (the cron writes it on the service role). Seeded so the per-tenant sweep
  // below can assert BOTH halves: own rows visible, foreign rows absent. A
  // company-scoped check against an empty table passes for the wrong reason.
  await must(
    admin.from('company_schedules').insert({
      company_id: companyId, job_kind: 'daily_briefing', send_hour: 7, enabled: true,
    }).select().single(),
    `company_schedule(${label})`,
  );
  await must(
    admin.from('cron_runs').insert({
      company_id: companyId, job_kind: 'daily_briefing', run_date: '2026-01-05',
      due_hour: 7, ran_hour: 7, messaged: 1, excluded_no_consent: 1,
    }).select().single(),
    `cron_run(${label})`,
  );

  const photoRequest = await must(
    admin.from('checkin_photo_requests').insert({
      company_id: companyId, worker_id: worker.id, notification_id: checkinAsk.id,
      checkin_date: '2026-01-05', task_ids: [task1.id],
      expires_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    }).select().single(),
    `checkin_photo_request(${label})`,
  );

  // 0047: a photo this crew member has sent that no task has claimed yet.
  // Seeded so the deny-all read below cannot pass for want of rows, and so the
  // UPDATE attack has something real to aim at. A row here is not evidence of
  // anything, but a tenant able to WRITE one could stage an object as though
  // the crew had sent it, or re-point a colleague's waiting photo at a task of
  // their choosing — and a task photo cannot be deleted (0023 has no DELETE
  // policy anywhere). The path has to satisfy worker_photo_inbox_path_scoped.
  const inboxPhoto = await must(
    admin.from('worker_photo_inbox').insert({
      company_id: companyId, worker_id: worker.id,
      storage_path: `${companyId}/inbox/${worker.id}/${randomUUID()}.jpg`,
      mime: 'image/jpeg', byte_size: 1234,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }).select().single(),
    `worker_photo_inbox(${label})`,
  );

  // 0049: Capo has already asked this crew member once for a photo of task2.
  // Seeded so the deny-all read below cannot pass for want of rows, and so the
  // UPDATE and DELETE attacks have something real to aim at. What a WRITE here
  // would buy is the whole no-photo rule: a tenant able to insert two rows
  // could let the very next claim skip both asks, and one able to delete them
  // could make Capo ask for ever.
  const waiverAttempt = await must(
    admin.from('task_photo_waiver_attempts').insert({
      company_id: companyId, worker_id: worker.id, task_id: task2.id,
      conversation_id: workerConversation.id,
      attempt_no: 1,
      inbound_message_id: `wamid.SEED.${label}.${run}`,
    }).select().single(),
    `task_photo_waiver_attempt(${label})`,
  );

  // 0039 (issue #114): the bearer token behind the crew day page. Seeded so the
  // deny-all read below cannot pass for want of rows, and so the UPDATE and
  // DELETE attacks have something real to aim at. `dayLinkToken` is carried out
  // because the read attack has to present a token an attacker could plausibly
  // have — a guessed one proves nothing about the policy.
  const dayLinkToken = randomBytes(32).toString('base64url');
  await must(
    admin.from('worker_day_links').insert({
      token: dayLinkToken,
      company_id: companyId,
      worker_id: worker.id,
      link_date: '2026-01-05',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }).select('token').single(),
    `worker_day_link(${label})`,
  );

  const client = createClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false },
  });
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(`signIn(${label}): ${signInErr.message}`);

  return {
    label, userId, companyId, client,
    workerId: worker.id, helperWorkerId: helper.id,
    workerBsuid: worker.whatsapp_user_id, jobId: job.id, taskIds: [task1.id, task2.id],
    conversationId: conversation.id, batchId: batch.id, originalTitle, reviewId,
    photoPath, checkinAskId: checkinAsk.id, photoRequestId: photoRequest.id,
    inboxPhotoId: inboxPhoto.id, inboxPhotoPath: inboxPhoto.storage_path,
    waiverAttemptId: waiverAttempt.id,
    problemReportId: problemReport.id, reportRequestId: reportRequest.id,
    workerRequestId: workerRequest.id,
    colleagueId, ownNotificationId, colleagueNotificationId,
    companyMemoryId: companyMemory.id, ownMemoryId: ownMemory.id, colleagueMemoryId: colleagueMemory.id,
    pushEndpoint, colleaguePushEndpoint,
    workerConversationId: workerConversation.id, workerMessageId: workerMessage.id, workerSecret,
    dayLinkToken,
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
  // Before profiles and workers: ai_usage.profile_id / .worker_id are both FKs.
  await companyEq(admin.from('ai_usage').delete());
  // Before profiles: notifications.profile_id and push_subscriptions.profile_id
  // are both FKs (on delete cascade, but the deletes are explicit here so a
  // leftover row is never mistaken for one the app wrote).
  await companyEq(admin.from('notifications').delete());
  await companyEq(admin.from('push_subscriptions').delete());
  // Before profiles: company_schedules.updated_by is a FK to it (0036). Both of
  // these are plain company-scoped rows with no dependants of their own.
  await companyEq(admin.from('company_schedules').delete());
  await companyEq(admin.from('cron_runs').delete());
  await companyEq(admin.from('translation_items').delete());
  await companyEq(admin.from('translation_batches').delete());
  await companyEq(admin.from('proposals').delete());
  await admin.from('conversation_summaries').delete().eq('conversation_id', t.conversationId);
  await admin.from('messages').delete().eq('conversation_id', t.conversationId);
  // BEFORE worker_conversations, tasks and workers: task_photo_waiver_attempts
  // (0049) holds a plain FK to all three and none of them cascades, so a row
  // left behind would strand the whole company on the deletes below.
  await companyEq(admin.from('task_photo_waiver_attempts').delete());
  // Before workers and before worker_checkins: worker_messages.checkin_id and
  // worker_conversations.worker_id are both FKs.
  await companyEq(admin.from('worker_messages').delete());
  await companyEq(admin.from('worker_conversations').delete());
  await companyEq(admin.from('task_reviews').delete());
  // Before tasks AND before workers (0035). task_assignees.task_id cascades on
  // a task delete, but worker_id deliberately does not — so leaving these until
  // the workers sweep would fail the FK and strand a company.
  await companyEq(admin.from('task_assignees').delete());
  // Before tasks and before workers: worker_requests holds a FK to each (0043).
  // task_id is `on delete set null`, so the row would survive a task delete —
  // but worker_id is a plain FK and would strand the company.
  await companyEq(admin.from('worker_requests').delete());
  // BEFORE tasks and before workers: worker_photo_inbox holds a FK to each
  // (0047), and attached_task_id does not cascade — an attached photo left
  // behind would strand the whole company on the tasks delete below.
  await companyEq(admin.from('worker_photo_inbox').delete());
  await admin.from('task_dependencies').delete().in('task_id', t.taskIds);
  await companyEq(admin.from('tasks').delete());
  await companyEq(admin.from('memories').delete());
  await companyEq(admin.from('memory_consolidations').delete());
  await companyEq(admin.from('transcription_vocab').delete());
  await companyEq(admin.from('conversations').delete());
  // Before workers: worker_checkins.worker_id is a FK.
  await companyEq(admin.from('worker_checkins').delete());
  // Before workers and profiles: both 0042 tables hold FKs to each.
  await companyEq(admin.from('problem_reports').delete());
  await companyEq(admin.from('problem_report_requests').delete());
  // Before workers and before notification_log: checkin_photo_requests holds a
  // FK to each (0034).
  await companyEq(admin.from('checkin_photo_requests').delete());
  await companyEq(admin.from('notification_log').delete());
  // Before workers: worker_day_links.worker_id is a FK (0039).
  await companyEq(admin.from('worker_day_links').delete());
  await companyEq(admin.from('workers').delete());
  // Before jobs and before profiles: material_checks holds a FK to each (0044).
  // Neither cascades, so a tick left behind strands the whole company.
  await companyEq(admin.from('material_checks').delete());
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
  //
  // `memories` is a THIRD case and stays in the list on purpose: since 0037 it
  // is company-scoped OR per-profile, row by row, and the seeded company-scoped
  // row is what keeps `ownVisible` meaningful here. Its per-profile half is
  // asserted by checkMemoryScope, which is where a dropped
  // `profile_id = auth.uid()` clause would fail. This loop cannot see that
  // regression — a colleague's memory carries the caller's own company_id.
  //
  // `worker_requests` (0043) IS in this list, unlike problem_reports: a crew
  // request is meant to be READ by the manager, so the tenant holds SELECT and
  // the interesting question is the ordinary one — own rows visible, zero
  // foreign rows. Its write-side refusals are attacked separately below,
  // because SELECT is the ONLY grant it has.
  for (const table of ['companies', 'workers', 'jobs', 'tasks', 'memories', 'conversations', 'proposals', 'transcription_vocab', 'task_board', 'translation_batches', 'translation_items', 'task_reviews', 'task_assignees', 'worker_checkins', 'task_photos', 'worker_conversations', 'worker_messages', 'company_schedules', 'cron_runs', 'memory_consolidations', 'worker_requests']) {
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
  // in the loop above. Each seeded producer fans out TWO rows in this company —
  // one for this user, one for their colleague — so `foreignProfile` is the
  // assertion the generic loop structurally cannot make: a policy missing its
  // `profile_id = auth.uid()` clause returns both rows, every one of them with
  // the right company_id.
  //
  // TWO rows are expected here, one per seeded PRODUCER, and the count is
  // exact on purpose: a count that drifted upward with the seed would be a
  // count that could also drift upward with a leak. The producers are the
  // review fan-out (0024) and, since #152, the crew-request fan-out (0043) —
  // the tracer seeded for checkWorkerTextIsolation inserts a worker_requests
  // row, and worker_requests_notify_manager correctly gives this manager an
  // inbox entry for it. Asserting the KINDS as well as the number means the
  // next producer added to `notifications` fails here loudly, and the failure
  // says which kind is new rather than only that a number moved.
  const EXPECTED_NOTIFICATION_KINDS = ['review_pending', 'worker_request'];
  {
    const { data, error } = await db.from('notifications').select('*');
    const rows = data ?? [];
    const foreignCompany = rows.filter(r => r.company_id !== self.companyId);
    const foreignProfile = rows.filter(r => r.profile_id !== self.userId);
    const kinds = [...new Set(rows.map(r => r.kind))].sort();
    const kindsMatch = kinds.join(',') === [...EXPECTED_NOTIFICATION_KINDS].sort().join(',');
    check(`${L}: notifications`,
      !error && rows.length === EXPECTED_NOTIFICATION_KINDS.length && kindsMatch
        && foreignCompany.length === 0 && foreignProfile.length === 0,
      error ? error.message
        : `${rows.length} rows [${kinds.join(', ')}], ${foreignCompany.length} foreign company, ${foreignProfile.length} foreign profile`);
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
  //
  // ── WHY THESE FOUR GO THROUGH readIsDenied AND THE OTHER 24 DO NOT ────────
  // "A tenant sees nothing" has TWO legitimate shapes in this schema, and the
  // deny-all tables are split across both:
  //
  //   0 rows, no error   — dispatch_log, notification_log. RLS is on with no
  //                        policy, but the tenant still holds a SELECT GRANT,
  //                        so PostgREST runs the query and it matches nothing.
  //   42501, no rows     — ai_usage, checkin_photo_requests. These additionally
  //                        `revoke all ... from authenticated`, so the read is
  //                        refused at the GRANT layer before RLS is consulted.
  //
  // The second is strictly stronger. Asserting only the first marked the two
  // safest tables in the schema as failures — which is how this file first ran
  // red on a completely healthy database, and exactly the way a security gate
  // stops being read.
  //
  // 42P01 (undefined_table) is deliberately NOT accepted: a dropped or renamed
  // table would otherwise report as perfectly secure, which is the one false
  // green worth fearing here.
  {
    const { data, error } = await db.from('dispatch_log').select('id');
    check(`${L}: dispatch_log deny-all (bonus)`, ...readIsDenied(data, error));
  }
  {
    const { data, error } = await db.from('notification_log').select('id');
    check(`${L}: notification_log deny-all (bonus)`, ...readIsDenied(data, error));
  }

  // checkin_photo_requests (0034) — the fourth deny-all relation, and the one
  // whose rows are the most directly weaponisable. Each says "the next
  // unlabelled photo from this crew member is proof of THIS task". Reading one
  // tells an attacker who is mid-conversation with Capo and about which job;
  // writing one redirects a photo. Both seeded rows exist by the time this
  // runs, so a policy that exposed every company's rows would show TWO here.
  {
    const { data, error } = await db.from('checkin_photo_requests').select('id');
    check(`${L}: checkin_photo_requests deny-all (bonus)`, ...readIsDenied(data, error));
  }

  // worker_photo_inbox (0047) — a photo a crew member has sent that no task has
  // claimed yet. Deny-all with every grant revoked, checkin_photo_requests'
  // posture, and for a related reason: the row is not evidence of anything, so
  // there is no tenant question it answers. What a READ would give an attacker
  // is the object key of a photo staged inside another company's folder, which
  // is exactly the string 0023's storage policies compare against. Both
  // tenants' rows exist by the time this runs, so a policy exposing every
  // company would show TWO here.
  {
    const { data, error } = await db.from('worker_photo_inbox').select('id');
    check(`${L}: worker_photo_inbox deny-all (bonus)`, ...readIsDenied(data, error));
  }

  // task_photo_waiver_attempts (0049) — how many separate messages a crew
  // member has spent saying a task is finished with no photo. Deny-all with
  // every grant revoked, checkin_photo_requests' posture, and for the same
  // reason: the row is not a business fact, it is Capo's private note that it
  // has already asked. Both tenants' rows exist by the time this runs, so a
  // policy exposing every company would show TWO here.
  {
    const { data, error } = await db.from('task_photo_waiver_attempts').select('id');
    check(`${L}: task_photo_waiver_attempts deny-all (bonus)`, ...readIsDenied(data, error));
  }

  // worker_day_links (0039, issue #114) — the fifth deny-all relation, and the
  // only one whose rows ARE credentials rather than describing them. A token
  // read out of this table is a working read of that crew member's live work
  // until Lisbon midnight, from any browser, with no session. Both tenants'
  // rows exist by the time this runs, so a policy exposing every company would
  // show TWO here.
  {
    const { data, error } = await db.from('worker_day_links').select('token');
    check(`${L}: worker_day_links deny-all (bonus)`, ...readIsDenied(data, error));
  }

  // problem_reports (0042, issue #120) — write-only for tenants, like ai_usage
  // below: an INSERT policy exists (the app's report form writes on the
  // tenant's own client) but there is no SELECT policy and no SELECT grant,
  // because a crew member's report may be ABOUT the manager and #128's
  // decision is that reports are read in the operator app only. Both tenants'
  // seeded reports exist by the time this runs, so a policy exposing the table
  // would show rows here.
  {
    const { data, error } = await db.from('problem_reports').select('id');
    check(`${L}: problem_reports read deny-all (bonus)`, ...readIsDenied(data, error));
  }

  // problem_report_requests (0042) — deny-all with every grant revoked,
  // checkin_photo_requests' posture. A row says "this person's next WhatsApp
  // message is quietly diverted into the report table": reading one tells an
  // attacker who is mid-report; writing one diverts a colleague's next
  // message.
  {
    const { data, error } = await db.from('problem_report_requests').select('id');
    check(`${L}: problem_report_requests deny-all (bonus)`, ...readIsDenied(data, error));
  }

  // ai_usage (0032) — the THIRD ledger, and the only one with a tenant policy
  // at all. It has an INSERT policy scoped to the caller's own company, because
  // the write happens inside a tenant request on that tenant's own RLS-scoped
  // client (AGENTS.md's system-vs-user split forbids getDb() there). What it
  // deliberately does NOT have is a SELECT policy: cross-company cost is an
  // operator question, read on the service role.
  //
  // Note what this specific check can and cannot prove. It asserts that a
  // tenant sees NOTHING — not their own rows, not anyone's — which is the whole
  // read posture. It says nothing about the INSERT policy; the adversarial
  // suite below attacks that separately, because "denied everyone" would pass
  // here and break the dashboard silently.
  {
    const { data, error } = await db.from('ai_usage').select('id');
    check(`${L}: ai_usage read deny-all (bonus)`, ...readIsDenied(data, error));
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

  // ── 0034 checkin_photo_requests (issue #52) ──────────────────────────────
  // The row that decides where a crew member's NEXT unlabelled photo is filed.
  // Deny-all under RLS with every grant revoked, so these are grant-layer
  // checks and both are aimed at the ATTACKER'S OWN company on purpose: a
  // cross-tenant variant would be refused for the wrong reason.
  //
  // What a write here would buy, and why it is worth three checks rather than
  // one. INSERT: manufacture a request naming a task the attacker chooses, so
  // the next photo that crew member sends becomes proof of it — permanently,
  // since 0023 has no DELETE policy on task_photos or on storage.objects.
  // UPDATE: repoint an EXISTING request, which needs no worker cooperation at
  // all. DELETE: erase the trail afterwards.
  {
    const { error } = await db.from('checkin_photo_requests').insert({
      company_id: attacker.companyId,
      worker_id: attacker.workerId,
      notification_id: attacker.checkinAskId,
      checkin_date: '2026-01-06',
      task_ids: [attacker.taskIds[1]],
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    check(
      'adversarial: tenant forging a check-in photo request blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — a tenant can redirect a photo!',
    );
    if (!error) {
      await admin.from('checkin_photo_requests').delete()
        .eq('company_id', attacker.companyId).eq('checkin_date', '2026-01-06');
    }
  }
  {
    const { error } = await db
      .from('checkin_photo_requests')
      .update({ task_ids: [attacker.taskIds[1]] })
      .eq('id', attacker.photoRequestId);
    check(
      'adversarial: tenant repointing its own check-in photo request blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — update grant leaked',
    );
  }
  {
    const { error } = await db
      .from('checkin_photo_requests')
      .delete()
      .eq('id', attacker.photoRequestId);
    check(
      'adversarial: tenant DELETE of its own check-in photo request blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — delete grant leaked',
    );
  }

  // ── 0047 worker_photo_inbox ──────────────────────────────────────────────
  // The row that says "this crew member has a photo waiting, and here is where
  // its bytes are". Deny-all under RLS with every grant revoked, so these are
  // grant-layer checks and all three are aimed at the ATTACKER'S OWN company on
  // purpose: a cross-tenant variant would be refused for the wrong reason.
  //
  // What a write here would buy, and why it is worth three checks plus a
  // control. INSERT: stage an object of the attacker's choosing as though a
  // crew member had sent it, so it can later be attached as `source: 'worker'`
  // proof — the same forgery class 0023's column-scoped grant exists to refuse.
  // UPDATE: re-point a colleague's waiting photo, or mark one attached so it
  // stops being offered. DELETE: erase somebody's photo before they can use it,
  // which is the quiet way to make a completion claim impossible.
  {
    const { error } = await db.from('worker_photo_inbox').insert({
      company_id: attacker.companyId,
      worker_id: attacker.workerId,
      storage_path: `${attacker.companyId}/inbox/${attacker.workerId}/forged.jpg`,
      mime: 'image/jpeg',
      byte_size: 100,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    check(
      'adversarial: tenant staging a photo in the worker inbox blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — a tenant can forge crew proof!',
    );
    if (!error) {
      await admin.from('worker_photo_inbox').delete()
        .eq('storage_path', `${attacker.companyId}/inbox/${attacker.workerId}/forged.jpg`);
    }
  }
  {
    const { error } = await db
      .from('worker_photo_inbox')
      .update({ attached_task_id: attacker.taskIds[1] })
      .eq('id', attacker.inboxPhotoId);
    check(
      'adversarial: tenant re-pointing a waiting crew photo blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — update grant leaked',
    );
  }
  {
    const { error } = await db
      .from('worker_photo_inbox')
      .delete()
      .eq('id', attacker.inboxPhotoId);
    check(
      'adversarial: tenant DELETE of a waiting crew photo blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — delete grant leaked',
    );
  }
  {
    // THE POSITIVE CONTROL. Every check above asserts a REFUSAL, and a table
    // nobody could write at all would pass all three while quietly losing every
    // photo the crew sends. The webhook writes on the SERVICE ROLE, so that is
    // the actor this control uses, and it is the only one that can read the row
    // back.
    const { data, error } = await admin
      .from('worker_photo_inbox')
      .select('id, storage_path')
      .eq('id', attacker.inboxPhotoId)
      .maybeSingle();
    check(
      'positive control: the service role still stages and reads a crew photo',
      !error && data?.storage_path === attacker.inboxPhotoPath,
      error ? error.message : (data?.storage_path ?? 'no row'),
    );
  }
  {
    // The cross-company FK guard (0047's trigger). A row whose company_id is
    // honest and whose worker_id belongs to somebody else satisfies every
    // policy on the table, so only the trigger refuses it. Service role, because
    // that is the actor the trigger exists to bind: RLS does not cover it at
    // all.
    const { error } = await admin.from('worker_photo_inbox').insert({
      company_id: attacker.companyId,
      worker_id: victim.workerId,
      storage_path: `${attacker.companyId}/inbox/${victim.workerId}/${randomUUID()}.jpg`,
      mime: 'image/jpeg',
      byte_size: 100,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    check(
      'adversarial: a crew photo naming another company\'s worker blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — cross-company FK guard missing!',
    );
  }

  // ── 0049 task_photo_waiver_attempts + open_task_review's new argument ────
  // The counter behind "Capo asked twice". A crew member who genuinely cannot
  // photograph the work says so and the claim is filed anyway, flagged to the
  // manager as having no photo. Everything below exists because that rule is
  // only worth anything if the count cannot be forged.
  //
  // Deny-all with every grant revoked (0034's and 0047's posture), so these are
  // grant-layer checks aimed at the ATTACKER'S OWN company on purpose — a
  // cross-tenant variant would be refused for the wrong reason.
  //
  // What each write would buy. INSERT: file two attempts of your own choosing
  // and the very next completion claim skips both asks, so the photo
  // requirement is gone for that task with nothing anywhere erroring. UPDATE:
  // re-point an attempt at another task, or renumber it. DELETE: erase the
  // asks, so Capo asks for ever and the crew member can never record the job at
  // all — the quiet direction, and the one nobody would report as a bug.
  {
    const { error } = await db.from('task_photo_waiver_attempts').insert({
      company_id: attacker.companyId,
      worker_id: attacker.workerId,
      task_id: attacker.taskIds[1],
      conversation_id: attacker.workerConversationId,
      attempt_no: 2,
      inbound_message_id: `wamid.FORGED.${run}`,
    });
    check(
      'adversarial: tenant forging a photo-waiver attempt blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — a tenant can waive the photo rule!',
    );
    if (!error) {
      await admin.from('task_photo_waiver_attempts').delete()
        .eq('inbound_message_id', `wamid.FORGED.${run}`);
    }
  }
  {
    const { error } = await db
      .from('task_photo_waiver_attempts')
      .update({ attempt_no: 9 })
      .eq('id', attacker.waiverAttemptId);
    check(
      'adversarial: tenant rewriting a photo-waiver attempt blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — update grant leaked',
    );
  }
  {
    const { error } = await db
      .from('task_photo_waiver_attempts')
      .delete()
      .eq('id', attacker.waiverAttemptId);
    check(
      'adversarial: tenant DELETE of a photo-waiver attempt blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — delete grant leaked',
    );
  }
  {
    // THE POSITIVE CONTROL. Every check above asserts a REFUSAL, and a table
    // nobody could write at all would pass all three while making the waiver
    // unreachable for ever — which is the state 0049 exists to end. The worker
    // agent writes on the SERVICE ROLE, so that is the actor, and it is the
    // only one that can read the row back.
    const { data, error } = await admin
      .from('task_photo_waiver_attempts')
      .select('id, attempt_no')
      .eq('id', attacker.waiverAttemptId)
      .maybeSingle();
    check(
      'positive control: the service role still records and reads an ask',
      !error && data?.attempt_no === 1,
      error ? error.message : `attempt_no ${data?.attempt_no ?? 'none'}`,
    );
  }
  {
    // The cross-company FK guard (0049's trigger). A row whose company_id is
    // honest and whose worker_id belongs to somebody else satisfies every
    // policy on the table, so only the trigger refuses it. Service role,
    // because that is the actor the trigger exists to bind.
    const { error } = await admin.from('task_photo_waiver_attempts').insert({
      company_id: attacker.companyId,
      worker_id: victim.workerId,
      task_id: attacker.taskIds[1],
      conversation_id: attacker.workerConversationId,
      attempt_no: 7,
      inbound_message_id: `wamid.CROSSFK.${run}`,
    });
    check(
      'adversarial: a waiver attempt naming another company\'s worker blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — cross-company FK guard missing!',
    );
    if (!error) {
      await admin.from('task_photo_waiver_attempts').delete()
        .eq('inbound_message_id', `wamid.CROSSFK.${run}`);
    }
  }
  {
    // open_task_review's FOURTH argument (0049). The function was DROPPED and
    // recreated to add it, which is exactly the kind of change that can lose a
    // guard by accident, so the cross-tenant attack of attack 9 is repeated
    // here THROUGH the new argument. taskIds[1] for attack 9's reason: task1
    // already carries the seeded review.
    const foreignTask = victim.taskIds[1];
    const { error } = await db.rpc('open_task_review', {
      p_task: foreignTask,
      p_worker: null,
      p_note: 'cross-tenant waived claim',
      p_photo_waived: true,
    });
    const { data: after } = await admin.from('tasks').select('status').eq('id', foreignTask).single();
    check(
      'adversarial: open a WAIVED review on a foreign task blocked',
      error != null && after?.status === 'pending',
      error ? `rejected (${error.code ?? 'err'}), victim task still ${after?.status}` : 'ACCEPTED — 0049 lost the guard',
    );
  }
  {
    // The tenant CAN read the flag on their own review, and that is not a
    // refusal check — it is the manager's whole surface for this feature. A
    // policy or grant that hid `photo_waived` would leave the board saying
    // "sem fotos anexadas" about a claim somebody was asked for twice, which
    // reads as ordinary rather than as the thing to go and look at.
    const { data, error } = await db
      .from('task_reviews')
      .select('id, photo_waived')
      .eq('id', attacker.reviewId)
      .maybeSingle();
    check(
      'positive control: a manager reads photo_waived on their own review',
      !error && data?.photo_waived === false,
      error ? error.message : `photo_waived ${String(data?.photo_waived)}`,
    );
  }

  // ── 0042 problem_reports (issue #120) ────────────────────────────────────
  // Write-only for tenants: an INSERT policy pins company_id to the caller's
  // own company and profile_id to auth.uid(), and the column-scoped grant
  // (company_id, profile_id, text, context) withholds worker_id and channel
  // entirely. Four refusals and a positive control — the refusals alone would
  // pass on a table nobody can write to, and then the app's report button
  // would be a form that swallows every report silently.

  // Attack: file a report into another company. company_id is what the policy
  // pins, so this is the whole cross-tenant claim.
  {
    const { error } = await db.from('problem_reports').insert({
      company_id: victim.companyId,
      profile_id: attacker.userId,
      text: 'forged cross-tenant report',
    });
    check(
      'adversarial: tenant cannot file a problem report into another company',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — cross-tenant report forgery',
    );
    if (!error) {
      await admin.from('problem_reports').delete()
        .eq('company_id', victim.companyId).eq('text', 'forged cross-tenant report');
    }
  }

  // Attack: file a report in a COLLEAGUE's name. profile_id = auth.uid() in
  // the policy is the reporter attribution — the operator reads these as "who
  // said the app is broken", and a forged reporter would put words in a real
  // colleague's mouth on a screen Federico acts on.
  {
    const { error } = await db.from('problem_reports').insert({
      company_id: attacker.companyId,
      profile_id: attacker.colleagueId,
      text: 'forged colleague report',
    });
    check(
      "adversarial: tenant cannot file a report in a colleague's name",
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — reporter attribution forgeable',
    );
    if (!error) {
      await admin.from('problem_reports').delete()
        .eq('company_id', attacker.companyId).eq('text', 'forged colleague report');
    }
  }

  // Attack: file a report AS A CREW MEMBER. worker_id is absent from the
  // column grant, so this is refused at the grant layer (42501) before the
  // policy is even consulted — a manager must not be able to put words in
  // their own crew's mouths either.
  {
    const { error } = await db.from('problem_reports').insert({
      company_id: attacker.companyId,
      worker_id: attacker.workerId,
      text: 'forged worker report',
    });
    check(
      "adversarial: tenant cannot file a report as a crew member (worker_id not granted)",
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — crew attribution forgeable',
    );
    if (!error) {
      await admin.from('problem_reports').delete()
        .eq('company_id', attacker.companyId).eq('text', 'forged worker report');
    }
  }

  // Attack: claim the WhatsApp channel from the app. channel is absent from
  // the grant and defaults to 'app'; the policy's channel = 'app' is the
  // belt-and-braces restatement.
  {
    const { error } = await db.from('problem_reports').insert({
      company_id: attacker.companyId,
      profile_id: attacker.userId,
      channel: 'whatsapp',
      text: 'forged channel report',
    });
    check(
      'adversarial: tenant cannot claim the whatsapp channel (channel not granted)',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — channel forgeable',
    );
    if (!error) {
      await admin.from('problem_reports').delete()
        .eq('company_id', attacker.companyId).eq('text', 'forged channel report');
    }
  }

  // POSITIVE CONTROL. Every check above asserts a refusal, so a dropped
  // policy or a revoked grant would pass all four while the app's report form
  // silently stopped working. Mirrors the server action EXACTLY
  // (apps/web/app/(app)/perfil/reportar/actions.ts): NO `.select()` chained —
  // problem_reports is write-only for a tenant, RETURNING needs the SELECT
  // nobody holds, and `.insert(...).select('id')` would be refused 42501 on a
  // perfectly healthy database (the ai_usage trap). The row is confirmed on
  // the service role, the only actor that can read this table at all.
  {
    const marker = `own report ${attacker.label} ${Date.now()}`;
    const { error } = await db.from('problem_reports').insert({
      company_id: attacker.companyId,
      profile_id: attacker.userId,
      text: marker,
      context: { source: 'app', screen: '/perfil/reportar' },
    });
    const { data: landed } = await admin
      .from('problem_reports')
      .select('id, channel')
      .eq('company_id', attacker.companyId)
      .eq('text', marker);
    check(
      'positive control: a manager CAN file their own report from the app',
      !error && (landed ?? []).length === 1 && landed[0].channel === 'app',
      error ? error.message : `${(landed ?? []).length} rows, channel=${landed?.[0]?.channel}`,
    );
    if ((landed ?? []).length > 0) {
      await admin.from('problem_reports').delete().in('id', landed.map(r => r.id));
    }
  }

  // ── 0042 problem_report_requests (issue #120) ────────────────────────────
  // Deny-all with every grant revoked — checkin_photo_requests' posture, and
  // the same three attacks for the same reasons. A row here says "this
  // person's next WhatsApp message is diverted into the report table": INSERT
  // arms that against a crew member of the attacker's choosing, UPDATE
  // repoints or immortalises an existing one, DELETE erases the trail.
  {
    const { error } = await db.from('problem_report_requests').insert({
      company_id: attacker.companyId,
      worker_id: attacker.helperWorkerId,
      expires_at: new Date(Date.now() + 1800_000).toISOString(),
    });
    check(
      'adversarial: tenant arming a report capture blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : "ACCEPTED — a tenant can divert a colleague's next message!",
    );
    if (!error) {
      await admin.from('problem_report_requests').delete()
        .eq('company_id', attacker.companyId).eq('worker_id', attacker.helperWorkerId);
    }
  }
  {
    const { error } = await db
      .from('problem_report_requests')
      .update({ expires_at: new Date(Date.now() + 86_400_000).toISOString() })
      .eq('id', attacker.reportRequestId);
    check(
      'adversarial: tenant immortalising a report capture blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — update grant leaked',
    );
  }
  {
    const { error } = await db
      .from('problem_report_requests')
      .delete()
      .eq('id', attacker.reportRequestId);
    check(
      'adversarial: tenant DELETE of a report capture blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — delete grant leaked',
    );
  }

  // ── 0043 worker_requests (issue #152) ────────────────────────────────────
  // READ-ONLY for tenants: a SELECT policy scoped to their own company, and NO
  // insert, update or delete policy or grant at all. Every write is the service
  // role (the WhatsApp webhook), so there is nothing a tenant needs a write for
  // — and each of the three writes below would be a specific lie:
  //
  //   INSERT — manufacture "a crew member asked for this". Attacker-chosen text
  //            attributed to a real, named person, rendered as a QUOTE on Home,
  //            in the inbox and on a colleague's WhatsApp. The forgery is not
  //            of a row, it is of somebody's words.
  //   UPDATE — rewrite what a crew member actually said, or move `needed_by` so
  //            an urgent request sinks to the bottom of the ranking.
  //   DELETE — erase the request entirely. The schema's only DELETE policy is
  //            still push_subscriptions (0026) and this must not become the
  //            second.
  //
  // The read half is covered by the per-company visibility loop above, which is
  // why there is no positive control here: `worker_requests` appears in that
  // list, so a policy that hid every request from its own company already fails
  // there. That is the pairing problem_reports could not have (it has no read
  // surface at all) and is why its block needs a positive control and this one
  // does not.
  {
    const { error } = await db.from('worker_requests').insert({
      company_id: attacker.companyId,
      worker_id: attacker.helperWorkerId,
      text: 'forged crew request',
    });
    check(
      'adversarial: tenant cannot forge a crew request',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : "ACCEPTED — a manager can put words in a crew member's mouth!",
    );
    if (!error) {
      await admin.from('worker_requests').delete()
        .eq('company_id', attacker.companyId).eq('text', 'forged crew request');
    }
  }
  {
    const { error } = await db.from('worker_requests').insert({
      company_id: victim.companyId,
      worker_id: victim.workerId,
      text: 'forged cross-tenant request',
    });
    check(
      'adversarial: tenant cannot file a crew request into another company',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — cross-tenant request forgery',
    );
    if (!error) {
      await admin.from('worker_requests').delete()
        .eq('company_id', victim.companyId).eq('text', 'forged cross-tenant request');
    }
  }
  {
    const { error } = await db
      .from('worker_requests')
      .update({ text: 'rewritten by the manager', needed_by: null })
      .eq('id', attacker.workerRequestId);
    check(
      "adversarial: tenant rewriting a crew member's own words blocked",
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — update grant leaked',
    );
    // Belt and braces: a policy-less UPDATE matches zero rows and reports
    // SUCCESS in PostgREST, so the refusal above must be checked against what
    // the row actually says. Read back on the service role — the tenant's own
    // read would be indistinguishable if the write had landed.
    {
      const { data } = await admin
        .from('worker_requests')
        .select('text')
        .eq('id', attacker.workerRequestId)
        .maybeSingle();
      check(
        "adversarial: the crew member's words are unchanged after that attempt",
        (data?.text ?? '') !== 'rewritten by the manager',
        JSON.stringify((data?.text ?? '').slice(0, 40)),
      );
    }
  }
  {
    const { error } = await db.from('worker_requests').delete().eq('id', attacker.workerRequestId);
    check(
      'adversarial: tenant DELETE of a crew request blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — delete grant leaked',
    );
    {
      const { data } = await admin
        .from('worker_requests')
        .select('id')
        .eq('id', attacker.workerRequestId)
        .maybeSingle();
      check(
        'adversarial: the crew request still exists after that attempt',
        data?.id === attacker.workerRequestId,
        data ? 'still there' : 'GONE — a request was deleted by a tenant',
      );
    }
  }

  // ── 0044 material_checks (issue #154) ────────────────────────────────────
  // The daily "is it on site?" walk-around tick. UNLIKE almost everything added
  // lately this table is tenant-WRITABLE — the manager ticks it from their own
  // browser on their own RLS-scoped client — so a deny-all sweep would prove
  // nothing here and a POSITIVE CONTROL is mandatory. A policy that refused
  // every tick would pass every refusal below while making the feature dead.
  //
  // What the three column-grant attacks each buy, and why the grant rather than
  // a policy is what refuses them:
  //   check_date — the day is PART OF THE UNIQUE KEY and is what makes the tick
  //                reset overnight by construction. A tenant that could name it
  //                could tick tomorrow, or backdate today's walk-around onto a
  //                site nobody visited.
  //   checked_by — attribution. Stamped from auth.uid() by a trigger, so "who
  //                said the cement was here" is unforgeable at the grant layer
  //                rather than in app code.
  //   material   — rewriting an existing row's identity relabels yesterday's
  //                answer as today's, about a different thing.
  //
  // Note the asymmetry to expect in the results: a cross-tenant INSERT is
  // refused by the policy (an error), while a cross-tenant UPDATE matches zero
  // rows through the policy's USING clause and reports SUCCESS. That is why the
  // update attack is verified by reading the row back on the SERVICE ROLE — the
  // tenant's own read cannot tell "refused" from "invisible".
  {
    const { error } = await db.from('material_checks').insert({
      company_id: attacker.companyId, job_id: attacker.jobId,
      material: 'matrix positive control', status: 'on_site',
    });
    check(
      'control: the owner can tick their own material (positive control)',
      error == null,
      error ? `REFUSED (${error.code ?? 'err'}) — the feature is dead` : 'accepted',
    );
  }
  {
    const { data, error } = await db.from('material_checks').select('*');
    const rows = data ?? [];
    const foreign = rows.filter(r => r.company_id !== attacker.companyId);
    check(
      'control: the owner reads their own ticks, and only their own (positive control)',
      !error && rows.length > 0 && foreign.length === 0,
      error ? error.message : `${rows.length} rows, ${foreign.length} foreign`,
    );
  }
  {
    // The day must come from lisbon_today(), never from the client.
    const { error } = await db.from('material_checks').insert({
      company_id: attacker.companyId, job_id: attacker.jobId,
      material: 'backdated tick', status: 'on_site', check_date: '2000-01-01',
    });
    check(
      'adversarial: tenant naming check_date blocked (the nightly reset)',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — a tenant can tick any day it likes',
    );
    if (!error) {
      await admin.from('material_checks').delete()
        .eq('company_id', attacker.companyId).eq('material', 'backdated tick');
    }
  }
  {
    const { error } = await db.from('material_checks').insert({
      company_id: attacker.companyId, job_id: attacker.jobId,
      material: 'forged attribution', status: 'on_site', checked_by: victim.userId,
    });
    check(
      'adversarial: tenant forging checked_by blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — who walked the site is forgeable',
    );
    if (!error) {
      await admin.from('material_checks').delete()
        .eq('company_id', attacker.companyId).eq('material', 'forged attribution');
    }
  }
  {
    const { error } = await db.from('material_checks').insert({
      company_id: victim.companyId, job_id: victim.jobId,
      material: 'cross-tenant tick', status: 'missing',
    });
    check(
      "adversarial: tenant ticking another company's obra blocked",
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — cross-tenant tick',
    );
    if (!error) {
      await admin.from('material_checks').delete()
        .eq('company_id', victim.companyId).eq('material', 'cross-tenant tick');
    }
  }
  {
    // company_id honest, job_id a stranger's — RLS passes and only the 0044 FK
    // trigger can refuse. Same seam as attack 1 on `tasks`.
    const { error } = await db.from('material_checks').insert({
      company_id: attacker.companyId, job_id: victim.jobId,
      material: 'foreign obra tick', status: 'on_site',
    });
    check(
      'adversarial: tick → foreign obra blocked by the FK trigger',
      error?.code === '23514',
      error ? `code=${error.code}` : 'ACCEPTED — a tick naming another tenant\'s site',
    );
    if (!error) {
      await admin.from('material_checks').delete()
        .eq('company_id', attacker.companyId).eq('material', 'foreign obra tick');
    }
  }
  {
    // Rewriting the identity of an existing own-company row. `status` is the
    // ONLY column the UPDATE grant reaches.
    const { data: mine } = await admin.from('material_checks')
      .select('id').eq('company_id', attacker.companyId)
      .eq('material', 'matrix positive control').maybeSingle();
    if (mine?.id) {
      const { error } = await db.from('material_checks')
        .update({ material: 'relabelled', check_date: '2000-01-01' })
        .eq('id', mine.id);
      check(
        "adversarial: tenant rewriting a tick's material/day blocked",
        error != null,
        error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — update grant is too wide',
      );
      const { data: after } = await admin.from('material_checks')
        .select('material').eq('id', mine.id).maybeSingle();
      check(
        'adversarial: the tick still names what it named',
        (after?.material ?? '') === 'matrix positive control',
        JSON.stringify((after?.material ?? '').slice(0, 40)),
      );
    }
  }
  {
    const { error } = await db.from('material_checks').delete().eq('company_id', attacker.companyId);
    check(
      'adversarial: tenant DELETE of a tick blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — delete grant leaked',
    );
  }

  // ── 0039 worker_day_links (issue #114) ───────────────────────────────────
  // The crew day page's bearer token. Deny-all with every grant revoked, so
  // these are grant-layer checks — but what they protect is unlike every other
  // deny-all table here: a row IS a credential, not a record of one.
  //
  // Four attacks, and each buys something different:
  //   READ  a colleague's token — a working, session-less read of that person's
  //         live work from any browser until Lisbon midnight.
  //   INSERT a token of the attacker's choosing pointed at a worker — the same
  //         thing, minted on demand and never sent over WhatsApp at all, so the
  //         crew member has no way to know it exists.
  //   UPDATE an existing row's expires_at — a link that never dies.
  //   DELETE the row — no trail.
  //
  // The read is aimed CROSS-TENANT and the three writes at the attacker's OWN
  // company, for the reason the checkin_photo_requests block gives: a
  // cross-tenant write would be refused for the wrong reason (the FK trigger
  // rather than the grant), and would pass while the grant leaked.
  {
    const { data, error } = await db
      .from('worker_day_links')
      .select('company_id, worker_id')
      .eq('token', victim.dayLinkToken);
    check(
      'adversarial: reading another tenant\'s crew day token blocked',
      ...readIsDenied(data, error),
    );
  }
  {
    const forged = randomBytes(32).toString('base64url');
    const { error } = await db.from('worker_day_links').insert({
      token: forged,
      company_id: attacker.companyId,
      worker_id: attacker.workerId,
      link_date: '2026-01-06',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    check(
      'adversarial: tenant minting its own crew day token blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — a tenant can mint a page credential!',
    );
    if (!error) await admin.from('worker_day_links').delete().eq('token', forged);
  }
  {
    const { error } = await db
      .from('worker_day_links')
      .update({ expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString() })
      .eq('token', attacker.dayLinkToken);
    check(
      'adversarial: tenant extending its own crew day token blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — a tenant can make a link immortal',
    );
  }
  {
    const { error } = await db
      .from('worker_day_links')
      .delete()
      .eq('token', attacker.dayLinkToken);
    check(
      'adversarial: tenant DELETE of its own crew day token blocked',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — delete grant leaked',
    );
  }
  // The cross-company FK trigger, which is the seam RLS cannot see: a row whose
  // company_id is honest and whose worker_id belongs to another tenant would
  // name a stranger's crew member and hand out a page scoped to the attacker's
  // own company. Attacked on the SERVICE ROLE, because the grant layer already
  // stops a tenant getting this far — and the trigger has to hold for the cron,
  // which is the only writer there actually is.
  {
    const { error } = await admin.from('worker_day_links').insert({
      token: randomBytes(32).toString('base64url'),
      company_id: attacker.companyId,
      worker_id: victim.workerId,
      link_date: '2026-01-07',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    check(
      'adversarial: cross-company crew day token blocked by the FK trigger',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — a token can name another tenant\'s worker!',
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

  // ── 0028: claiming another tenant's worker identity ───────────────────────
  // The row is ENTIRELY well-formed as a tenant row: company_id is the
  // attacker's own, so workers_insert_company passes and RLS has nothing to
  // say. The only thing standing between this and a successful write is the
  // column INSERT grant — which is why this is a grant-layer check aimed at
  // the attacker's OWN company, not a cross-tenant boundary check.
  //
  // What it would buy an attacker if it landed is worth stating, because it is
  // NOT data: handleWorkerReply resolves a BSUID with .limit(2) and answers
  // neither party on two matches, so a forged row silences the victim's
  // replies rather than redirecting them. A denial of service against one
  // worker's inbound messages, not a leak. Closing the grant demotes the
  // .limit(2) guard from load-bearing to defence in depth; it stays either way,
  // because workers.whatsapp_user_id carries no unique constraint and the
  // service role can still produce a duplicate.
  //
  // Assert the victim's row is untouched as well as the error: a refusal that
  // somehow still wrote would be the worst possible pass.
  {
    const { error } = await db.from('workers').insert({
      company_id: attacker.companyId,
      name: 'Forged identity',
      whatsapp_user_id: victim.workerBsuid,
    });
    const { data: claimants } = await admin
      .from('workers')
      .select('id')
      .eq('whatsapp_user_id', victim.workerBsuid);
    check(
      "adversarial: tenant cannot claim another worker's WhatsApp identity",
      error != null && (claimants ?? []).length === 1,
      error
        ? `rejected (${error.code ?? 'err'})`
        : `ACCEPTED — ${(claimants ?? []).length} crew rows now claim that identity`,
    );
    if (!error) {
      await admin.from('workers').delete()
        .eq('company_id', attacker.companyId).eq('name', 'Forged identity');
    }
  }

  // POSITIVE CONTROL. Every check in this file asserts a REFUSAL, so revoking
  // the INSERT grant outright — the exact way 0028 can go wrong — would pass
  // the attack above and leave a manager unable to add anyone to their crew.
  // This is the `add_worker` shape verbatim, consent timestamp included:
  // #39's own suggested column list omitted whatsapp_opt_in_at, and without
  // this control that omission would have shipped green.
  {
    const { data, error } = await db.from('workers').insert({
      company_id: attacker.companyId,
      name: 'Novo membro',
      trade: 'pedreiro',
      phone: '+351912345678',
      whatsapp_opt_in_at: new Date().toISOString(),
    }).select('id').single();
    check(
      'adversarial: manager can still add a crew member with consent (positive control)',
      !error && data?.id != null,
      error ? `REFUSED (${error.code ?? 'err'}) — add_worker is broken` : 'accepted',
    );
    if (data?.id) await admin.from('workers').delete().eq('id', data.id);
  }

  // ── ai_usage, the token ledger (0032, issue #53) ──────────────────────────
  // The one ledger in the schema with a tenant policy, and the only reason it
  // has one is WHERE the write happens: inside a tenant's own request, on that
  // tenant's own RLS-scoped client. So the boundary here is not "no tenant may
  // touch this table" — it is "a tenant may add rows for THEMSELVES, and read
  // nothing at all". Four checks and a positive control.

  // Attack: write another company's spend. company_id is the only thing the
  // INSERT policy constrains, so this is the entire cross-tenant claim.
  {
    const { error } = await db.from('ai_usage').insert({
      company_id: victim.companyId,
      actor: 'system',
      surface: 'manager_chat',
      model_role: 'conversation',
      model_id: 'claude-sonnet-5',
      provider: 'anthropic',
      input_tokens: 999999,
    });
    check(
      "adversarial: tenant cannot file spend against another company",
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — cross-tenant cost forgery',
    );
    if (!error) {
      await admin.from('ai_usage').delete()
        .eq('company_id', victim.companyId).eq('input_tokens', 999999);
    }
  }

  // Attack: own company, but blaming another tenant's manager. RLS checks the
  // row's OWN company_id and never the company of the rows its foreign keys
  // point at — the ai_usage_fks_same_company trigger is the only thing here.
  {
    const { error } = await db.from('ai_usage').insert({
      company_id: attacker.companyId,
      actor: 'manager',
      profile_id: victim.userId,
      surface: 'manager_chat',
      model_role: 'conversation',
      model_id: 'claude-sonnet-5',
      provider: 'anthropic',
      input_tokens: 999998,
    });
    check(
      "adversarial: ai_usage cannot name a foreign profile (FK guard trigger)",
      error?.code === '23514',
      error ? `code=${error.code}` : 'INSERT SUCCEEDED (cross-company attribution)',
    );
    if (!error) {
      await admin.from('ai_usage').delete()
        .eq('company_id', attacker.companyId).eq('input_tokens', 999998);
    }
  }

  // Attack: read the ledger. There is NO select policy, so even a tenant's OWN
  // rows are invisible — cost comparison across companies is an operator
  // question and lives behind the operator deploy.
  //
  // Every forgery above was refused, so at this point the table holds nothing
  // for either tenant and a naive read check would report green against an
  // empty table, proving nothing. Seed one row for EACH side on the service
  // role first — the attacker's own included, since "your own rows are hidden
  // too" is the specific claim.
  {
    const seeded = [attacker, victim].map(t => ({
      company_id: t.companyId,
      actor: 'system',
      surface: 'manager_chat',
      model_role: 'conversation',
      model_id: 'claude-sonnet-5',
      provider: 'anthropic',
      input_tokens: 999996,
    }));
    const { data: rows, error: seedError } = await admin.from('ai_usage').insert(seeded).select('id');
    const { data, error } = await db.from('ai_usage').select('id, company_id');
    // Two conditions, and BOTH matter. The seed must have worked (2 rows, one
    // per tenant) or this proves nothing — a table nobody could write to would
    // read as empty and pass. Then the tenant's read must be denied, in either
    // of the two legitimate shapes readIsDenied accepts; here it is the 42501
    // one, because ai_usage revokes SELECT from `authenticated` outright.
    const [denied, deniedDetail] = readIsDenied(data, error);
    const seeded2 = !seedError && (rows ?? []).length === 2;
    check(
      'adversarial: tenant cannot read ai_usage at all, own rows included (no SELECT policy)',
      seeded2 && denied,
      seedError
        ? `seed failed (${seedError.message}) — check is untestable`
        : !seeded2
          ? `seeded ${(rows ?? []).length} rows, wanted 2 — check is untestable`
          : deniedDetail,
    );
    if ((rows ?? []).length > 0) {
      await admin.from('ai_usage').delete().in('id', rows.map(r => r.id));
    }
  }

  // Attack: backdate spend out of the current reporting period. `usage_date` is
  // absent from the column-scoped INSERT grant and defaults to lisbon_today(),
  // which is what makes "the last 30 days" mean the same thing to the ledger as
  // it does to the board.
  {
    const { error } = await db.from('ai_usage').insert({
      company_id: attacker.companyId,
      actor: 'system',
      surface: 'manager_chat',
      model_role: 'conversation',
      model_id: 'claude-sonnet-5',
      provider: 'anthropic',
      input_tokens: 999997,
      usage_date: '2020-01-01',
    });
    check(
      'adversarial: tenant cannot backdate their own spend (usage_date not granted)',
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — spend can be hidden in the past',
    );
    if (!error) {
      await admin.from('ai_usage').delete()
        .eq('company_id', attacker.companyId).eq('input_tokens', 999997);
    }
  }

  // POSITIVE CONTROL. Every check above asserts a REFUSAL, so a table with the
  // INSERT policy dropped, or the grant revoked, would pass all four — and the
  // whole cost dashboard would silently stop filling up, because
  // packages/core/src/agent/usage.ts swallows the rejection by design. This is
  // the shape handleInbound actually writes.
  {
    // NO `.select()` here, and that is the whole point of this check rather
    // than an incidental detail. `ai_usage` is WRITE-ONLY for a tenant: the
    // INSERT policy exists, the SELECT grant does not. supabase-js only asks
    // PostgREST to return the inserted row when you chain `.select()`, and that
    // RETURNING clause needs SELECT — so `.insert(...).select('id')` is refused
    // 42501 on a perfectly healthy database, while the write itself succeeds.
    //
    // This check therefore mirrors packages/core/src/agent/usage.ts EXACTLY —
    // `const { error } = await db.from('ai_usage').insert({...})` — and proves
    // the row landed by reading it back on the SERVICE ROLE, which is the only
    // actor that can see this table at all. Asserting on the tenant's own view
    // is impossible here by construction.
    const marker = 40000 + Math.floor(Math.random() * 10000);
    const { error } = await db.from('ai_usage').insert({
      company_id: attacker.companyId,
      actor: 'manager',
      profile_id: attacker.userId,
      surface: 'manager_chat',
      model_role: 'conversation',
      model_id: 'claude-sonnet-5',
      provider: 'anthropic',
      input_tokens: 300,
      output_tokens: 120,
      cache_read_tokens: marker,
      cache_write_tokens: 0,
    });
    const { data: landed } = await admin
      .from('ai_usage')
      .select('id')
      .eq('company_id', attacker.companyId)
      .eq('cache_read_tokens', marker);
    const wrote = (landed ?? []).length;
    check(
      'adversarial: a real turn can still record its own usage (positive control)',
      !error && wrote === 1,
      error
        ? `REFUSED (${error.code ?? 'err'}) — the cost ledger records NOTHING`
        : `accepted, ${wrote} row written`,
    );
    for (const row of landed ?? []) await admin.from('ai_usage').delete().eq('id', row.id);
  }

  // ── 0035: collaborators (issue #44) ───────────────────────────────────────
  // task_assignees answers "who else is on this task", which decides who gets a
  // 07:00 WhatsApp message naming another company's obra, address and
  // materials. A leak here is not an abstract row read — it is a crew member of
  // company A being told, in writing, where company B is working tomorrow.
  //
  // The table is SELECT-only for tenants (0018's posture, not the uniform
  // three-policy one), and the single writer is set_task_collaborators, which
  // is SECURITY DEFINER — so RLS does NOT cover the write path and its internal
  // auth.uid() check is the entire tenant boundary. Same class as
  // resolve_task_review and revert_translation_batch, and attacked the same way:
  // never on the error alone, always on the victim's rows too.

  // Attack 32 (RPC, cross-tenant): put my own worker on THEIR task.
  {
    const { error } = await db.rpc('set_task_collaborators', {
      p_task: victim.taskIds[0],
      p_workers: [attacker.workerId],
    });
    const { data: after } = await admin
      .from('task_assignees')
      .select('worker_id, role')
      .eq('task_id', victim.taskIds[0]);
    const rows = after ?? [];
    // The victim's task must still carry exactly its seeded pair: the mirrored
    // lead and the one helper. Asserting the COUNT and the attacker's absence,
    // because a call that wiped the victim's helpers and wrote nothing would
    // otherwise pass "the attacker is not there".
    const intact = rows.length === 2 && !rows.some(r => r.worker_id === attacker.workerId);
    check(
      'adversarial: set_task_collaborators on a foreign task blocked',
      error != null && intact,
      error == null
        ? 'RPC SUCCEEDED (cross-tenant crew write!)'
        : !intact
          ? `victim task now has ${rows.length} assignee row(s) — mutated`
          : `rejected (${error.code ?? 'err'})`,
    );
  }

  // Attack 33 (FK guard trigger): my OWN task, THEIR worker. RLS has nothing to
  // say — the row's company_id is the attacker's own — and the RPC's tenant
  // check passes for the same reason. Only
  // private.assert_task_assignee_fks_same_company refuses it, which is the
  // exact hole 0009 exists to close and the reason 0035 carries its own copy.
  //
  // What it would buy if it landed: the victim's crew member starts receiving
  // the attacker's 07:00 briefings, addresses included.
  {
    const { error } = await db.rpc('set_task_collaborators', {
      p_task: attacker.taskIds[1],
      p_workers: [victim.workerId],
    });
    const { data: after } = await admin
      .from('task_assignees')
      .select('worker_id')
      .eq('task_id', attacker.taskIds[1]);
    const leaked = (after ?? []).some(r => r.worker_id === victim.workerId);
    check(
      "adversarial: collaborator → another company's worker blocked by the 0035 FK trigger",
      error != null && !leaked,
      error == null
        ? 'RPC SUCCEEDED (foreign worker on my task!)'
        : leaked
          ? "ACCEPTED — victim's worker is on the attacker's task"
          : `rejected (${error.code ?? 'err'})`,
    );
  }

  // Attack 34 (grant layer): bypass the RPC entirely. task_assignees has NO
  // insert grant for `authenticated` and no insert policy, so a direct write is
  // refused before any trigger runs. Aimed at the attacker's OWN task on
  // purpose — this is a grant check, not a boundary check, and the thing it
  // protects is the LEAD MIRROR: a tenant able to insert here could write a
  // `role = 'lead'` row naming somebody who is not the assignee, which is the
  // one disagreement 0035's whole design is built to make impossible.
  {
    const { error } = await db.from('task_assignees').insert({
      company_id: attacker.companyId,
      task_id: attacker.taskIds[1],
      worker_id: attacker.helperWorkerId,
      role: 'lead',
    });
    const { data: after } = await admin
      .from('task_assignees')
      .select('id')
      .eq('task_id', attacker.taskIds[1]);
    check(
      'adversarial: direct INSERT into task_assignees blocked (the lead mirror is unforgeable)',
      error != null && (after ?? []).length === 0,
      error
        ? `rejected (${error.code ?? 'err'})`
        : `INSERT SUCCEEDED — ${(after ?? []).length} row(s) written by hand`,
    );
    if (!error) await admin.from('task_assignees').delete().eq('task_id', attacker.taskIds[1]);
  }

  // Attack 35 (grant layer): and no DELETE either — on the victim's rows, so
  // this is a boundary check as well as a grant one. There is no DELETE policy
  // on this table (push_subscriptions remains the schema's only one), so a
  // tenant cannot quietly erase the record of who was on a job.
  {
    const { error } = await db.from('task_assignees').delete().eq('task_id', victim.taskIds[0]);
    const { data: after } = await admin
      .from('task_assignees')
      .select('id')
      .eq('task_id', victim.taskIds[0]);
    check(
      "adversarial: tenant DELETE of another company's task_assignees blocked",
      (after ?? []).length === 2,
      error
        ? `rejected (${error.code ?? 'err'})`
        : `${(after ?? []).length} rows remain (expected 2)`,
    );
  }

  // POSITIVE CONTROL. Every check above asserts a REFUSAL, so a migration that
  // revoked EXECUTE from `authenticated` — or a trigger that rejected every
  // row — would pass all four while making the feature completely unusable
  // from the app. The owner must still be able to set their own crew.
  //
  // Runs last in this section and cleans up after itself, so the visibility
  // sweep's expected row counts are unaffected.
  {
    const { error } = await db.rpc('set_task_collaborators', {
      p_task: attacker.taskIds[1],
      p_workers: [attacker.helperWorkerId],
    });
    const { data: after } = await admin
      .from('task_assignees')
      .select('worker_id, role')
      .eq('task_id', attacker.taskIds[1]);
    const rows = after ?? [];
    check(
      'adversarial: owner can still set collaborators on their OWN task (positive control)',
      !error && rows.length === 1 && rows[0].role === 'collaborator',
      error ? `REFUSED (${error.code ?? 'err'}) — the feature is unusable` : `${rows.length} row(s)`,
    );
    await admin.from('task_assignees').delete().eq('task_id', attacker.taskIds[1]);
  }

  // ── the schedule and the run log (0036, issue #51) ───────────────────────
  // Two new tenant-writable/readable surfaces, and they are deliberately
  // asymmetric: a manager MAY move their own send hour (it is the whole
  // feature) and may NEVER write a run row (that is the cron's record of what
  // it actually did, and a forgeable one is worthless as evidence).

  // Moving ANOTHER company's morning message. RLS's with-check on company_id is
  // the whole guard here, and the consequence of it failing is not a leak but a
  // sabotage: a competitor's crew silently stops being briefed, or is briefed
  // at 21:00.
  {
    const { error } = await db.from('company_schedules').insert({
      company_id: victim.companyId, job_kind: 'task_checkin', send_hour: 21, enabled: false,
    });
    const { data: after } = await admin
      .from('company_schedules')
      .select('id')
      .eq('company_id', victim.companyId)
      .eq('job_kind', 'task_checkin');
    check(
      "adversarial: writing another company's schedule blocked",
      error != null && (after ?? []).length === 0,
      error == null ? 'INSERT SUCCEEDED (cross-tenant schedule sabotage!)' : `rejected (${error.code ?? 'err'})`,
    );
  }

  // Switching off another company's existing briefing. The seeded row is
  // daily_briefing, so a fall-open here would silence a whole crew.
  {
    await db
      .from('company_schedules')
      .update({ enabled: false, send_hour: 21 })
      .eq('company_id', victim.companyId);
    const { data: after } = await admin
      .from('company_schedules')
      .select('enabled, send_hour')
      .eq('company_id', victim.companyId)
      .eq('job_kind', 'daily_briefing')
      .single();
    check(
      "adversarial: switching off another company's briefing blocked",
      after?.enabled === true && after?.send_hour === 7,
      after ? `enabled=${after.enabled} send_hour=${after.send_hour}` : 'row missing',
    );
  }

  // `updated_by` is stamped by a trigger from auth.uid() and is ABSENT from the
  // tenant's column grant, so "who moved the crew's morning" cannot be
  // attributed to somebody else. Aimed at the attacker's OWN row: this is not a
  // tenant-boundary question, it is a forgery question, and it must fail even
  // inside your own company.
  {
    const { error } = await db
      .from('company_schedules')
      .update({ updated_by: victim.userId })
      .eq('company_id', attacker.companyId);
    const { data: after } = await admin
      .from('company_schedules')
      .select('updated_by')
      .eq('company_id', attacker.companyId)
      .single();
    check(
      'adversarial: forging who last changed a schedule blocked',
      error != null || after?.updated_by !== victim.userId,
      error ? `rejected (${error.code ?? 'err'})` : `updated_by=${after?.updated_by}`,
    );
  }

  // Manufacturing a morning that never happened, in your own company. cron_runs
  // is SELECT-only for tenants: it is the answer to "did Capo actually message
  // my crew today?", and a row a tenant can write is not an answer to anything.
  {
    const { error } = await db.from('cron_runs').insert({
      company_id: attacker.companyId, job_kind: 'daily_briefing', run_date: '2026-01-06',
      due_hour: 7, ran_hour: 7, messaged: 99,
    });
    const { data: after } = await admin
      .from('cron_runs')
      .select('id')
      .eq('company_id', attacker.companyId)
      .eq('run_date', '2026-01-06');
    check(
      'adversarial: forging a cron run row blocked',
      error != null && (after ?? []).length === 0,
      error == null ? 'INSERT SUCCEEDED (a run that never happened!)' : `rejected (${error.code ?? 'err'})`,
    );
  }

  // Editing the evidence: rewriting how many people a real run reached.
  {
    await db.from('cron_runs').update({ messaged: 42 }).eq('company_id', attacker.companyId);
    const { data: after } = await admin
      .from('cron_runs')
      .select('messaged')
      .eq('company_id', attacker.companyId)
      .single();
    check(
      'adversarial: rewriting a cron run row blocked',
      after?.messaged === 1,
      `messaged=${after?.messaged} (expected 1)`,
    );
  }

  // POSITIVE CONTROL. Every schedule check above asserts a REFUSAL, so a
  // migration that granted nothing would pass all of them while making
  // /perfil/automacoes a screen whose Save button never works. The owner must
  // still be able to move their OWN send hour, and it is restored immediately
  // so the visibility sweep's expectations are unaffected.
  {
    const { error } = await db
      .from('company_schedules')
      .update({ send_hour: 8 })
      .eq('company_id', attacker.companyId)
      .eq('job_kind', 'daily_briefing');
    const { data: after } = await admin
      .from('company_schedules')
      .select('send_hour, updated_by')
      .eq('company_id', attacker.companyId)
      .eq('job_kind', 'daily_briefing')
      .single();
    check(
      'adversarial: owner can still move their OWN send hour (positive control)',
      !error && after?.send_hour === 8,
      error ? `REFUSED (${error.code ?? 'err'}) — the screen is unusable` : `send_hour=${after?.send_hour}`,
    );
    // And the trigger attributed it to the person who actually did it, without
    // the client ever naming the column.
    check(
      'adversarial: the schedule records WHO changed it, unforgeably (positive control)',
      after?.updated_by === attacker.userId,
      `updated_by=${after?.updated_by}`,
    );
    await admin
      .from('company_schedules')
      .update({ send_hour: 7 })
      .eq('company_id', attacker.companyId)
      .eq('job_kind', 'daily_briefing');
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
  //
  // Since #47 there is a SECOND source of worker-authored text carrying the
  // same tracer — task_reviews.note, seeded above. That matters because #47
  // gave the system three new reasons to write into `messages`: the 07:00
  // briefing note, the late-afternoon check-in note, and one note per crew
  // member who taps an answer to it. Those notes are allowed to carry counts,
  // crew NAMES (which the manager typed) and which of two buttons was tapped.
  // They are not allowed to carry a syllable the worker wrote — because
  // `messages` is what thread.recentUserTexts reads, and that is the evidence
  // pool the write guard authorizes a direct manager-level write against.
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

  // Second positive control (issue #47): the tracer really is in the review
  // note too. Without this, a change that stopped passing p_note through would
  // make every "worker text never reaches X" check below pass for the wrong
  // reason — there would simply be no worker text on that path to find.
  {
    const { data } = await admin
      .from('task_reviews')
      .select('note')
      .eq('id', tenant.reviewId)
      .maybeSingle();
    check(
      `${L}: the review note IS worker-authored text (positive control)`,
      (data?.note ?? '').includes(secret),
      JSON.stringify(data?.note ?? null),
    );
  }

  // Third positive control (issue #120): the tracer really is in the worker's
  // problem report too. A report is the third seeded source of worker-authored
  // text — after the worker thread and the review note — and without this
  // assertion, a change that stopped writing report text (or wrote it
  // elsewhere) would make every sweep below pass for the wrong reason.
  {
    const { data } = await admin
      .from('problem_reports')
      .select('text')
      .eq('id', tenant.problemReportId)
      .maybeSingle();
    check(
      `${L}: the problem report IS worker-authored text (positive control)`,
      (data?.text ?? '').includes(secret),
      JSON.stringify(data?.text ?? null),
    );
  }

  // Fourth positive control (issue #152): the tracer really is in the crew
  // member's REQUEST too. This one is the most load-bearing of the four,
  // because a request is deliberately SHOWN to the manager — quoted on Home, in
  // the inbox and on WhatsApp — and "shown to the manager" is one careless step
  // away from "written into the manager's agent context". The obvious such step
  // is the chat-thread note the webhook writes for every request: it is allowed
  // to carry a crew NAME and a date, and the day somebody adds "…and this is
  // what they said" to it, the `messages` sweep below fails.
  {
    const { data } = await admin
      .from('worker_requests')
      .select('text')
      .eq('id', tenant.workerRequestId)
      .maybeSingle();
    check(
      `${L}: the crew request IS worker-authored text (positive control)`,
      (data?.text ?? '').includes(secret),
      JSON.stringify(data?.text ?? null),
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
/**
 * ── THE GUIDED MENU'S TENANT BOUNDARY (issue #49) ──────────────────────────
 *
 * The odd one out in this file, alongside checkWorkerTextIsolation, and worth
 * saying why out loud: it asserts a filter in TypeScript, not a policy in
 * Postgres, and it runs on the SERVICE ROLE on purpose.
 *
 * A crew member taps a row of a WhatsApp list and gets that task's address,
 * description and materials back. The webhook is a system caller — auth.uid()
 * is null — so RLS enforces NOTHING on that read. The entire boundary is the
 * shape of the query the menu runs: `task_board` scoped by the company_id AND
 * assignee_worker_id that the sender's PHONE (or BSUID) resolved to, and then
 * the tapped id looked for INSIDE that result rather than queried directly.
 *
 * So this reproduces that query verbatim, on the service role, and asserts that
 * neither another company's task nor a COLLEAGUE's task in the same company can
 * come back through it. It cannot import loadWorkerTasks (this file is plain
 * .mjs, run by node, with no TypeScript loader), which means the query below is
 * a COPY and can drift from the real one. That is stated rather than hidden: if
 * apps/web/app/notifications/worker-menu.ts ever changes how it scopes the
 * read, this check must change with it, and the review that changes one should
 * grep for the other.
 *
 * The colleague half is the one that would otherwise be missed. Every other
 * check in this file asks about two COMPANIES; here the interesting attacker is
 * somebody in the same company holding a valid uuid for a task that is not
 * theirs, and only `assignee_worker_id` refuses them.
 */
async function checkWorkerMenuScope(attacker, victim) {
  const L = attacker.label;

  const menuRead = async (companyId, workerId) => {
    const { data, error } = await admin
      .from('task_board')
      .select('*')
      .eq('company_id', companyId)
      .eq('assignee_worker_id', workerId)
      .eq('is_open', true)
      .limit(40);
    return { rows: data ?? [], error };
  };

  // POSITIVE CONTROL. Every check below asserts an ABSENCE, so a query that
  // returned nothing at all would pass all of them — the trap this file's
  // header warns about. This proves the read works for its owner first.
  const own = await menuRead(attacker.companyId, attacker.workerId);
  check(
    `${L}: the worker menu read returns this worker's OWN tasks (positive control)`,
    !own.error && own.rows.length > 0,
    own.error ? own.error.message : `${own.rows.length} rows`,
  );

  // Cross-tenant: the victim's task ids must not appear, so a tapped row id
  // belonging to another company can never be FOUND and therefore never
  // rendered.
  {
    const ids = own.rows.map(r => r.id);
    const leaked = victim.taskIds.filter(id => ids.includes(id));
    check(
      `${L}: the worker menu never surfaces another company's task`,
      leaked.length === 0,
      leaked.length ? `LEAKED ${leaked.join(', ')}` : 'none',
    );
  }

  // Same company, different crew member. The company_id filter alone would pass
  // this; only assignee_worker_id refuses it.
  {
    const colleague = await menuRead(attacker.companyId, victim.workerId);
    check(
      `${L}: the worker menu never surfaces a colleague's task`,
      !colleague.error && colleague.rows.length === 0,
      colleague.error ? colleague.error.message : `${colleague.rows.length} rows`,
    );
  }

  // And the cross-product: the victim's worker id read against the attacker's
  // company must be empty in both directions, which is what makes a forged pair
  // useless rather than merely unlikely.
  {
    const crossed = await menuRead(victim.companyId, attacker.workerId);
    check(
      `${L}: a mismatched company/worker pair returns nothing`,
      !crossed.error && crossed.rows.length === 0,
      crossed.error ? crossed.error.message : `${crossed.rows.length} rows`,
    );
  }
}

/**
 * company_send_history (0036, issue #51) — THE NEWEST READ SURFACE IN THE
 * SCHEMA, and the one that needs the most care.
 *
 * `notification_log` is RLS-enabled with DELIBERATELY ZERO POLICIES: it is the
 * outbound send ledger, written by the cron on the service role, and until this
 * migration no tenant could read a single row of it. The Cron jobs screen needs
 * one — "who got this morning's message, and what did Meta say?" — so 0036 adds
 * exactly one window, a SECURITY DEFINER function scoped to auth.uid()'s
 * company.
 *
 * SECURITY DEFINER means RLS does NOT apply inside it. The auth.uid() and
 * company checks are therefore the ENTIRE tenant boundary, the same shape (and
 * the same danger) as open_task_review, revert_translation_batch and
 * set_task_collaborators — all of which are attacked in this file for the same
 * reason.
 *
 * FOUR things are asserted here, and the FIRST is the one this file's own
 * header warns about: every other check in the suite asserts an ABSENCE, so a
 * function that returned nothing to anybody would pass all of them while
 * silently breaking the screen. The positive control is what makes the three
 * refusals mean something.
 */
/**
 * Memory scope (0037, issue #48) — the SECOND per-profile relation in the
 * schema, and the first one that a model writes to unattended.
 *
 * Until 0037 every memory belonged to the company and the policies 0007
 * generated in a loop were correct. A memory can now belong to ONE PROFILE, and
 * a colleague is in your company — so the company predicate alone is no longer a
 * boundary. This is the same trap `notifications` (0024) has, with a worse
 * payoff: a memory is injected into the manager's agent context on every single
 * turn, so a leaked one is not a row somebody could go and find, it is a
 * sentence Capo reads out.
 *
 * ── THE POSITIVE CONTROL IS NOT OPTIONAL HERE ──────────────────────────────
 * Every other assertion in this file is a REFUSAL, so a policy that denied
 * everybody would pass all of them — and for this table "denied everybody" has a
 * plausible failure mode: `profile_id = auth.uid()` without the `profile_id is
 * null or` in front of it hides every company memory ever written, silently, and
 * Capo simply forgets the business. So the owner's own reads and their own
 * "forget" are asserted too.
 */
async function checkMemoryScope(self, other) {
  const db = self.client;
  const L = self.label;

  // ── POSITIVE CONTROL: the two scopes the owner MUST see ──────────────────
  {
    const { data, error } = await db.from('memories').select('id, profile_id').eq('active', true);
    const ids = new Set((data ?? []).map(r => r.id));
    check(
      `${L}: the owner reads their company's shared memories (positive control)`,
      !error && ids.has(self.companyMemoryId),
      error ? error.message : `${ids.size} rows`,
    );
    check(
      `${L}: the owner reads their OWN personal memory (positive control)`,
      !error && ids.has(self.ownMemoryId),
      error ? error.message : `${ids.size} rows`,
    );

    // ── THE ATTACK THE COLLEAGUE EXISTS FOR ────────────────────────────────
    check(
      `${L}: a colleague's PERSONAL memory is invisible to the owner`,
      !ids.has(self.colleagueMemoryId),
      ids.has(self.colleagueMemoryId) ? 'LEAKED — per-profile scoping broken' : 'hidden',
    );
    // And the ordinary tenant boundary, for completeness.
    check(
      `${L}: another company's memories are invisible`,
      !ids.has(other.companyMemoryId) && !ids.has(other.ownMemoryId),
      'hidden',
    );
  }

  // ── forgetting: the owner's own row ──────────────────────────────────────
  // POSITIVE CONTROL for the column-scoped UPDATE grant 0037 introduces. If
  // `active` were left out of that grant, /perfil/memoria's Forget button would
  // silently do nothing and the screen would still say "Forgotten."
  //
  // Restored immediately, because later checks in this file read this row.
  {
    const { data, error } = await db
      .from('memories').update({ active: false }).eq('id', self.ownMemoryId).select('id');
    check(
      `${L}: the owner can forget their own memory (positive control)`,
      !error && (data ?? []).length === 1,
      error ? `${error.code ?? 'err'}: ${error.message}` : `${(data ?? []).length} rows`,
    );
    await admin.from('memories').update({ active: true }).eq('id', self.ownMemoryId);
  }

  // ── forgetting somebody else's ───────────────────────────────────────────
  // RLS filters rows, it does not raise, so a blocked UPDATE returns no error at
  // all. The victim row's own state is the only truthful signal — the same
  // reasoning as attack 21 on notifications.
  {
    await db.from('memories').update({ active: false }).eq('id', self.colleagueMemoryId);
    const { data: after } = await admin
      .from('memories').select('active').eq('id', self.colleagueMemoryId).single();
    check(
      `${L}: forgetting a COLLEAGUE's personal memory blocked`,
      after?.active === true,
      after?.active === true ? 'no row matched' : 'ACCEPTED — per-profile scoping broken',
    );
  }
  {
    await db.from('memories').update({ active: false }).eq('id', other.companyMemoryId);
    const { data: after } = await admin
      .from('memories').select('active').eq('id', other.companyMemoryId).single();
    check(
      `${L}: forgetting another company's memory blocked`,
      after?.active === true,
      after?.active === true ? 'no row matched' : 'ACCEPTED — boundary broken',
    );
  }

  // ── filing a memory AGAINST a colleague ──────────────────────────────────
  // The INSERT policy's second predicate. `memories` must keep an INSERT policy
  // (the `remember` tool runs on the tenant's own client on the web), so unlike
  // notifications the predicate is what does the work. Without it a manager
  // could put attacker-chosen text into a colleague's agent context — read out
  // by Capo, in the colleague's own conversation, under the app's own chrome.
  {
    const { error } = await db.from('memories').insert({
      company_id: self.companyId, profile_id: self.colleagueId,
      kind: 'preference', content: 'planted in a colleague context',
    });
    check(
      `${L}: filing a memory against a COLLEAGUE blocked`,
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — insert predicate missing',
    );
  }

  // ── the cross-company FK trigger ─────────────────────────────────────────
  // A row whose company_id is honest but whose profile_id names ANOTHER
  // tenant's user satisfies neither select policy, so it would be a row naming
  // a stranger that nobody can see and therefore nobody can find. RLS cannot
  // catch it — it only ever checks the row's own company_id — so 0037's
  // BEFORE INSERT trigger is the whole defence. Same seam as 0024's.
  {
    const { error } = await db.from('memories').insert({
      company_id: self.companyId, profile_id: other.userId,
      kind: 'preference', content: 'cross-company profile_id',
    });
    check(
      `${L}: a memory pointing at another tenant's profile blocked`,
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — FK guard missing',
    );
  }

  // ── the column grant ─────────────────────────────────────────────────────
  // 0037 revokes the table-wide grant `memories` has carried since 0001 and
  // re-grants (content, active, updated_at). The policy alone would pass this —
  // it is the attacker's own row, in their own company — so this is purely a
  // column-grant check. If it leaks, a manager can move their own memory into a
  // colleague's private scope by hand.
  {
    const { error } = await db
      .from('memories').update({ profile_id: self.colleagueId }).eq('id', self.companyMemoryId);
    check(
      `${L}: rewriting a memory's OWNER blocked at the grant layer`,
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — column grant leaked',
    );
  }
  {
    const { error } = await db
      .from('memories').update({ kind: 'company' }).eq('id', self.companyMemoryId);
    check(
      `${L}: rewriting a memory's KIND blocked at the grant layer`,
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — column grant leaked',
    );
  }

  // ── the nightly ledger ───────────────────────────────────────────────────
  // SELECT and nothing else, the cron_runs posture. A run row a tenant could
  // write is not evidence of anything — and a forged watermark would make the
  // next night skip a window of the conversation entirely.
  {
    const { error } = await db.from('memory_consolidations').insert({
      company_id: self.companyId, run_date: '2026-02-02', status: 'done',
      covers_until_at: '2030-01-01T00:00:00Z',
    });
    check(
      `${L}: forging a memory_consolidations run blocked`,
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED — a tenant can skip its own night',
    );
  }
  {
    const { data } = await db
      .from('memory_consolidations').select('company_id').eq('company_id', other.companyId);
    check(
      `${L}: another company's consolidation runs are invisible`,
      (data ?? []).length === 0,
      `${(data ?? []).length} rows`,
    );
  }
}

async function checkSendHistoryScope(self, other) {
  const db = self.client;
  const L = self.label;
  // The seeded notification_log row is dated 2026-01-05. The range is short
  // because the function caps it at 92 days and refuses anything wider.
  const FROM = '2026-01-01';
  const TO = '2026-01-31';

  // POSITIVE CONTROL. The owner's own read must work, or every refusal below
  // is vacuous.
  const own = await db.rpc('company_send_history', { p_from: FROM, p_to: TO });
  const ownRows = own.data ?? [];
  check(
    `${L}: company_send_history returns this company's OWN sends (positive control)`,
    !own.error && ownRows.length > 0,
    own.error ? `${own.error.code ?? 'err'}: ${own.error.message}` : `${ownRows.length} rows`,
  );

  // Cross-tenant: the other company's ledger row must not appear. There is no
  // company parameter to forge — the scoping is entirely internal — so this is
  // the assertion that the internal scoping is real rather than assumed.
  {
    const leaked = ownRows.filter(r => r.id === other.checkinAskId);
    check(
      `${L}: company_send_history never returns another company's send`,
      leaked.length === 0,
      leaked.length ? `LEAKED ${leaked.map(r => r.id).join(', ')}` : 'none',
    );
  }

  // The worker ids on every returned row must be this tenant's. A function that
  // scoped by profile but not by company, or that forgot the predicate
  // entirely, would show foreign crew here.
  {
    const foreign = ownRows.filter(
      r => r.worker_id != null && r.worker_id !== self.workerId && r.worker_id !== self.helperWorkerId,
    );
    check(
      `${L}: every send row belongs to this company's own crew`,
      foreign.length === 0,
      foreign.length ? `${foreign.length} foreign worker rows` : `${ownRows.length} rows`,
    );
  }

  // The direct read stays dead. 0036 must not have relaxed notification_log's
  // deny-all posture as a side effect of adding the function — the generic
  // sweep asserts this too, and it is repeated here because THIS is the change
  // that would have caused it.
  {
    const { data, error } = await db.from('notification_log').select('id');
    check(
      `${L}: notification_log is STILL deny-all on a direct read`,
      !error && (data ?? []).length === 0,
      error ? error.message : `${(data ?? []).length} rows`,
    );
  }

  // The range cap. A browser is the caller, so "give me everything" has to be
  // refused by the function rather than trusted not to be asked.
  {
    const { error } = await db.rpc('company_send_history', { p_from: '2000-01-01', p_to: '2030-01-01' });
    check(
      `${L}: company_send_history refuses an unbounded date range`,
      error != null,
      error ? `rejected (${error.code ?? 'err'})` : 'ACCEPTED a 30-year range',
    );
  }
}

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

  // Attack 28b (0049): the same claim through open_task_review's FOURTH
  // argument. The function was dropped and recreated to add it, and this actor
  // is the one the guard's shape exists for: `private.current_company_id()` is
  // NULL for a confirmed account with no profiles row, which is what made the
  // pre-0019 `<>` form fail OPEN. Repeated here so a rebuild of the function
  // cannot quietly reintroduce it.
  {
    const foreignTask = victim.taskIds[1];
    const { error } = await db.rpc('open_task_review', {
      p_task: foreignTask,
      p_worker: null,
      p_note: 'orphan waived claim, no profiles row',
      p_photo_waived: true,
    });
    const { data: after } = await admin.from('tasks').select('status').eq('id', foreignTask).single();
    check(
      'adversarial: orphan (no profiles row) WAIVED open_task_review blocked',
      error != null && after?.status === 'pending',
      error ? `rejected (${error.code ?? 'err'}), victim task still ${after?.status}` : 'ACCEPTED — 0049 lost the guard',
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

  // Attack 36 (0035): set_task_collaborators, seen by the actor its guard is
  // most likely to fail open for. It is the FOURTH SECURITY DEFINER function in
  // this schema whose whole tenant boundary is
  //
  //     if auth.uid() is not null and v_company is distinct from
  //        private.current_company_id() then raise
  //
  // and private.current_company_id() returns NULL for this user. Two of the
  // three that came before it shipped with `<>` instead of `IS DISTINCT FROM`
  // and fell open for exactly this caller — 0019 and 0021 are the fixes, and
  // 0021 was confirmed exploitable against production. No ordinary two-tenant
  // attacker can reach the path at all, which is why both bugs survived a green
  // matrix, and why this check exists rather than a comment saying it is fine.
  //
  // Asserted on the victim's ROWS, not the error: the failure mode of that bug
  // class is a call that returns a success value and looks healthy.
  {
    const { error } = await db.rpc('set_task_collaborators', {
      p_task: victim.taskIds[0],
      p_workers: [],
    });
    const { data: after } = await admin
      .from('task_assignees')
      .select('id')
      .eq('task_id', victim.taskIds[0]);
    // The empty array is the payload that MATTERS here: it is "take everybody
    // off", so a fall-open would silently strip the victim's crew from their
    // own task and nobody would receive a briefing for it tomorrow.
    const intact = (after ?? []).length === 2;
    check(
      'adversarial: orphan (no profiles row) set_task_collaborators on a foreign task blocked',
      error != null && intact,
      error == null
        ? 'RPC SUCCEEDED (cross-tenant crew wipe!)'
        : !intact
          ? `victim task now has ${(after ?? []).length} assignee row(s) — crew stripped`
          : `rejected (${error.code ?? 'err'})`,
    );
  }

  // ── company_send_history and THE NULL-GUARD TRAP (0036, issue #51) ────────
  // This is the attack the whole third actor exists for, aimed at the newest
  // SECURITY DEFINER function in the schema.
  //
  // The shape that fails OPEN is
  //     if auth.uid() is not null and v_company is distinct from …
  // because `private.current_company_id()` is NULL for a user with no profiles
  // row, `uuid <> NULL` is NULL, `true and NULL` is NULL, and `if NULL` does
  // not fire — so the guard is skipped and the function runs UNSCOPED. That is
  // not hypothetical: the identical hole in revert_translation_batch was
  // confirmed exploitable against this production database, returned
  // {"reverted": 1}, and looked like a success.
  //
  // For a reader rather than a writer, falling open means handing an
  // unonboarded stranger the entire estate's send ledger — every company's
  // recipients, message ids and failures. 0036 therefore checks the null FIRST
  // and RAISES, which is what this asserts.
  {
    const { data, error } = await db.rpc('company_send_history', {
      p_from: '2026-01-01',
      p_to: '2026-01-31',
    });
    const rows = data ?? [];
    check(
      'adversarial: orphan (no profiles row) company_send_history blocked',
      error != null && rows.length === 0,
      error == null
        ? `RPC SUCCEEDED and returned ${rows.length} row(s) — the whole estate's send ledger`
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
  // Before the orphan attacks, which genuinely mutate rows if a boundary is
  // broken — this sweep wants a clean state to read.
  await checkWorkerTextIsolation(tenantA);
  await checkWorkerTextIsolation(tenantB);
  // Beside the worker-text sweep for the same reason: both ask about the
  // WORKER path, where there is no auth.uid() and RLS backstops nothing.
  await checkWorkerMenuScope(tenantA, tenantB);
  await checkWorkerMenuScope(tenantB, tenantA);
  // The newest SECURITY DEFINER read in the schema (0036, #51). Beside the two
  // above because it shares their shape — a boundary enforced inside a function
  // rather than by a policy — and because, like them, it needs a POSITIVE
  // CONTROL: it opens a window into a table that has no tenant policy at all,
  // so "returns nothing to anybody" would pass every refusal in this file.
  await checkSendHistoryScope(tenantA, tenantB);
  await checkSendHistoryScope(tenantB, tenantA);

  // Memory scope (0037). Runs in both directions like every other paired check,
  // so a policy that happened to work for whichever tenant was seeded first is
  // not mistaken for a correct one.
  await checkMemoryScope(tenantA, tenantB);
  await checkMemoryScope(tenantB, tenantA);
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
