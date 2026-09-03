-- "When we assign a new task to a worker we need to send it immediately"
-- (issue W7).
--
-- Until now a task assigned at 09:00 reached the person doing it at 07:00 the
-- NEXT morning, if it was still active by then. On a building site that is a
-- whole day of somebody doing the wrong thing, and the manager has no way to
-- know it: they typed the assignment, the screen updated, and nothing anywhere
-- said the crew member had not been told.
--
-- ── WHY THIS IS A TRIGGER AND NOT A HOOK IN THE APP ─────────────────────────
-- There are SEVEN ways a task acquires an assignee today: `create_task` and
-- `update_task` (both from chat, on two different clients), `apply_plan` and
-- `apply_reschedule` (through an approved card), the `assignTask` web action on
-- /tarefas/[id], the `setCollaborators` web action, and `set_task_collaborators`
-- called from the agent. A hook on each is a hook somebody eventually forgets,
-- in a commit about something else, and the symptom is not an error — it is one
-- crew member who silently stops being told about their new work.
--
-- A trigger is a door that cannot be walked around. Every writer passes through
-- Postgres; none of them has to know this feature exists. Same reasoning as
-- 0024's notify_review_pending and 0043's notify_worker_request, and the same
-- reasoning that made the welcome (0033) a sweep rather than a hook.
--
-- ── THE TRIGGER QUEUES; IT DOES NOT DECIDE ─────────────────────────────────
-- The one thing this migration deliberately does NOT do is work out whether the
-- task starts today. "What is on today" has exactly one definition in this
-- codebase and it lives in the `task_board` view (AGENTS.md, one clock). A
-- second copy of that rule inside a trigger would be a second opinion, and the
-- failure would be Capo messaging a crew member about work the board says is
-- next week.
--
-- So the trigger answers only the cheap, local question — "did somebody just
-- put this person on this task, and is the task in a status worth telling them
-- about?" — and the DRAIN (apps/web/app/notifications/task-assigned.ts) reads
-- `task_board` and decides. A queued notice for a task that turns out to start
-- next Tuesday is stamped `not_today` and nothing is sent.
--
-- ── DENY-ALL, LIKE notification_log AND worker_day_links ────────────────────
-- RLS on, zero policies, every grant revoked. This is a QUEUE the service role
-- drains, not a business record a tenant reads. A tenant who could write one
-- could make Capo send a WhatsApp message, in Capo's voice, to another
-- company's crew member about a task of their choosing; a tenant who could
-- update one could stamp `notified_at` on their own crew's notices and silence
-- them. Neither is a capability anybody needs.
--
-- ── NOTHING SWEEPS THIS TABLE ──────────────────────────────────────────────
-- Stated rather than hidden: drained rows stay for ever, as a record of who was
-- told what and when. The drain's read is a PARTIAL index on the undrained
-- ones, so its cost is proportional to the queue and not to the history — the
-- same device `worker_requests_unnotified_idx` and `notifications_unread_idx`
-- use. A sweep that fails leaves nothing dangerous behind here, so there is no
-- reason to run one.

create table task_assignment_notices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  -- on delete cascade, like task_assignees: a notice is a statement about a
  -- task that still exists, and telling somebody about a deleted task is worse
  -- than telling them nothing.
  task_id uuid not null references tasks(id) on delete cascade,
  -- WHO to tell. The lead (tasks.assignee_worker_id) or a collaborator
  -- (task_assignees) — the 07:00 briefing goes to everyone on a task, so the
  -- "you are on this today" note does too.
  worker_id uuid not null references workers(id),
  queued_at timestamptz not null default now(),
  -- ── THE DEDUPLICATION KEY, AND WHY IT IS A LISBON DAY ──────────────────────
  -- One notice per person per task per day. Deliberately NOT a partial unique
  -- on (task_id, worker_id) where notified_at is null, which was the other
  -- candidate: that one lets a task reassigned away and back inside an
  -- afternoon queue a SECOND notice after the first has drained, and the crew
  -- member reads "your manager assigned you a new task" twice about the same
  -- job. A day key cannot do that. The cost is the other direction and it is
  -- small: a task genuinely taken off somebody and given back the same day is
  -- announced once.
  --
  -- lisbon_today() rather than a generated column, because
  -- `timestamptz at time zone text` is STABLE and Postgres refuses a
  -- non-immutable generated expression. Same clock as everything else.
  queued_date date not null default lisbon_today(),
  -- NULL = still queued. Stamped once the drain has DECIDED, sent or not.
  notified_at timestamptz,
  -- What the drain decided, for the operator. Free text rather than a CHECK on
  -- purpose: this is a diagnostic column, and a new outcome must never be able
  -- to make a send fail with a 23514 at the moment somebody is waiting for it.
  -- The values the drain writes are listed in task-assigned.ts.
  outcome text,
  unique (task_id, worker_id, queued_date)
);

-- The drain's own read: what is still queued, oldest first. Partial, so the
-- cost is proportional to the queue rather than to the history.
create index task_assignment_notices_pending_idx
  on task_assignment_notices (company_id, queued_at) where notified_at is null;

-- "Did we already message this person a minute ago?" — the drain's coalescing
-- guard, which stops a manager assigning five tasks one at a time from sending
-- five whole-day messages in one minute.
create index task_assignment_notices_recent_idx
  on task_assignment_notices (company_id, worker_id, notified_at desc);

