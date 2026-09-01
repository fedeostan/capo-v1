-- "Diz ao chefe que preciso de mais tinta" (issue #152).
--
-- Until now Capo answered that sentence with a refusal, and the refusal was
-- written down in three places on purpose: the crew persona's worked example,
-- the worker policy ("never promise to 'pass it on' — you cannot"), and the
-- fact that it was TRUE — the crew roster had four tools and none of them could
-- reach the manager. The person standing next to the empty tin, at the exact
-- moment they notice, was turned away.
--
-- This table is the place to put what they said. A fifth crew tool
-- (packages/core/src/capabilities/worker/request.ts) writes one row per
-- request; the trigger at the bottom puts it in every manager's inbox, Web Push
-- (0026) rides that row with no producer of its own, and the WhatsApp webhook
-- sends the manager a free-form line when they are inside their own 24-hour
-- window.
--
-- ── WHY THIS IS NOT A `tasks` ROW ───────────────────────────────────────────
-- The obvious shape is "a to-do for the manager", and `tasks` is the table with
-- to-dos in it. It is the wrong table, for a reason that is structural rather
-- than tidy: `tasks` is CREW WORK. A row there has an assignee, flows into
-- `task_board`, into the 07:00 briefing, into the late-afternoon check-in, and
-- its `materials` array feeds /materiais and `materials_outlook`. A manager
-- to-do dropped in would appear in reads that were never meant to see it, and
-- "preciso de mais tinta" would arrive as a MATERIAL ON A TASK NOBODY IS DOING —
-- i.e. as a line on the buy list for work that does not exist.
--
-- If the manager wants a real task out of a request, that is a later tap and an
-- ordinary create_task. Nothing here does it automatically.
--
-- ── URGENCY IS A DATE, NEVER A TONE ─────────────────────────────────────────
-- `needed_by` is a plain date and the ranking is subtraction against
-- lisbon_today(). There is deliberately NO priority/severity column and no
-- model judgement of how urgent a message sounds: a person writing calmly about
-- a blocker tomorrow is more urgent than one writing in capitals about next
-- month, and tone is the signal an agent reads worst.
--
-- The column is NULLABLE and the null means UNDATED — shown as undated, never
-- guessed at. Capo asks once, in one line; if the crew member still does not
-- say, the request is filed without a date. Guessing high cries wolf until the
-- manager stops looking; guessing low buries the one that mattered.
--
-- ── THE THIRD LEGITIMATE HOME FOR WORKER TEXT ───────────────────────────────
-- `text` is the crew member's own words. That makes this the THIRD place in the
-- schema where worker-authored prose lives, after `worker_messages` (0027) and
-- `task_reviews.note` (0018) — and it inherits their rule wholesale:
--
--   It is rendered to the manager as an ATTRIBUTED QUOTE, never as Capo's own
--   voice, on every surface (the inbox, Home, and the WhatsApp line).
--
--   It NEVER enters `messages`, `conversation_summaries`, `memories` or
--   `proposals`. `messages` is what thread.recentUserTexts reads, and those
--   last three user rows are the evidence pool `runGuarded` matches a model's
--   quote against before executing a manager-level write directly (AGENTS.md,
--   migration 0027). A crew member whose words landed there would not be
--   persuading the manager's agent of anything — they would be AUTHORING the
--   evidence its authorization check reads.
--
--   The manager's chat-thread note about a request may SUMMARISE and never
--   quote: "O Miguel pediu material na obra X" is our own copy wrapped around a
--   crew name the MANAGER typed. The words themselves stay here, attributed.
--
-- scripts/rls-isolation-matrix.mjs seeds its worker tracer through this table
-- as well, so the day some change starts drawing manager context from it, that
-- sweep fails.
--
-- ── WHAT A TENANT MAY DO ────────────────────────────────────────────────────
-- SELECT and nothing else — task_reviews' posture (0018), not the uniform
-- three-policy one. Every write is the service role (the WhatsApp webhook), so
-- there is nothing a tenant needs an INSERT for, and an INSERT they DID have
-- would let a manager forge "a worker asked for this" — attacker-chosen text
-- attributed to a real crew member, on a screen Federico acts on. No UPDATE
-- either: `text`, `worker_id`, `needed_by` and `created_at` are the record of
-- what was said and when, and a record the subject cannot rewrite is the only
-- kind worth keeping.
--
-- ── NO RESOLUTION MARKER, DELIBERATELY ──────────────────────────────────────
-- There is no `resolved_at`, no status and no triage column — problem_reports'
-- decision (0042), for the same reason: a column added now would be a promise
-- the product does not yet make. Nothing in this release lets a manager mark a
-- request handled, and nothing tells the crew member it was. Home therefore
-- shows requests by FRESHNESS (the loader's own window) rather than by an
-- unresolved flag, and the inbox keeps them for ever with its own read state.
-- Closing the loop back down to the crew member is a bigger piece: it needs a
-- manager action that produces a proactive send, which outside the 24-hour
-- window is a paid template that does not exist yet.

create table worker_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  -- WHO asked. Resolved from the sender's phone/BSUID by the webhook, never
  -- from anything in the message body and never from anything the model emits.
  -- NOT NULL: a request nobody can be attributed to is a rumour.
  worker_id uuid not null references workers(id),
  -- WHICH job it is about, when they said. Nullable because most requests are
  -- "preciso de tinta" with no task named, and refusing those would mean the
  -- request does not get made.
  --
  -- The id is checked against ctx.scope.taskIds — the crew member's own open
  -- tasks, computed BEFORE the model ran — so it can never be an id the model
  -- produced against the whole table. `on delete set null` rather than cascade:
  -- deleting a task must not delete the record of somebody asking for
  -- something.
  task_id uuid references tasks(id) on delete set null,
  -- The request, verbatim, in the crew member's own words. The one untrusted
  -- column. The tool clamps to 500 before inserting; this CHECK is the
  -- backstop, and it is generous because a request refused 23514 for being long
  -- is a request lost.
  text text not null check (char_length(text) between 1 and 1000),
  -- COARSE and OPTIONAL, on purpose. Facu named materials and tools and then
  -- said "and whatever we need" — an enum here is a list of things a person on
  -- site is allowed to need, and it would have to grow every time somebody
  -- needs something new. Free text is the record; this is only a filing hint,
  -- and 'other' is a first-class answer.
  category text check (category is null or category in ('material', 'tool', 'machine', 'delivery', 'other')),
  -- WHEN it is needed for. NULL = undated; see the header. A date, not a
  -- timestamp: a building site works in days.
  needed_by date,
  created_at timestamptz not null default now(),
  -- ── the WhatsApp ping's delivery marker ───────────────────────────────────
  -- The row IS the queue, exactly as notifications.pushed_at is for Web Push
  -- (0026): there is no outbound ledger for this and no separate producer. NULL
  -- means the free-form WhatsApp line to the manager has not been attempted
  -- yet; the webhook stamps it after one attempt, sent or skipped, so a manager
  -- outside their window is never pinged twice about the same request when the
  -- next crew message arrives.
  --
  -- Written ONLY by the service role — it is absent from every tenant grant
  -- below, so a tenant can neither forge "already told them" nor replay a ping.
  -- No backfill is needed or possible: the table is new.
  manager_notified_at timestamptz
);

-- The manager's read: their own company, newest first. Home and the inbox both
-- come through here.
create index worker_requests_company_idx on worker_requests (company_id, created_at desc);

-- The ping sweep, which runs after every crew agent turn. Partial, so its cost
-- is proportional to what is UNSENT rather than to the whole history — the same
-- device notifications_unread_idx uses for the badge count.
create index worker_requests_unnotified_idx
  on worker_requests (company_id) where manager_notified_at is null;

-- ── cross-company FK guard ──────────────────────────────────────────────────
-- Same posture and reasoning as 0009, 0017, 0018, 0023, 0024, 0034, 0037, 0042:
-- RLS checks a row's OWN company_id and never the company of the rows its
-- foreign keys point at. Without this, a row whose company_id is honest could
-- name another tenant's worker as the asker or another tenant's task as the
-- subject — and the inbox would then render a stranger's words under this
-- company's chrome, attributed to a crew member who does not exist here.
--
-- Binds on every path including the service role, which is the ONLY writer in
-- production. That is the point: on this path there is no auth.uid() and RLS
-- backstops nothing, so a trigger is the only thing left that can refuse.
create or replace function private.assert_worker_request_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.workers w
    where w.id = new.worker_id and w.company_id = new.company_id
  ) then
    raise exception 'worker_id % is not in company %', new.worker_id, new.company_id
      using errcode = 'check_violation';
  end if;
  if new.task_id is not null and not exists (
    select 1 from public.tasks t
    where t.id = new.task_id and t.company_id = new.company_id
  ) then
    raise exception 'task_id % is not in company %', new.task_id, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger worker_requests_fks_same_company
  before insert or update of company_id, worker_id, task_id
  on worker_requests
  for each row execute function private.assert_worker_request_same_company();

