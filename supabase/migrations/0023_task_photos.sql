-- Task photos: the first use of Supabase Storage in this codebase, and the
-- manager-side half of the proof requirement.
--
-- Until now the only binary path was inbound WhatsApp audio, which is
-- downloaded, transcribed in memory and discarded
-- (packages/core/src/channels/whatsapp-media.ts). Nothing was ever persisted,
-- so there is no bucket, no storage policy, and no prior art in this repo to
-- copy. Everything below therefore states its reasoning at length.
--
-- PHOTOS ARE NEVER SHOWN TO A MODEL. Recorded here because PRD 4 (the worker
-- WhatsApp path) depends on it: feeding an inbound image to a vision model is
-- a text-in-image prompt-injection surface with no guard in front of it.
-- Storage is for humans. The agent never reads this bucket and never reads
-- task_photos.

-- ── the bucket ─────────────────────────────────────────────────────────────
-- Private (public = false), so the ONLY way to read an object is a signed URL
-- minted through a session that satisfies the SELECT policy below.
--
-- file_size_limit and allowed_mime_types are enforced by the Storage API
-- itself, before a byte is written and regardless of what the caller claims.
-- They are the outermost of the three places the same two rules are stated —
-- the other two being the CHECK constraints on task_photos and the TypeScript
-- constants in packages/core/src/media/photos.ts. Deliberate belt-and-braces:
-- the browser can lie, a server action can have a bug, the bucket cannot.
--
-- 5 MiB is Meta's own cap for an inbound WhatsApp image, which is what makes
-- it the right number: PRD 4 will pass the SAME constant as `maxBytes` to
-- downloadMedia(), so one value bounds both intake paths.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'task-photos',
  'task-photos',
  false,
  5242880, -- 5 MiB — keep in sync with TASK_PHOTO_MAX_BYTES
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── storage.objects RLS ────────────────────────────────────────────────────
-- The path convention IS the tenant boundary: {company_id}/{task_id}/{uuid}.{ext}.
-- storage.foldername(name) splits the key into its folder segments, so [1] is
-- the company_id — the same private.current_company_id() every table policy in
-- this schema compares against (0007:36-40).
--
-- Why a string comparison rather than a join onto task_photos: the object is
-- written BEFORE its task_photos row exists (see the ordering note in the
-- server action), so a policy that required the row would refuse the upload
-- that creates it. Keying on the path makes the check total and independent of
-- write order.
--
-- current_company_id() returns NULL for an authenticated user with no profiles
-- row yet (Capo's real signup-before-onboarding state). Unlike the
-- three-valued-logic trap that bit open_task_review (0019) and
-- revert_translation_batch (0021), `x = NULL` inside a policy's USING/WITH
-- CHECK is safe: NULL is not true, so the policy denies. That is the correct
-- direction, and scripts/rls-isolation-matrix.mjs asserts it with the orphan
-- actor rather than trusting the reasoning.
--
-- RLS is already enabled on storage.objects by Supabase; do not re-enable it
-- (the table is owned by supabase_storage_admin).
create policy task_photos_objects_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'task-photos'
    and (storage.foldername(name))[1] = (select private.current_company_id())::text
  );

create policy task_photos_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'task-photos'
    and (storage.foldername(name))[1] = (select private.current_company_id())::text
  );

-- No UPDATE and no DELETE policy, on purpose. Evidence that the tenant can
-- overwrite or remove is not evidence. Same no-DELETE posture the rest of the
-- schema takes, and the same reason translation undo MARKS rather than deletes
-- (0015). A manager who attached the wrong photo asks the operator; that is a
-- rare, deliberate act and it should look like one.

-- ── task_photos ────────────────────────────────────────────────────────────
create table task_photos (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  task_id uuid not null references tasks(id),
  -- The object key inside the 'task-photos' bucket. Unique: two rows pointing
  -- at one object would double-count the proof and make deletion ambiguous.
  storage_path text not null unique,
  -- DEFAULT 'manager' although the PRD's column list has no default. The
  -- default is what makes the column un-forgeable: `source` is deliberately
  -- absent from the INSERT grant below, so an authenticated tenant physically
  -- cannot supply it and every tenant-written row is 'manager'. PRD 4's worker
  -- path writes on the service role, which bypasses grants and sets 'worker'
  -- explicitly. Without this, a manager could manufacture "the crew sent
  -- proof" — the same forgery class worker_checkins is locked down against
  -- (0017), and the reason that table has no INSERT grant either.
  source text not null default 'manager' check (source in ('worker', 'manager')),
  worker_id uuid references workers(id),
  -- DEFAULT auth.uid(), and likewise absent from the INSERT grant: who
  -- uploaded is derived from the session, never accepted from the client.
  -- NULL for the service role (auth.uid() is NULL there), which is exactly
  -- what a worker-sourced row should carry.
  uploaded_by uuid default auth.uid() references profiles(id),
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null check (byte_size > 0 and byte_size <= 5242880),
  -- The file's own timestamp, supplied by the client. Advisory metadata, not
  -- evidence: it is not read from EXIF (the browser re-encodes the image
  -- before upload, which strips EXIF) and a caller can put anything here.
  -- Nothing keys on it; created_at is the trustworthy clock.
  taken_at timestamptz,
  created_at timestamptz not null default now(),
  -- The record cannot point outside its own tenant's, or its own task's,
  -- folder. Enforced here rather than in the server action because it binds on
  -- EVERY path — user JWT, service role, postgres — and because storage RLS
  -- alone would not catch a row whose company_id is honest but whose
  -- storage_path names another company's folder. UUIDs contain no LIKE
  -- metacharacters (hex plus hyphens; `_` would be one, `-` is not), so the
  -- pattern needs no escaping.
  constraint task_photos_path_scoped
    check (storage_path like company_id::text || '/' || task_id::text || '/%')
);

