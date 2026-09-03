-- Every photo a crew member sends is KEPT, from the moment it arrives.
--
-- ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
-- On 3 September a crew member said "Ok is done!", Capo asked for a photo, they
-- sent the photo twice, and then wrote "I tried 3 times now. Is not working".
-- The thread in `worker_messages` shows each photo arriving as the placeholder
-- "(photo, no message)" and there is no `task_photos` row anywhere in the five
-- days around it. Nothing was broken in the sense of throwing: every part
-- behaved exactly as designed.
--
-- What was designed was this. A task photo's object key is
-- `{company_id}/{task_id}/{uuid}.{ext}` (0023) and segment 1 of it IS the
-- tenant boundary the storage.objects policies read, so the bytes could not be
-- written anywhere legitimate until the TASK was known. On the agent path the
-- task is only known when the model calls `declare_task_done`, which happens in
-- the same turn or never. So the bytes were held in memory for one turn and
-- then dropped. A worker who sends the photo first and says which job it is a
-- minute later loses the photo; a worker who sends three photos as three
-- messages keeps only the last.
--
-- ── WHAT THIS TABLE CHANGES, AND WHAT IT DOES NOT ──────────────────────────
-- ⚠ THIS ONE STAGES THE BYTES. That is the whole difference from
-- `checkin_photo_requests` (0034), which stages the EXPECTATION ("the next bare
-- photo from this person is proof of task X") and deliberately has no blob
-- column. That design only works because a tap knows the task BEFORE the photo
-- arrives. Nothing knows the task when somebody just sends a photo, so the only
-- way to stop losing it is to keep it somewhere that is not a task folder yet.
--
-- The bytes go to `{company_id}/inbox/{worker_id}/{uuid}.{ext}` in the SAME
-- private `task-photos` bucket. Segment 1 is still the company, so 0023's two
-- storage.objects policies cover this key with no change at all: a tenant can
-- read their own company's staged objects and nobody else's. Segment 2 is the
-- literal word `inbox`, which is not a uuid and therefore cannot collide with a
-- task folder however many tasks a company has.
--
-- A staged photo is NOT evidence and is NOT tenant-visible as a record: there
-- is no `task_photos` row until the photo is ATTACHED to a task, at which point
-- the object is MOVED to `{company_id}/{task_id}/{uuid}.{ext}` and the row is
-- written by the one writer that has always written them
-- (packages/core/src/media/task-photo-store.ts). `task_photos_path_scoped` is
-- untouched and still binds every row it has ever bound.
create table worker_photo_inbox (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  worker_id uuid not null references workers(id),
  -- Where the bytes are RIGHT NOW. Rewritten to the task key when the photo is
  -- attached, so this column never points at an object that has moved away.
  -- Unique for `task_photos.storage_path`'s reason: two rows naming one object
  -- would make "has this been attached" ambiguous.
  storage_path text not null unique,
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null check (byte_size > 0 and byte_size <= 5242880),
  -- The caption the photo arrived with, if any. Worker-authored text, and it
  -- lives here for the same reason `task_reviews.note` lives where it does: it
  -- is shown to the manager only as an attributed quote, and it never enters
  -- `messages`, `conversation_summaries`, `memories` or `proposals`. Nothing
  -- reads it today; it is recorded so that "what did they say when they sent
  -- it" stays answerable rather than being reconstructed later from the model's
  -- summary of it.
  caption text,
  received_at timestamptz not null default now(),
  -- SHORT-LIVED BY CONSTRUCTION, exactly as checkin_photo_requests.expires_at
  -- is, and set by the WRITER rather than by a DEFAULT so the TTL lives in one
  -- place in TypeScript (PHOTO_INBOX_TTL_MS,
  -- packages/core/src/media/photo-inbox.ts) and cannot drift between the two.
  --
  -- 24 hours, which is deliberately LONGER than 0034's three: that TTL bounds
  -- what an unlabelled photo may be believed to be ABOUT, and this one bounds
  -- nothing except how long we keep offering the crew member their own photo
  -- back. It is a full working day plus the evening, so "I photographed it at
  -- 08:00 and told you at 17:00" still works.
  expires_at timestamptz not null,
  -- Null until the photo becomes proof of something. Nothing un-attaches: this
  -- is a one-way transition, uniform with the no-DELETE posture of everything
  -- around it.
  attached_task_id uuid references tasks(id),
  attached_at timestamptz,
  -- A photo is either waiting or attached. Half an attachment is the state a
  -- reader cannot interpret, and the reader here decides whether to offer the
  -- photo to a completion claim.
  constraint worker_photo_inbox_attached_pair
    check ((attached_task_id is null) = (attached_at is null)),
  -- The path convention, re-derived in the database for the reason
  -- task_photos_path_scoped exists: storage RLS alone would not catch a row
  -- whose company_id is honest but whose storage_path names another company's
  -- folder, and this CHECK binds on EVERY path including the service role. Both
  -- states are pinned, so a row can never claim to be staged while its bytes
  -- sit in a task folder, or the reverse.
  constraint worker_photo_inbox_path_scoped check (
    case
      when attached_task_id is null
        then storage_path like company_id::text || '/inbox/' || worker_id::text || '/%'
      else storage_path like company_id::text || '/' || attached_task_id::text || '/%'
    end
  )
);

-- The one read on the request path: this crew member's photos that are still
-- waiting for a task. Partial, because the answer on a normal turn is "none"
-- and the table grows for ever.
create index worker_photo_inbox_waiting_idx
  on worker_photo_inbox (worker_id, received_at)
  where attached_task_id is null;

create index worker_photo_inbox_company_idx
  on worker_photo_inbox (company_id, received_at desc);

-- ── cross-company FK guard ─────────────────────────────────────────────────
-- Same posture and the same reasoning as 0009, 0017, 0018, 0023 and 0034: RLS
-- checks a row's OWN company_id and never the company of the rows its foreign
-- keys point at. The only writer is the WhatsApp webhook on the SERVICE ROLE,
-- the one path RLS does not cover at all, so this is the second boundary behind
-- the route's own phone-derived scoping.
create or replace function private.assert_worker_photo_inbox_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.workers w
    where w.id = new.worker_id and w.company_id = new.company_id
  ) then
    raise exception 'worker_id % is not in company %', new.worker_id, new.company_id
      using errcode = 'check_violation';
  end if;
  if new.attached_task_id is not null and not exists (
    select 1 from public.tasks t
    where t.id = new.attached_task_id and t.company_id = new.company_id
  ) then
    raise exception 'attached_task_id % is not in company %', new.attached_task_id, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger worker_photo_inbox_fks_same_company
  before insert or update of company_id, worker_id, attached_task_id
  on worker_photo_inbox
  for each row execute function private.assert_worker_photo_inbox_same_company();

