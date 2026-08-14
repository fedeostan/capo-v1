-- The photo half of "Sim, terminei" (issue #52).
--
-- #54 turned the late-afternoon check-in tap from a no-op into a COMPLETION
-- CLAIM: one open_task_review() per task in the ask's snapshot, so the task
-- lands in `pending_review` and waits for the manager. What it could not do was
-- ask for proof. The worker agent's `declare_task_done` has required at least
-- one photo at the SCHEMA level since 0027/#22; the button path required
-- nothing, so the two doors into `pending_review` disagreed about evidence and
-- the manager had no way to tell which door a claim came through.
--
-- ── WHY A TABLE AND NOT A COLUMN ───────────────────────────────────────────
-- A task photo's object key is `{company_id}/{task_id}/{uuid}.{ext}` (0023,
-- packages/core/src/media/photos.ts), and segment 1 of that key IS the tenant
-- boundary the storage.objects policies read. So bytes cannot be written
-- anywhere legitimate until the TASK is known. On the agent path the model
-- names the task in the same turn the photo arrives, which is why photos there
-- live for exactly one turn and no staging exists.
--
-- A tap is different: the photo arrives in a LATER inbound message, minutes
-- after the tap, with nothing in it that names a task. Something has to
-- remember, between the two messages, which tasks were claimed and which one we
-- are currently asking about. That memory is this table.
--
-- ⚠ IT STAGES THE EXPECTATION, NEVER THE BYTES. There is no photo blob column
-- and there must never be one. The bytes are still downloaded and written in a
-- single request, exactly as they always were; all that is stored here is
-- "which task is the next photo for". That is what keeps the known limit
-- recorded in AGENTS.md (photos live for one turn) true and unchanged.
--
-- ── ONE TASK AT A TIME, AND WHY ────────────────────────────────────────────
-- A worker can be claiming three tasks with one tap, and an inbound image says
-- nothing about which of them it shows. Rather than guess — a wrong photo filed
-- as proof is worse than no photo — Capo asks about ONE task, attaches the next
-- image to that task, and then asks about the next. `next_index` is the cursor
-- into `task_ids`. The worker can stop answering at any point; what they sent
-- is kept, what they did not send simply never arrives.
create table checkin_photo_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  worker_id uuid not null references workers(id),
  -- The ask this request descends from. Carried so the log can join the two,
  -- and because it is the row whose ownership read (company_id + worker_id +
  -- kind) was the ENTIRE tenant boundary for the claim that produced this
  -- request — see handleCheckinTap in apps/web/app/api/whatsapp/route.ts.
  notification_id uuid not null references notification_log(id),
  -- From the ASK, never from the clock, for the same reason worker_checkins
  -- takes it from there: the buttons stay tappable and a late answer must land
  -- on the day it was asked about.
  checkin_date date not null,
  -- The tasks a claim was actually FILED for, in the order they will be asked
  -- about. jsonb rather than uuid[] purely for uniformity with
  -- notification_log.task_ids and worker_checkins.task_ids, which lets the same
  -- readTaskIds() validator guard all three.
  task_ids jsonb not null default '[]',
  -- Cursor into task_ids. Advanced past a task when its photo lands AND when
  -- the task turns out to be unusable (reassigned, closed, gone) — a request
  -- that cannot move forward would otherwise ask about the same task forever.
  next_index integer not null default 0 check (next_index >= 0),
  -- How many photos this request has actually taken in. Bookkeeping for the
  -- log; nothing keys on it.
  photos_received integer not null default 0 check (photos_received >= 0),
  -- SHORT-LIVED BY CONSTRUCTION. A request is dead to every reader once this
  -- passes, whether or not anything ever closed it. Set by the writer rather
  -- than by a DEFAULT so the TTL lives in one place in TypeScript
  -- (PHOTO_REQUEST_TTL_MS, apps/web/lib/checkin-photo.ts) and cannot drift
  -- between the two.
  expires_at timestamptz not null,
  closed_at timestamptz,
  close_reason text
    check (close_reason is null or close_reason in ('complete', 'superseded', 'abandoned')),
  created_at timestamptz not null default now(),
  -- A row is either open (no closed_at, no reason) or closed (both). Half a
  -- close is the state a reader cannot interpret.
  constraint checkin_photo_requests_closed_pair
    check ((closed_at is null) = (close_reason is null))
);

