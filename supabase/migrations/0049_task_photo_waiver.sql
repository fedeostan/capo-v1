-- Finishing a task when there is genuinely no photo to send.
--
-- ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
-- `declare_task_done` has required at least one photo at the SCHEMA level since
-- 0027/#22, and that requirement is right: it is the only thing standing
-- between a completion claim and a sentence somebody typed. But it had no way
-- out at all. On 3 September a crew member said the job was done, sent photos
-- that were lost (fixed by 0047), then wrote "Just complete the task without the
-- picture" and Capo refused, twice, in the same words. There is no light in a
-- basement at 19:00, a phone camera dies, a lens is covered in plaster. The
-- product's answer to all of those was "that is the rule no matter what", which
-- ends with the crew member telling nobody anything.
--
-- Federico's rule, in his own words: "There is no way a worker finishes a task
-- without pictures. But what if there is no light? We must allow to say a task
-- is done without picture after asking for the picture twice. Then flag it to
-- the manager that no picture has been added, also telling the worker that the
-- manager will be notified that there is no picture and that a picture is
-- required."
--
-- ── WHY THE COUNTING LIVES IN THE DATABASE ─────────────────────────────────
-- "After asking twice" is a rule about a CONVERSATION, and the person on the
-- other end of that conversation can write any sentence they like, including a
-- very good impression of having already been asked. A prompt rule ("only waive
-- on the third try") is a request; the model is free to miscount and the worker
-- is free to argue. So the count is a table, keyed on the worker's conversation
-- and the task, and each attempt is stamped with the id of the INBOUND MESSAGE
-- it belongs to. Three tool calls inside one turn share that id and therefore
-- count once, which is what closes the obvious shortcut: the model cannot talk
-- its own way to the third attempt without the worker sending three messages.
--
-- What this migration adds:
--   1. task_reviews.photo_waived — the flag the manager's surfaces read.
--   2. task_photo_waiver_attempts — the counter, deny-all like every other
--      piece of conversational state on the WhatsApp path.
--   3. open_task_review gains p_photo_waived, defaulting to false, so every
--      existing caller (the check-in tap path, the manager's own "pedir
--      controlo") is untouched.
--   4. A notification kind of its own, so the inbox AND the push say what
--      happened rather than looking like every other claim.

-- ── 1. the flag ────────────────────────────────────────────────────────────
-- NOT NULL DEFAULT false, so every existing review reads as "not waived",
-- which is exactly what they are: before this migration there was no way to
-- file a claim without a photo through the agent at all.
--
-- Note what this column is NOT. It is not "this task has no photos" — that
-- question is answered by counting `task_photos` at read time
-- (countTaskPhotos, apps/web/app/dashboard-data.ts), because a photo can
-- arrive minutes after the claim and anything denormalised would be wrong
-- invisibly. This column records that the crew member was ASKED TWICE and said
-- they could not, which is a fact about the moment the claim was filed and can
-- never stop being true. The two are read together and mean different things.
alter table task_reviews add column photo_waived boolean not null default false;

comment on column task_reviews.photo_waived is
  'True when this completion claim was filed after the crew member was asked for a photo twice and said they could not send one. A fact about the moment the claim was filed, never a count of photos - the photo count is read from task_photos at read time, because a photo can arrive later and still attach to a task in pending_review.';

-- ── 2. the counter ─────────────────────────────────────────────────────────
-- One row per (conversation, task, distinct inbound message) in which the crew
-- member said a task was finished and had no photo waiting. The THIRD such
-- message is the one that may waive.
create table task_photo_waiver_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  worker_id uuid not null references workers(id),
  task_id uuid not null references tasks(id),
  -- The crew member's own thread (0027). Scoping the count to the conversation
  -- rather than to the worker alone is deliberate: a worker has exactly one
  -- thread, so today the two are the same thing, and keying on the thread means
  -- this table never has to learn about a second channel before it exists.
  conversation_id uuid not null references worker_conversations(id),
  -- 1, 2, 3, … in the order the asks happened. Its only job is the unique
  -- index below; nothing reads it as a decision input, because the decision is
  -- taken from the number of DISTINCT inbound message ids and that is a
  -- question the rows themselves answer.
  attempt_no integer not null check (attempt_no > 0),
  -- Meta's `wamid` for the message this attempt belongs to. A string minted by
  -- Meta, not by us and not by the worker, and the whole reason the model
  -- cannot shortcut: every tool call inside one turn carries the same value.
  inbound_message_id text not null,
  created_at timestamptz not null default now(),
  -- The brief's constraint, and the backstop for a double-counted turn: if the
  -- decision function is ever handed a stale read and tries to file attempt 1
  -- twice, the database refuses rather than quietly advancing the count.
  constraint task_photo_waiver_attempts_no_uniq unique (conversation_id, task_id, attempt_no),
  -- The stronger half of the same rule, stated where a reader can see it: one
  -- inbound message contributes AT MOST ONE attempt to a task, whatever the
  -- model does with its six steps. Without this, a model that called the tool
  -- three times in one turn while the reads raced could reach attempt 3 on a
  -- single message.
  constraint task_photo_waiver_attempts_msg_uniq unique (conversation_id, task_id, inbound_message_id)
);

-- The one read on the request path: this conversation's attempts for this task.
create index task_photo_waiver_attempts_lookup_idx
  on task_photo_waiver_attempts (conversation_id, task_id, created_at);

create index task_photo_waiver_attempts_company_idx
  on task_photo_waiver_attempts (company_id, created_at desc);

-- ── cross-company FK guard ─────────────────────────────────────────────────
-- Same posture and the same reasoning as 0009, 0018, 0023, 0034 and 0047: RLS
-- checks a row's OWN company_id and never the company of the rows its foreign
-- keys point at. The only writer is the worker agent on the SERVICE ROLE, the
-- one path RLS does not cover at all, so this is the second boundary behind the
-- tool's own phone-derived scoping.
create or replace function private.assert_waiver_attempt_same_company()
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
    select 1 from public.tasks t
    where t.id = new.task_id and t.company_id = new.company_id
  ) then
    raise exception 'task_id % is not in company %', new.task_id, new.company_id
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.worker_conversations c
    where c.id = new.conversation_id and c.company_id = new.company_id
  ) then
    raise exception 'conversation_id % is not in company %', new.conversation_id, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger task_photo_waiver_attempts_fks_same_company
  before insert or update of company_id, worker_id, task_id, conversation_id
  on task_photo_waiver_attempts
  for each row execute function private.assert_waiver_attempt_same_company();

