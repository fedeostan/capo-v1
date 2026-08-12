-- The restricted worker agent (PRD 4, issue #22): its own conversation store,
-- and the one column the worker's first question needs.
--
-- Everything in this repo until now has rested on a single sentence: "a
-- worker's text never reaches the model". This migration is half of what
-- replaces it with a narrower promise that is still structural —
--
--     worker text never reaches the MANAGER's agent context.
--
-- The other half is a type system (packages/core/src/capabilities/worker).
-- This file is the storage half, and the whole reason it exists as two NEW
-- tables rather than a nullable worker_id on `messages` is one specific
-- escalation:
--
--   messages → loadWindow() → toThread() → thread.recentUserTexts (the last 3
--   user rows) → ToolContext.recentUserTexts → runGuarded(), which authorizes a
--   DIRECT manager-level write whenever the model can quote the manager.
--
-- Put worker text in `messages` and a worker can author the quote that
-- authorizes the write. Not "can try to persuade the model to" — can WRITE the
-- evidence the authorization check reads. A nullable column makes that a filter
-- somebody has to remember on every read path forever; separate tables make it
-- a query that does not exist. Absence is the only defence that cannot be
-- argued with, and the attacker here is a person typing sentences.
--
-- Note what is deliberately NOT here: no summarizer table, no `memories`
-- equivalent, no proposal linkage. A worker thread is episodic — a check-in in
-- the evening, a question about curing time — and every one of those absences
-- is a surface that cannot be attacked because it was never built.

-- ── task_board.job_address ─────────────────────────────────────────────────
-- The first thing a worker needs is WHICH SITE, and task_board selects only
-- j.name and j.status from jobs (0013:36-37). Appending the column is the
-- option AGENTS.md permits (`create or replace view`, APPEND only — Postgres
-- forbids reordering or retyping an existing column), and it keeps the worker's
-- task read to ONE query against ONE clock rather than a second scoped select
-- against `jobs`.
--
-- j.client_name is deliberately NOT appended alongside it. It is the manager's
-- commercial picture, it has never been on this view, and the worker tool
-- therefore cannot leak it without someone adding it here on purpose. Do not
-- read that as the tool filtering it out — there is nothing to filter.
--
-- Readers must `select('*')` and treat job_address as optional, so a deploy
-- landing before this migration degrades to "no address" instead of erroring
-- (AGENTS.md; the same discipline 0013 itself established).
--
-- The definition below is 0013's, verbatim, with exactly one line added at the
-- end of the select list. Diff it against 0013 before changing anything else
-- here: a `create or replace view` silently redefines every reader in the app.
create or replace view task_board
with (security_invoker = true) as
select
  t.id,
  t.company_id,
  t.title,
  t.description,
  t.status,
  t.start_date,
  t.due_date,
  t.duration_days,
  t.materials,
  t.job_id,
  t.assignee_worker_id,
  t.created_at,
  t.updated_at,
  j.name   as job_name,
  j.status as job_status,
  w.name   as worker_name,
  d.today,
  c.is_open,
  c.job_active,
  c.window_start,
  c.window_end,
  b.active_today,
  b.active_tomorrow,
  r.overdue,
  case when t.due_date is null then 0
       else greatest(0, d.today - t.due_date) end as days_overdue,
  r.risk_blocked,
  r.risk_late_start,
  r.risk_due_soon,
  r.risk_late_dependency,
  r.risk_paused_job,
  -- Deliberately disjoint from `overdue`: the Atrasadas and Em risco filters
  -- must never show the same task twice, or the manager double-counts their
  -- trouble. Something already late is not "at risk", it is late. The
  -- individual risk_* flags are NOT suppressed, so an overdue+blocked task
  -- still renders its "bloqueada" reason under Atrasadas.
  (c.is_open
   and not r.overdue
   and (r.risk_blocked or r.risk_late_start or r.risk_due_soon
        or r.risk_late_dependency or r.risk_paused_job)) as at_risk,
  ld.late_titles as late_dependency_titles,
  dp.all_titles  as depends_on_titles,
  -- APPENDED by 0027. Everything above this line is byte-identical to 0013.
  j.address as job_address
from tasks t
left join jobs    j on j.id = t.job_id
left join workers w on w.id = t.assignee_worker_id
cross join lateral (select lisbon_today() as today) d
cross join lateral (
  select
    (t.status not in ('done', 'cancelled'))    as is_open,
    (t.job_id is null or j.status = 'active')  as job_active,
    coalesce(t.start_date,
             (t.created_at at time zone 'Europe/Lisbon')::date) as window_start,
    coalesce(t.due_date, 'infinity'::date)     as window_end,
    -- "within the next two WORKING days", in pure SQL, matching the planner's
    -- own weekend-skipping scheduler: Thu->Mon, Fri->Tue, Sat->Tue, rest +2.
    d.today + (case extract(isodow from d.today)::int
                 when 4 then 4
                 when 5 then 4
                 when 6 then 3
                 else 2
               end) as due_soon_until
) c
left join lateral (
  -- Predecessors that are themselves unfinished and past their own deadline.
  -- array_agg over no rows yields NULL, which is what risk_late_dependency tests.
  select array_agg(x.title order by x.due_date, x.title) as late_titles
  from task_dependencies td
  join tasks x on x.id = td.depends_on_task_id
  where td.task_id = t.id
    and x.status not in ('done', 'cancelled')
    and x.due_date is not null
    and x.due_date < d.today
) ld on true
left join lateral (
  select array_agg(x.title order by x.title) as all_titles
  from task_dependencies td
  join tasks x on x.id = td.depends_on_task_id
  where td.task_id = t.id
) dp on true
cross join lateral (
  select
    (c.is_open and c.job_active
       and d.today     between c.window_start and c.window_end) as active_today,
    (c.is_open and c.job_active
       and d.today + 1 between c.window_start and c.window_end) as active_tomorrow
) b
cross join lateral (
  -- overdue keeps 0005's deliberate asymmetry: unlike the active_* buckets it
  -- ignores job_active, so an overdue task on a paused obra still surfaces
  -- (badged, not hidden).
  select
    (c.is_open and t.due_date is not null and t.due_date < d.today) as overdue,
    (c.is_open and t.status = 'blocked')                            as risk_blocked,
    (c.is_open and t.status = 'pending'
       and t.start_date is not null and t.start_date < d.today)     as risk_late_start,
    (c.is_open and t.status = 'pending'
       and t.due_date is not null
       and t.due_date >= d.today
       and t.due_date <= c.due_soon_until)                          as risk_due_soon,
    (c.is_open and ld.late_titles is not null)                      as risk_late_dependency,
    -- coalesce, not `j.status = 'paused'`: job_id is nullable, and a
    -- three-valued boolean here is exactly the bug 0006 exists to fix.
    (c.is_open and coalesce(j.status, '') = 'paused')               as risk_paused_job
) r;

-- create or replace view preserves existing grants, but restating them costs
-- nothing and makes this file readable on its own.
grant select on task_board to authenticated, service_role;

-- ── worker_conversations ───────────────────────────────────────────────────
-- One perpetual thread per crew member, mirroring `conversations` (one per
-- company) rather than inventing a second shape.
--
-- company_id is DENORMALISED here rather than reached through workers.company_id
-- so that every policy, index and system-path query carries the tenant key
-- locally. On the worker path there is no auth.uid() at all — the WhatsApp
-- webhook runs as the service role — so a query that had to join to find its
-- own tenant would be a join somebody could get wrong under pressure. The
-- cross-company trigger below is what keeps the denormalised copy honest.
create table worker_conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  -- UNIQUE: one thread per worker, for the same reason `conversations` keeps
  -- one per company. A worker who writes on Monday and again on Thursday is
  -- the same person having the same relationship with Capo; the episode
  -- boundary is the check-in (see worker_messages.checkin_id), not the thread.
  worker_id uuid not null unique references workers(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index worker_conversations_company_idx
  on worker_conversations (company_id, updated_at desc);

-- ── worker_messages ────────────────────────────────────────────────────────
create table worker_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references worker_conversations(id),
  -- Denormalised for the same reason as above, plus one this table has on its
  -- own: the per-company daily budget is a COUNT over this table, and it must
  -- not have to join to know whose spend it is counting. See usage_date.
  company_id uuid not null references companies(id),
  -- No 'event' role, unlike `messages`. Nothing in this thread is a system
  -- narration: there are no approval cards to resolve on the worker path, which
  -- is the only thing role='event' exists for.
  role text not null check (role in ('user', 'assistant')),
  -- Same 'ui-message@7' { parts: [...] } shape and the same content_format
  -- discipline as `messages`, so the two threads can be read by one renderer
  -- even though they may never be MIXED into one model context.
  content jsonb not null,
  content_format text not null default 'ui-message@7',
  channel text not null default 'whatsapp',
  -- Which evening's check-in this message belongs to, or NULL for an
  -- unprompted question ("quanto tempo seca a cola?"). This is the EPISODE
  -- boundary: the worker loop loads the messages of the current check-in, or
  -- the last 24 hours when there is none, and never the whole history. A worker
  -- thread that grew without bound would eventually need a summarizer, and a
  -- summarizer is a model reading untrusted text with no one watching.
  checkin_id uuid references worker_checkins(id),
  -- HOW MANY photos arrived with this message — never the photos themselves,
  -- and never anything derived from their contents. Photos are not shown to a
  -- model (0023), so "3 fotos" is the entire fact the thread records. A vision
  -- pass here would be a text-in-image injection surface with nothing in front
  -- of it.
  photo_count integer not null default 0 check (photo_count >= 0),
  -- The BUDGET's clock, stamped by the database rather than by the caller.
  --
  -- lisbon_today() is the same one clock task_board reads, so "today" means the
  -- same thing to the rate limiter as it does to the board — and a caller
  -- cannot understate its own spend by sending a different date, because it
  -- never sends one at all. Counting rows here rather than keeping a separate
  -- counter table is the same choice 0026 made for push: the row IS the ledger,
  -- so a spend cannot exist without a message existing to explain it.
  usage_date date not null default lisbon_today(),
  created_at timestamptz not null default now()
);

-- The thread read: this conversation, oldest first (the order a model wants).
create index worker_messages_thread_idx
  on worker_messages (conversation_id, created_at);

-- The two budget reads, both of which run BEFORE any model call on every
-- inbound worker message and therefore have to stay cheap forever. Partial on
-- role='user', because a turn is counted by what the WORKER sent: an assistant
-- row is the cost we already paid, not a new request.
create index worker_messages_budget_company_idx
  on worker_messages (company_id, usage_date) where role = 'user';
create index worker_messages_budget_thread_idx
  on worker_messages (conversation_id, usage_date) where role = 'user';

-- ── cross-company FK guards ────────────────────────────────────────────────
-- Uniform with 0009 / 0018 / 0023 / 0024: RLS checks a row's OWN company_id and
-- never the company of the rows its foreign keys point at.
--
-- This matters MORE here than on the tables above, not less, and for a reason
-- specific to this feature: the only writer is the service role, which RLS does
-- not cover at all. These triggers are the sole enforcement that a worker
-- thread belongs to the company whose crew member it names.
create or replace function private.assert_worker_conversation_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.workers w
    where w.id = new.worker_id and w.company_id = new.company_id
  ) then
    raise exception 'worker_id % is not in company %', new.worker_id, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger worker_conversations_fks_same_company
  before insert or update of company_id, worker_id on worker_conversations
  for each row execute function private.assert_worker_conversation_same_company();