-- AT MOST ONE OPEN REQUEST PER CREW MEMBER, and it is what makes the lookup on
-- the photo path a single unambiguous row rather than "pick the newest and
-- hope". The next tap CLOSES any open request before opening its own (see
-- openPhotoRequest), so this index is the backstop for that ordering rather
-- than a constraint the happy path has to work around.
create unique index checkin_photo_requests_open_idx
  on checkin_photo_requests (worker_id)
  where closed_at is null;

create index checkin_photo_requests_company_date_idx
  on checkin_photo_requests (company_id, checkin_date desc);

-- ── cross-company FK guard ─────────────────────────────────────────────────
-- Same posture and the same reasoning as 0009, 0017, 0018 and 0023: RLS checks
-- a row's OWN company_id and never the company of the rows its foreign keys
-- point at. The only writer is the WhatsApp webhook on the SERVICE ROLE — the
-- one path RLS does not cover at all — so this is the second boundary behind
-- the route's own ownership read.
create or replace function private.assert_checkin_photo_request_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.workers w
    where w.id = new.worker_id and w.company_id = new.company_id
  ) then
    raise exception 'worker_id % is not in company %', new.worker_id, new.company_id
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.notification_log n
    where n.id = new.notification_id and n.company_id = new.company_id
  ) then
    raise exception 'notification_id % is not in company %', new.notification_id, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger checkin_photo_requests_fks_same_company
  before insert or update of company_id, worker_id, notification_id
  on checkin_photo_requests
  for each row execute function private.assert_checkin_photo_request_same_company();

-- ── RLS ────────────────────────────────────────────────────────────────────
-- notification_log's posture (0016) and NOT worker_checkins' (0017): RLS on,
-- deliberately ZERO policies, i.e. deny-all for `authenticated`.
--
-- The difference is what the row means. A worker_checkins row is tenant data —
-- the crew's answer about the tenant's own work, and the manager is its natural
-- reader. This is a piece of conversational state belonging to the WhatsApp
-- channel: "which task am I currently asking this person to photograph". No
-- screen shows it and no screen should, because the manager-facing fact is not
-- "Capo is waiting for a photo" but "this claim has a photo, or it does not" —
-- and that is answered by counting task_photos at read time, not by reading
-- this table.
--
-- Deny-all also means the grants below are the only thing standing between a
-- tenant and a row they could use to redirect somebody else's next photo at a
-- task of their choosing. Asserted by scripts/rls-isolation-matrix.mjs.
alter table checkin_photo_requests enable row level security;

revoke all on table checkin_photo_requests from anon, authenticated;

-- ── tasks.completion_proof ─────────────────────────────────────────────────
-- The column is UNCHANGED — same two legal values, same CHECK, no migration of
-- data. What changes is who writes it, so the comment is restated rather than
-- left to go quietly stale (AGENTS.md: a comment about who can write what goes
-- stale silently).
--
-- Before #52 the completion sheet was the only writer, so 'photos' meant "the
-- manager closed this with photos attached". Both worker paths now write
-- 'photos' too — the agent's declare_task_done and this issue's check-in photo
-- — at the moment proof is attached, which is BEFORE the task is closed at all.
-- So the column now answers "does this task's completion have photographic
-- proof behind it", which is the question every reader was already asking of
-- it.
--
-- NULL still means UNKNOWN and never 'skipped'. Only the completion sheet ever
-- writes 'skipped', and only the manager can choose it.
comment on column tasks.completion_proof is
  'Whether this task''s completion has photographic proof: ''photos'' (the manager attached some through the completion sheet, or the crew sent some over WhatsApp), ''skipped'' (the manager declined proof in the sheet — the only writer of this value), NULL = unknown, i.e. closed some other way (chat, agent, pre-0023). NULL is never ''skipped''; do not conflate them when counting.';