-- ── RLS ────────────────────────────────────────────────────────────────────
-- checkin_photo_requests' posture (0034) and worker_photo_inbox's (0047): RLS
-- on with deliberately ZERO policies, plus every grant revoked, so a read is
-- refused at the GRANT layer before RLS is ever consulted.
--
-- A row here is not a business fact. It is Capo's private note that it has
-- already asked this person for a photo of this task once. Deny-all is what
-- makes the WRITE side safe as well: a tenant able to insert one could
-- manufacture two attempts and let the very next claim skip the asking
-- entirely, which is the whole rule this table exists to enforce. A tenant able
-- to DELETE one could make Capo ask for ever. Asserted by
-- scripts/rls-isolation-matrix.mjs.
alter table task_photo_waiver_attempts enable row level security;

revoke all on table task_photo_waiver_attempts from anon, authenticated;

comment on table task_photo_waiver_attempts is
  'How many separate inbound messages a crew member has spent saying a task is finished with no photo waiting. The third one may waive the photo requirement. Deny-all for tenants; written only by the worker agent on the service role. Nothing sweeps it: an attempt row is the evidence that the two asks happened.';

-- ── 3. open_task_review, with the waiver flag ──────────────────────────────
-- DROP AND CREATE, never `create or replace`: a replacement with an extra
-- parameter is a NEW function in Postgres, and the two would then be an
-- ambiguous overload for every existing three-argument call — including the
-- check-in tap path, whose ownership read is the entire tenant boundary for the
-- claims it files. One function, one signature.
--
-- The body below is 0019's, unchanged in every guard and in every ordering:
--   - FOR UPDATE on the task read, so the done/cancelled guard is not advisory;
--   - `auth.uid() is not null and v_company is distinct from
--     private.current_company_id()` exactly as it stands today. IS DISTINCT
--     FROM rather than <>, because current_company_id() is NULL for a confirmed
--     but not-yet-onboarded account and a plain <> would let that account write
--     across every tenant (0019 C1, exploit-confirmed);
--   - claim first, move second, so a double submit converges on
--     task_reviews_one_pending_idx instead of stacking.
-- The ONLY change is the new argument and the column it writes.
drop function open_task_review(uuid, uuid, text);