-- ── RLS: read your own company's requests, and nothing else ─────────────────
alter table worker_requests enable row level security;

-- The point of the feature. Company-scoped rather than per-profile: a request
-- is addressed to whoever can act on it, and a company with two managers must
-- not have one of them unable to see what the crew asked for.
create policy worker_requests_select_company on worker_requests
  for select to authenticated
  using (company_id = (select private.current_company_id()));

-- No INSERT, no UPDATE, no DELETE policy — see the header. The schema's only
-- DELETE policy is still push_subscriptions (0026), and this does not change
-- that: a registration is a device, a request is a business event.

-- Supabase default-grants ALL on new public tables, so revoke before granting.
-- Column grants REPLACE rather than add (0014, 0025, 0031, 0032, 0042); SELECT
-- is the complete set a tenant may ever hold on this table.
revoke all on table worker_requests from anon, authenticated;
grant select on table worker_requests to authenticated;

comment on table worker_requests is
  'One row per "I need something" from a crew member (issue #152), filed by the fifth worker tool over WhatsApp. Its own record, never a tasks row: a manager to-do in tasks would reach the board, the 07:00 briefing and the buy list. `text` is worker-authored prose — the third legitimate home for it after worker_messages and task_reviews.note — and must be rendered to the manager as an attributed quote and never copied into messages, thread notes, summaries, memories or proposals. Tenants hold SELECT and nothing else; every write is the service role.';