create or replace function private.assert_worker_message_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.worker_conversations c
    where c.id = new.conversation_id and c.company_id = new.company_id
  ) then
    raise exception 'conversation_id % is not in company %', new.conversation_id, new.company_id
      using errcode = 'check_violation';
  end if;
  -- The check-in a message is bound to must belong to the same tenant. Without
  -- this, a mis-wired call site could file a worker's answer against another
  -- company's evening ask — the same hole 0017's own guard closes from the
  -- other side.
  if new.checkin_id is not null and not exists (
    select 1 from public.worker_checkins k
    where k.id = new.checkin_id and k.company_id = new.company_id
  ) then
    raise exception 'checkin_id % is not in company %', new.checkin_id, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger worker_messages_fks_same_company
  before insert or update of company_id, conversation_id, checkin_id on worker_messages
  for each row execute function private.assert_worker_message_same_company();

-- ── RLS ────────────────────────────────────────────────────────────────────
-- SELECT ONLY, on both tables, and the absent policies are the design.
--
-- A manager reading their crew's thread on a screen is a real need and the
-- reason a SELECT policy exists at all. Every WRITE happens on the service
-- role, inside the WhatsApp webhook, which bypasses RLS entirely — so an
-- INSERT or UPDATE policy would grant a capability that no legitimate caller
-- uses. That is not merely redundant, it is an attack surface with no upside:
-- a tenant able to INSERT here could put words in a worker's mouth in a thread
-- the manager reads as the worker's own, and a tenant able to UPDATE could
-- rewrite what a crew member said after the fact.
--
-- No DELETE policy either, matching every other table in this schema.
alter table worker_conversations enable row level security;
alter table worker_messages enable row level security;