-- ── cross-company FK guard ──────────────────────────────────────────────────
-- Same posture and reasoning as 0009, 0017, 0018, 0023, 0024, 0034, 0037, 0042,
-- 0043: RLS checks a row's OWN company_id and never the company of the rows its
-- foreign keys point at. Here the only writers are the two triggers below, both
-- of which copy company_id off the row they fire on — so this cannot trip in
-- production today. It is here because it binds on EVERY path including the
-- service role, and the day something else writes this queue (a backfill, an
-- operator repair, a second channel) a row naming another tenant's worker would
-- send a WhatsApp message across a tenant boundary in Capo's own voice.
create or replace function private.assert_assignment_notice_same_company()
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
  return new;
end;
$$;

create trigger task_assignment_notices_fks_same_company
  before insert or update of company_id, worker_id, task_id
  on task_assignment_notices
  for each row execute function private.assert_assignment_notice_same_company();

-- ── RLS: nobody, on purpose ────────────────────────────────────────────────
alter table task_assignment_notices enable row level security;
-- No policies at all. With RLS on and no permissive policy, every statement
-- from `anon` and `authenticated` returns nothing (or is refused outright once
-- the grants are gone below). The service role bypasses RLS, which is the whole
-- and only access path.
revoke all on table task_assignment_notices from anon, authenticated;

comment on table task_assignment_notices is
  'Queue of "somebody was just put on a task" events, written by triggers on tasks and task_assignees and drained by apps/web/app/notifications/task-assigned.ts. The trigger deliberately does NOT decide whether the task starts today — task_board is the one definition of today and the drain reads it. Deny-all for tenants: a row here causes a WhatsApp message in Capo''s voice to a real crew member.';
comment on column task_assignment_notices.queued_date is
  'Lisbon day the notice was queued. Part of the unique key, so one person hears about one task at most once a day however many times it is reassigned.';
comment on column task_assignment_notices.notified_at is
  'When the drain DECIDED, sent or not. NULL means still queued; an outside-working-hours drain deliberately leaves it null so a later drain retries while it is still today.';

-- ── the door: a task gains (or changes) its lead ───────────────────────────
-- AFTER INSERT OR UPDATE OF the three columns that can make a task newly
-- somebody's work today. `status` is in that list for one case only: a task
-- brought back from `done`/`cancelled` into `pending` is new work to the person
-- holding it, even though nobody touched the assignee.
--
-- SECURITY DEFINER because tenants hold no grant on the queue table at all,
-- which is the point of it.
create or replace function private.queue_task_assignment_notice()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Nobody to tell.
  if new.assignee_worker_id is null then
    return null;
  end if;

  -- The same allowlist BRIEFABLE uses in apps/web/app/notifications/briefing.ts
  -- (`pending`, `in_progress`). A `blocked` task is not nagged about by the two
  -- daily sends and must not be announced here either; `pending_review` is a
  -- completion claim, not new work; `done` and `cancelled` speak for
  -- themselves. Restated here rather than shared because there is nowhere for
  -- SQL and TypeScript to share a constant, which is exactly why the DRAIN
  -- re-checks the status through task_board before sending anything: this test
  -- decides only whether the cheap queue row is worth writing.
  if new.status not in ('pending', 'in_progress') then
    return null;
  end if;

  if tg_op = 'UPDATE'
     and new.assignee_worker_id is not distinct from old.assignee_worker_id
     and new.start_date is not distinct from old.start_date
     and old.status in ('pending', 'in_progress')
  then
    -- Nothing about who does this, when it starts, or whether it is live has
    -- changed. A plain edit to a title or a description must not message
    -- anybody.
    return null;
  end if;

  insert into public.task_assignment_notices (company_id, task_id, worker_id)
  values (new.company_id, new.id, new.assignee_worker_id)
  on conflict do nothing;
  return null; -- AFTER trigger; the return value is ignored.
end;
$$;

create trigger tasks_queue_assignment_notice
  after insert or update of assignee_worker_id, start_date, status on tasks
  for each row execute function private.queue_task_assignment_notice();

-- ── the same door for HELPERS (issue #44) ──────────────────────────────────
-- The 07:00 briefing goes to EVERYONE on a task, lead and collaborators alike,
-- so "you are on this today" does too. A helper who learns about the job the
-- next morning is the same defect as a lead who does.
--
-- `role = 'collaborator'` ONLY, and that filter is load-bearing: 0035 MIRRORS
-- tasks.assignee_worker_id into a `lead` row on this table, so without it every
-- assignment would queue twice — once from the trigger above and once from the
-- mirror. The unique key would absorb the duplicate, but relying on a
-- constraint to hide a double write is how the second one survives a refactor.
create or replace function private.queue_collaborator_assignment_notice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
begin
  if new.role <> 'collaborator' then
    return null;
  end if;

  select t.status into v_status from public.tasks t where t.id = new.task_id;
  if v_status is null or v_status not in ('pending', 'in_progress') then
    return null;
  end if;

  insert into public.task_assignment_notices (company_id, task_id, worker_id)
  values (new.company_id, new.task_id, new.worker_id)
  on conflict do nothing;
  return null;
end;
$$;

create trigger task_assignees_queue_assignment_notice
  after insert on task_assignees
  for each row execute function private.queue_collaborator_assignment_notice();