-- The task detail screen's read: every photo for one task, newest first.
create index task_photos_task_idx on task_photos (task_id, created_at desc);
-- The "how much proof is being filed" question, per tenant.
create index task_photos_company_idx on task_photos (company_id, created_at desc);

-- ── cross-company FK guard ─────────────────────────────────────────────────
-- Uniform with 0009 and 0018: RLS checks a row's OWN company_id, never the
-- company of the rows its foreign keys point at. Three of them here.
create or replace function private.assert_task_photo_fks_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.tasks t
    where t.id = new.task_id and t.company_id = new.company_id
  ) then
    raise exception 'task_id % is not in company %', new.task_id, new.company_id
      using errcode = 'check_violation';
  end if;
  if new.worker_id is not null and not exists (
    select 1 from public.workers w
    where w.id = new.worker_id and w.company_id = new.company_id
  ) then
    raise exception 'worker_id % is not in company %', new.worker_id, new.company_id
      using errcode = 'check_violation';
  end if;
  if new.uploaded_by is not null and not exists (
    select 1 from public.profiles p
    where p.id = new.uploaded_by and p.company_id = new.company_id
  ) then
    raise exception 'uploaded_by % is not in company %', new.uploaded_by, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger task_photos_fks_same_company
  before insert or update of company_id, task_id, worker_id, uploaded_by
  on task_photos
  for each row execute function private.assert_task_photo_fks_same_company();

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table task_photos enable row level security;

create policy task_photos_select_company on task_photos
  for select to authenticated
  using (company_id = (select private.current_company_id()));

-- INSERT is allowed for tenants — unlike task_reviews, which routes every
-- write through an RPC. The difference is what the row means: a task_reviews
-- row must move `tasks.status` in the same transaction or the feature's core
-- invariant breaks, whereas a task_photos row is a pointer at bytes the same
-- caller just uploaded under the same session. There is no second table to
-- keep in step, so an RPC would add a hop and no guarantee.
create policy task_photos_insert_company on task_photos
  for insert to authenticated
  with check (company_id = (select private.current_company_id()));

-- No UPDATE and no DELETE policy — same reasoning as storage.objects above.

-- ── column grants ──────────────────────────────────────────────────────────
-- Supabase default-grants ALL on new public tables, so revoke first.
--
-- The INSERT grant is COLUMN-SCOPED, and that is the whole point: `source`,
-- `worker_id` and `uploaded_by` are missing from it, so PostgREST rejects any
-- request that names them (42501) and the defaults above decide their values.
-- A tenant can file its own manager photos and nothing else. `id` and
-- `created_at` are likewise omitted so the row's identity and clock are the
-- database's, not the caller's.
revoke all on table task_photos from anon, authenticated;
grant select on table task_photos to authenticated;
grant insert (company_id, task_id, storage_path, mime, byte_size, taken_at)
  on table task_photos to authenticated;

-- ── tasks.completion_proof ─────────────────────────────────────────────────
-- "Concluir sem fotos" must never block, but it must be visible afterwards:
-- the point of the escape hatch is to learn how often proof is skipped, and a
-- number nobody can query is not a measurement. One nullable column rather
-- than a completion-audit table, because that table is a larger design (0018
-- already noted the absence of completed_at/completed_by) and this PRD needs
-- exactly one bit of it.
--
--   'photos'  — completed through the sheet with at least one photo attached
--   'skipped' — completed through the sheet, proof declined
--   NULL      — completed some other way, or not completed. Includes every
--               task completed before this migration, and every task Capo
--               closes through update_task from chat. NULL therefore means
--               "unknown", never "skipped"; do not conflate them when
--               counting.
--
-- Deliberately NOT added to task_board or any other view: nothing on a board
-- keys on it, and views may only be extended by APPENDING columns (AGENTS.md),
-- so leaving them alone keeps this migration free of view churn.
alter table tasks add column completion_proof text
  check (completion_proof is null or completion_proof in ('photos', 'skipped'));

comment on column tasks.completion_proof is
  'How the manager closed this task through the completion sheet: photos attached, or proof declined. NULL = closed some other way (chat, agent, pre-0023) — unknown, not skipped.';