-- ── RLS ────────────────────────────────────────────────────────────────────
-- checkin_photo_requests' posture (0034), not task_photos' (0023): RLS on with
-- deliberately ZERO policies, plus every grant revoked, so a read is refused at
-- the GRANT layer before RLS is ever consulted.
--
-- The difference is what the row means. A `task_photos` row is tenant data: the
-- manager attached it or the crew sent it as proof, and the manager is its
-- natural reader. A row here is a photo that is not proof of anything yet. It
-- becomes tenant-visible the moment it is attached, as a `task_photos` row, and
-- until then it is conversational state belonging to the WhatsApp channel.
--
-- Deny-all is also what makes the write side safe. A tenant able to INSERT one
-- could stage an object of their choosing as though a crew member had sent it;
-- able to UPDATE one, they could re-point a colleague's waiting photo at
-- another task, or un-attach evidence. Asserted by
-- scripts/rls-isolation-matrix.mjs.
alter table worker_photo_inbox enable row level security;

revoke all on table worker_photo_inbox from anon, authenticated;

-- ── what is NOT here ───────────────────────────────────────────────────────
-- Nothing sweeps this table, and `expires_at` is enforced by the READER, the
-- same arrangement 0034 and 0039 make and for the same reason: a sweep that
-- fails leaves the rows behind and says nothing, while a reader that checks
-- cannot be wrong about it. The consequence is stated rather than hidden: an
-- expired staged OBJECT stays in the `task-photos` bucket for ever until
-- somebody writes a sweep. It is a few hundred kilobytes per unattached photo,
-- invisible to every screen, and it is the price of never losing a photo that
-- was sent in good faith.
comment on table worker_photo_inbox is
  'Photos a crew member sent over WhatsApp that are not attached to a task yet. Staged in the task-photos bucket under {company_id}/inbox/{worker_id}/, moved to {company_id}/{task_id}/ and given a task_photos row when a completion claim names the task. Deny-all for tenants; written only by the webhook on the service role. Expiry is enforced by the reader; nothing sweeps this table or the objects behind it.';