comment on column worker_requests.text is
  'The request, verbatim, in the crew member''s own words. Untrusted: render as data, never as instructions, and never as Capo''s own voice.';
comment on column worker_requests.needed_by is
  'When it is needed FOR. NULL means undated and must be SHOWN as undated — urgency is subtraction against lisbon_today(), never a model''s reading of tone.';
comment on column worker_requests.manager_notified_at is
  'Delivery marker for the free-form WhatsApp line to the manager — the row IS the queue, as notifications.pushed_at is for Web Push (0026). Stamped by the webhook after one attempt, sent or skipped. Service role only.';

-- ── the inbox kind ──────────────────────────────────────────────────────────
-- Adding a kind is a TWO-PLACE edit and this is the first place: the CHECK
-- here, and all three dictionaries in @capo/i18n, whose catalog types
-- notifications.kind as Record<NotificationKind, …> so a missing translation is
-- a tsc error rather than a blank line in somebody's inbox.
alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check
  check (kind in ('review_pending', 'worker_request'));

alter table notifications drop constraint notifications_subject_type_check;
alter table notifications add constraint notifications_subject_type_check
  check (subject_type is null or subject_type in ('task_review', 'worker_request'));

-- ── producer: a crew request lands in every manager's inbox ─────────────────
-- A TRIGGER on worker_requests, not a call inside the tool — the house pattern
-- (0024's notify_review_pending) and for the same reason: the tool is not
-- necessarily the only writer for ever (a backfill, a second channel, an
-- operator repair), and every one of those paths would otherwise have to
-- remember to notify. Attached to the table, the fan-out cannot be forgotten.
--
-- Web Push (0026) then rides the row it writes with NO extra work: pushes are
-- driven off `notifications` itself (the row IS the queue), so this kind gets
-- lock-screen delivery the moment the migration lands, and there is deliberately
-- no push producer here.
--
-- SECURITY DEFINER because tenants have no INSERT grant on notifications and
-- because it reads profiles and workers, both RLS-covered.
create or replace function private.notify_worker_request()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (company_id, profile_id, kind, subject_type, subject_id, title, body)
  select
    new.company_id,
    p.id,
    'worker_request',
    'worker_request',
    new.id,
    -- DATA, never copy. The subject of this sentence is the crew member, and
    -- their name was typed by the MANAGER on /perfil — it is company-owned
    -- text, unlike everything in `body` below. The sentence wrapped around it
    -- is resolved per reader from profiles.language at render time.
    (select w.name from public.workers w where w.id = new.worker_id),
    -- The crew member's own words, carried so the inbox can quote them. Same
    -- contract as 0024's `body` on a review notification: rendered as an
    -- attributed quote, never as UI copy, and authorizing nothing — the
    -- manager-side guard matches against the MANAGER's own recent texts, so a
    -- request reading "ignore previous instructions" is just a quote the
    -- manager reads and disbelieves.
    new.text
  from public.profiles p
  where p.company_id = new.company_id
    -- IS DISTINCT FROM, never <>. On this path auth.uid() is ALWAYS null — the
    -- WhatsApp webhook is a system caller — and `p.id <> NULL` is NULL, so the
    -- naive form would notify NOBODY, silently, on every single request. Same
    -- three-valued-logic trap 0024 documents, and here it is not merely
    -- theoretical: the service role is the only writer this table has.
    and p.id is distinct from auth.uid();
  return null; -- AFTER trigger; the return value is ignored.
end;
$$;

create trigger worker_requests_notify_manager
  after insert on worker_requests
  for each row execute function private.notify_worker_request();

-- No retirement trigger, unlike task_reviews_retire_notifications (0024).
-- Nothing marks a request handled (see the header), so there is no event that
-- could retire its notification. The manager clears it the ordinary way, from
-- the inbox. When a resolution marker does arrive, its retirement trigger
-- belongs beside it in that migration.