create function open_task_review(
  p_task uuid,
  p_worker uuid default null,
  p_note text default null,
  -- Defaults to false so every caller that predates this migration keeps the
  -- behaviour it has always had. The check-in tap path calls it with three
  -- arguments and files an ordinary claim, as it should: a tap is not somebody
  -- telling us they could not photograph anything.
  p_photo_waived boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_status  text;
  v_review  uuid;
begin
  -- FOR UPDATE: without the lock, a concurrent transaction can change the
  -- task's status between this read and the update below, making the
  -- done/cancelled guard advisory. Same device as revert_translation_batch
  -- (0015). Two concurrent open_task_review calls still converge rather than
  -- stack — that is task_reviews_one_pending_idx's job, not this lock's.
  select company_id, status into v_company, v_status from tasks where id = p_task for update;
  if v_company is null then
    raise exception 'task % not found', p_task using errcode = 'no_data_found';
  end if;
  -- IS DISTINCT FROM, not <>: private.current_company_id() returns NULL for
  -- an authenticated user with no profiles row yet (self-serve signup before
  -- complete_onboarding runs). `v_company <> NULL` is NULL, so a plain `<>`
  -- guard is skipped by three-valued logic and this SECURITY DEFINER
  -- function's entire tenant boundary falls open. IS DISTINCT FROM treats
  -- that NULL as a real mismatch and fails closed.
  if auth.uid() is not null
     and v_company is distinct from private.current_company_id() then
    raise exception 'task % is not yours', p_task using errcode = 'insufficient_privilege';
  end if;
  -- A closed task has nothing to declare finished. Reopen it first.
  if v_status in ('done', 'cancelled') then
    raise exception 'task % is %, not open', p_task, v_status using errcode = 'check_violation';
  end if;

  -- Ordered claim-then-move: if this insert trips
  -- task_reviews_one_pending_idx the whole statement aborts and the task's
  -- status is untouched, so a double submit converges instead of stacking.
  insert into task_reviews (company_id, task_id, declared_by_worker_id, note, photo_waived)
  values (v_company, p_task, p_worker, p_note, coalesce(p_photo_waived, false))
  returning id into v_review;

  update tasks set status = 'pending_review', updated_at = now() where id = p_task;

  return v_review;
end;
$$;

revoke execute on function open_task_review(uuid, uuid, text, boolean) from public, anon;
grant execute on function open_task_review(uuid, uuid, text, boolean) to authenticated, service_role;

-- ── 4. the manager hears about it differently ──────────────────────────────
-- A waived claim gets its own notification kind rather than a flag the inbox
-- reads, and that is what makes the PUSH carry it too: push renders from the
-- same catalog entry keyed on `kind` (apps/web/app/notifications/push.ts), so
-- one migration plus three dictionary entries reaches both surfaces and they
-- cannot say different things.
--
-- ⚠ THIS IS THE ONE EXCEPTION TO "THE PUSH DELIBERATELY CARRIES NO PHOTO
-- INFORMATION" (#52, AGENTS.md). That rule exists because a push fires seconds
-- after the claim, the one moment "no photo" is guaranteed true and guaranteed
-- uninformative — a photo may well be seconds behind it. Here it is neither:
-- the crew member has been asked twice and has said, in their own words, that
-- there will not be one. That is settled at the moment the claim is filed and
-- it is exactly what the manager needs to know before they walk over.
--
-- Adding a kind is a TWO-place edit by construction: this constraint, and the
-- catalog's Record<NotificationKind, …>, which makes a missing translation a
-- tsc error rather than a blank line in somebody's inbox.
alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check
  check (kind in ('review_pending', 'worker_request', 'review_no_photo'));

-- The producer is still a TRIGGER on task_reviews and still fans out to every
-- profile except the actor. The only change is that it now chooses between two
-- kinds. Everything else, including the `is distinct from auth.uid()` that
-- makes a service-role actor notify EVERYBODY (0024's inverted three-valued
-- trap), is byte-identical.
create or replace function private.notify_review_pending()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (company_id, profile_id, kind, subject_type, subject_id, title, body)
  select
    new.company_id,
    p.id,
    case when new.photo_waived then 'review_no_photo' else 'review_pending' end,
    'task_review',
    new.id,
    (select t.title from public.tasks t where t.id = new.task_id),
    new.note
  from public.profiles p
  where p.company_id = new.company_id
    -- Never notify the actor about their own action. A manager who tapped
    -- "pedir controlo" on the task detail screen does not need an unread
    -- badge telling them they did. IS DISTINCT FROM, not <>: auth.uid() is
    -- NULL for the service role and the cron (a worker-declared completion),
    -- and `p.id <> NULL` is NULL — under a plain <> that case would notify
    -- NOBODY, silently, which is the exact failure this feature exists to
    -- prevent. Same three-valued-logic trap as 0019/0021, inverted: here the
    -- naive form fails CLOSED, so it would have been a silent no-op rather
    -- than a leak. Still wrong, and much harder to notice.
    and p.id is distinct from auth.uid();
  return null; -- AFTER trigger; the return value is ignored.
end;
$$;

-- ── what is NOT here ───────────────────────────────────────────────────────
-- Nothing sweeps task_photo_waiver_attempts, and nothing expires a row. The
-- two asks are not a session: a crew member who says "acabei" on Monday with no
-- photo, is asked, and comes back on Wednesday has already been asked once, and
-- pretending otherwise would restart the whole conversation. The row is the
-- evidence that the asking happened, which is also why there is no DELETE
-- policy for anybody.
--
-- There is deliberately NO un-waive. A manager who disagrees resolves the
-- review the ordinary way — approve, reject or dismiss — and a photo that turns
-- up later still attaches to the task, because a task in pending_review is
-- still open (task_board.is_open is a denylist, 0013) and nothing in the photo
-- path looks at its status.