create policy worker_conversations_select_company on worker_conversations
  for select to authenticated
  using (company_id = (select private.current_company_id()));

-- Keyed on the row's OWN denormalised company_id rather than on an EXISTS
-- against worker_conversations. Same predicate, one less relation in the
-- policy, and — the part that matters — it cannot be weakened by a future
-- change to the parent table's own policy.
create policy worker_messages_select_company on worker_messages
  for select to authenticated
  using (company_id = (select private.current_company_id()));

-- ── column grants ──────────────────────────────────────────────────────────
-- Supabase default-grants ALL on new public tables, so revoke before granting.
-- This line, not the absent policies, is what actually makes worker-authored
-- text unforgeable by a tenant — see the 0014 note that column grants REPLACE
-- rather than add, and 0017's identical posture on worker_checkins.
revoke all on table worker_conversations from anon, authenticated;
revoke all on table worker_messages from anon, authenticated;
grant select on table worker_conversations to authenticated;
grant select on table worker_messages to authenticated;

comment on table worker_conversations is
  'One thread per crew member for the restricted worker agent (PRD 4). Deliberately NOT `conversations`: worker text must never reach the manager agent''s recentUserTexts, which is the evidence pool the write guard authorizes against.';
comment on table worker_messages is
  'Worker-authored and worker-facing turns. Never read by the manager agent. photo_count records that photos arrived; the photos themselves are never shown to a model (0023).';
