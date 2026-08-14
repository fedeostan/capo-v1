-- Two people on one task (issue #44).
--
-- THE BUG, in Federico's words: "there is no way for Capo to assign 2 people to
-- the same task. What it does instead is duplicate the task, duplicating the
-- amount of material needed." `tasks.assignee_worker_id` is a single nullable
-- uuid (0001), so the only shape the model had for "Miguel e o Joao fazem a
-- pintura" was two rows — two entries on the board, two `materials` arrays,
-- and therefore two of everything in materials_outlook and on /materiais.
--
-- THE SHAPE CHOSEN, and it is Federico's own: there is always a LEAD, and other
-- people are COLLABORATORS on that same single task. Not a symmetric many-to-
-- many. Somebody has to be accountable for a job on a building site, and every
-- surface in this product already assumes exactly one such person.
--
-- ── THE CENTRAL INVARIANT ──────────────────────────────────────────────────
-- `tasks.assignee_worker_id` REMAINS THE LEAD AND REMAINS AUTHORITATIVE.
-- It is the only writable surface for who leads a task; nothing in this
-- migration changes how it is written, and no reader anywhere derives the lead
-- from the new table. `task_assignees` is a MIRROR for the lead and the sole
-- home of collaborators.
--
-- That asymmetry is the whole safety design and it answers "what happens if
-- they disagree?" in the only way worth having: they cannot disagree about
-- anything a reader consults.
--
--   * The lead row is written ONLY by tasks_sync_lead_assignee below, on every
--     insert and on every change of assignee_worker_id. Nothing else can write
--     one: tenants have no INSERT/UPDATE/DELETE grant on this table at all, and
--     task_assignees_lead_matches_task refuses any lead row — from any actor,
--     service role included — whose worker_id is not the task's current
--     assignee.
--   * If the mirror were ever to go missing anyway (a row written before this
--     migration's backfill, a future bug, a restore), NOTHING BREAKS. Every
--     reader in the codebase takes the lead from `tasks.assignee_worker_id` and
--     reads task_assignees only for `role = 'collaborator'`. The cost of a
--     missing lead row is that `unique (task_id, worker_id)` stops preventing
--     the lead from ALSO being listed as a collaborator, whose worst symptom is
--     one person named twice in one morning message. Visible, harmless, and
--     self-healing the next time the assignee is written.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
--   * dispatch_tasks_today and dispatch_log are NOT touched. The frozen n8n /
--     Twilio SMS contract stays byte-identical against
--     docs/plans/dispatch-viewdef-baseline.sql (AGENTS.md). A collaborator is
--     therefore invisible to the paused SMS path, which is correct: that path
--     is a frozen snapshot of an older product, not a second implementation.
--   * `materials` is untouched, on purpose and as the point of the whole issue.
--     It lives on the TASK. One task, one array, however many people are on it.
--     Nothing here multiplies, sums or copies it.
--   * No status, no completion, no review semantics change. A collaborator
--     cannot file a completion claim (see the check-in decision in AGENTS.md);
--     open_task_review / resolve_task_review are not edited.

-- ── task_assignees ─────────────────────────────────────────────────────────
create table task_assignees (
  id uuid primary key default gen_random_uuid(),
  -- Denormalised rather than reached through tasks.company_id, for the same
  -- reason worker_conversations does it (0027): the briefing and the check-in
  -- read this on the SERVICE ROLE with no auth.uid(), so every query carries
  -- the tenant key locally instead of relying on a join somebody could get
  -- wrong. assert_task_assignee_fks_same_company below keeps the copy honest.
  company_id uuid not null references companies(id),
  -- on delete cascade, and it is the only cascade here. A task_assignees row is
  -- not a business event — it is a statement about a task that still exists —
  -- so it must not outlive its task. worker_id deliberately has NO cascade: a
  -- crew member is retired by setting workers.active = false, never deleted,
  -- and a delete that silently emptied crews is not a failure mode worth
  -- enabling.
  task_id uuid not null references tasks(id) on delete cascade,
  worker_id uuid not null references workers(id),
  -- 'lead' is a MIRROR of tasks.assignee_worker_id and is never the source of
  -- truth. See the header.
  role text not null default 'collaborator' check (role in ('lead', 'collaborator')),
  created_at timestamptz not null default now(),
  -- A person appears on a task ONCE. This is what stops the lead also being
  -- listed as a collaborator, which would name them twice in the 07:00
  -- briefing and count them twice in every "who is on this?" read. It only
  -- works because the lead is mirrored in — that mirror's real job.
  unique (task_id, worker_id)
);

-- At most one lead per task, enforced rather than assumed. The mirror trigger
-- deletes before it inserts, so this can only trip on a hand-written row, which
-- is exactly when an error is wanted.
create unique index task_assignees_one_lead_idx
  on task_assignees (task_id) where role = 'lead';

-- "Everyone on these tasks", which is the shape both daily sends ask for.
create index task_assignees_company_task_idx
  on task_assignees (company_id, task_id);

-- "Which tasks is this person on?" — the crew-load reads on /perfil and the
-- worker-side surfaces.
create index task_assignees_worker_idx
  on task_assignees (worker_id, role);

-- ── cross-company FK guard ─────────────────────────────────────────────────
-- The house pattern (0009 / 0018 / 0023 / 0024 / 0027 / 0032 / 0034). RLS
-- checks a row's OWN company_id and never the company of the rows its FKs point
-- at, so without this a tenant could put THEIR company_id on a row naming
-- another company's task or another company's worker. A trigger rather than a
-- policy so it binds on every path — user JWT, service role, postgres, and the
-- SECURITY DEFINER function below, which is in fact the only writer.
create or replace function private.assert_task_assignee_fks_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.tasks t
    where t.id = new.task_id and t.company_id = new.company_id
  ) then
    raise exception 'task_id % is not in company %', new.task_id, new.company_id
      using errcode = 'check_violation';
  end if;
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

create trigger task_assignees_fks_same_company
  before insert or update of company_id, task_id, worker_id
  on task_assignees
  for each row execute function private.assert_task_assignee_fks_same_company();

-- ── the lead can never disagree with the task ──────────────────────────────
-- The other half of the header's invariant, and the reason "what if they
-- disagree" has no answer: a 'lead' row naming anyone other than the task's
-- current assignee is refused outright. Combined with the mirror below, the
-- lead row is a pure function of tasks.assignee_worker_id.
--
-- SECURITY DEFINER + empty search_path for the same reason as the guard above:
-- it must bind identically for a tenant, for the service role and for postgres.
create or replace function private.assert_task_assignee_lead_matches()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_assignee uuid;
begin
  if new.role <> 'lead' then return new; end if;
  select assignee_worker_id into v_assignee from public.tasks where id = new.task_id;
  -- IS DISTINCT FROM, never <>: assignee_worker_id is nullable, and `uuid <>
  -- NULL` is NULL, which an IF treats as false — i.e. the guard would fall open
  -- on exactly the task that has no lead. Same three-valued-logic trap 0021
  -- exists to close.
  if v_assignee is distinct from new.worker_id then
    raise exception 'task % has no such lead (assignee is %)', new.task_id, v_assignee
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger task_assignees_lead_matches_task
  before insert or update of role, worker_id, task_id
  on task_assignees
  for each row execute function private.assert_task_assignee_lead_matches();

-- ── the mirror: tasks.assignee_worker_id -> the lead row ───────────────────
-- Fires on insert and on every change of assignee_worker_id. Not a
-- reconciliation job and not bidirectional: there is exactly ONE direction of
-- flow, which is what makes the pair impossible to desynchronise.
--
-- Three things happen, in this order, and the order matters:
--   1. the old lead row goes,
--   2. any COLLABORATOR row for the incoming lead goes — a person promoted to
--      lead must not remain listed as their own helper, and `unique (task_id,
--      worker_id)` would otherwise refuse step 3 outright,
--   3. the new lead row is written.
create or replace function private.sync_task_lead_assignee()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.task_assignees where task_id = new.id and role = 'lead';
  if new.assignee_worker_id is not null then
    delete from public.task_assignees
     where task_id = new.id and worker_id = new.assignee_worker_id;
    insert into public.task_assignees (company_id, task_id, worker_id, role)
    values (new.company_id, new.id, new.assignee_worker_id, 'lead');
  end if;
  return null;
end;
$$;

-- AFTER, not BEFORE: assert_task_assignee_lead_matches reads
-- tasks.assignee_worker_id, so the task's own row has to already carry the new
-- value by the time the insert above runs. A BEFORE trigger would race its own
-- guard and every reassignment would fail.
--
-- `when` clause on the UPDATE branch so an ordinary edit — a title, a due date,
-- the hundreds of updated_at writes a day — does no work at all.
create trigger tasks_sync_lead_assignee_ins
  after insert on tasks
  for each row execute function private.sync_task_lead_assignee();

create trigger tasks_sync_lead_assignee_upd
  after update of assignee_worker_id on tasks
  for each row
  when (old.assignee_worker_id is distinct from new.assignee_worker_id)
  execute function private.sync_task_lead_assignee();

-- ── backfill ───────────────────────────────────────────────────────────────
-- Mandatory, and for the same reason 0026's pushed_at backfill was: the triggers
-- above only fire on writes from here on, so without this every task that
-- already has an assignee would be missing its lead row until somebody happened
-- to reassign it. Nothing READS the lead row (see the header), so a gap would
-- be silent rather than broken — which is precisely why it has to be closed
-- here rather than discovered later.
insert into task_assignees (company_id, task_id, worker_id, role)
select t.company_id, t.id, t.assignee_worker_id, 'lead'
  from tasks t
 where t.assignee_worker_id is not null
on conflict do nothing;

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table task_assignees enable row level security;

-- SELECT only — deliberately the same divergence from the uniform three-policy
-- shape that task_reviews makes (0018), and for a comparable reason. Every
-- write goes through set_task_collaborators() below, which is SECURITY DEFINER
-- and therefore unaffected by policies and grants.
--
-- Why not a plain INSERT/DELETE policy, which would be less machinery: because
-- "who is on this task" is a SET, and a client-side edit of a set is N inserts
-- and M deletes with no transaction around them. A half-applied crew — the new
-- helper added, the old one not removed — is exactly the state that produces a
-- wrong 07:00 message to a real person. It also keeps the schema's no-DELETE
-- posture intact: there is no DELETE policy on this table (push_subscriptions
-- remains the only one in the schema), so a tenant cannot quietly erase the
-- record of who was on a job.
create policy task_assignees_select_company on task_assignees
  for select to authenticated
  using (company_id = (select private.current_company_id()));

-- Supabase default-grants ALL on new public tables, so revoke first.
revoke all on table task_assignees from anon, authenticated;
grant select on table task_assignees to authenticated;

-- ── set_task_collaborators ─────────────────────────────────────────────────
-- Replace the whole collaborator set for one task, atomically. The single
-- writer, called by the app (a manager tapping names on /tarefas/[id]) and by
-- the agent's create_task / update_task.
--
-- SECURITY DEFINER, so RLS does NOT apply and the auth.uid() check below is the
-- ENTIRE tenant boundary — the same shape, and the same caveat, as
-- open_task_review (0018) and revert_translation_batch (0015).
-- scripts/rls-isolation-matrix.mjs attacks it directly for that reason.
-- auth.uid() is null for the service role and for the cron, which is allowed
-- through deliberately.
create function set_task_collaborators(p_task uuid, p_workers uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_lead    uuid;
  v_wanted  uuid[];
  v_count   integer;
begin
  -- FOR UPDATE: without the lock a concurrent reassignment could land between
  -- this read and the insert below, leaving the freshly-promoted lead also
  -- listed as their own collaborator. Same device as open_task_review (0018).
  select company_id, assignee_worker_id into v_company, v_lead
    from tasks where id = p_task for update;
  if v_company is null then
    raise exception 'task % not found', p_task using errcode = 'no_data_found';
  end if;

  -- IS DISTINCT FROM, not <>: private.current_company_id() is NULL for an
  -- authenticated user with no profiles row yet, and `uuid <> NULL` is NULL,
  -- which an IF skips — the exact three-valued-logic hole 0021 was written to
  -- close, in a function of exactly this shape.
  if auth.uid() is not null
     and v_company is distinct from private.current_company_id() then
    raise exception 'task % is not yours', p_task using errcode = 'insufficient_privilege';
  end if;

  -- Dedupe, drop nulls, and drop the LEAD if they were named: somebody cannot
  -- help themselves. Dropped silently rather than raised — "Miguel e o Joao
  -- fazem a pintura" with Miguel already leading is a perfectly sensible thing
  -- for a manager to say, and refusing it would be pedantry. The return value
  -- is the count actually written, so no caller has to guess.
  select coalesce(array_agg(distinct w), '{}'::uuid[]) into v_wanted
    from unnest(coalesce(p_workers, '{}'::uuid[])) as w
   where w is not null and w is distinct from v_lead;

  -- A crew is people, not a mailing list. The cap bounds the fan-out of both
  -- daily sends (one paid template per person) and the size of a briefing.
  if array_length(v_wanted, 1) > 20 then
    raise exception 'too many collaborators for task % (max 20)', p_task
      using errcode = 'check_violation';
  end if;

  -- Replace, never merge. The caller states the whole set, which is what makes
  -- "remove Joao" expressible at all without a DELETE grant.
  -- `<> ALL (empty array)` is vacuously TRUE in Postgres, so the empty set
  -- correctly removes everybody rather than needing a branch of its own.
  delete from task_assignees
   where task_id = p_task and role = 'collaborator'
     and worker_id <> all (v_wanted);

  insert into task_assignees (company_id, task_id, worker_id, role)
  select v_company, p_task, w, 'collaborator' from unnest(v_wanted) as w
  on conflict (task_id, worker_id) do nothing;

  -- Counted from the table rather than from the array: the row is the fact, and
  -- the cross-company guard above may have rejected the statement before we get
  -- here anyway. `updated_at` is bumped so the board and every revalidated page
  -- reflect that this task changed.
  select count(*) into v_count
    from task_assignees where task_id = p_task and role = 'collaborator';
  update tasks set updated_at = now() where id = p_task;
  return v_count;
end;
$$;

revoke execute on function set_task_collaborators(uuid, uuid[]) from public, anon;
grant execute on function set_task_collaborators(uuid, uuid[]) to authenticated, service_role;

-- ── task_board, extended by APPENDING two columns ──────────────────────────
-- Appending only, per AGENTS.md and per Postgres, which forbids reordering or
-- retyping a replaced view. The body below is copied from 0029 — the LATEST
-- replacement, not 0013 — for the reason 0029's own header gives.
--
-- Why on the view at all rather than a second query in each reader: because
-- "who is on this task today" has to have exactly ONE definition, in SQL, for
-- the same reason the active-today window does. The 07:00 briefing, the
-- afternoon check-in, the board and the agent all read this view; a
-- TypeScript-side join in one of them is how the crew hears one thing and the
-- manager sees another.
--
-- The two arrays are INDEX-ALIGNED — same ORDER BY, same source rows — so a
-- reader may zip them. Collaborators only: the lead is already on the row as
-- assignee_worker_id / worker_name, and duplicating it here would create the
-- second definition this column exists to avoid.
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
  j.address as job_address,
  -- APPENDED by 0035 (issue #44). Everything above this line is byte-identical
  -- to 0029. Empty arrays, never NULL, so a reader never has to distinguish
  -- "no collaborators" from "nobody has looked".
  ca.worker_ids as collaborator_worker_ids,
  ca.worker_names as collaborator_names
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
-- 0035. coalesce to an empty array INSIDE the lateral, so the columns are
-- never null and no reader has to branch on it. Ordered by name then id — the
-- same ORDER BY in both aggregates, which is what makes them index-aligned.
left join lateral (
  select
    coalesce(array_agg(cw.id   order by cw.name, cw.id), '{}'::uuid[]) as worker_ids,
    coalesce(array_agg(cw.name order by cw.name, cw.id), '{}'::text[]) as worker_names
  from task_assignees ta
  join workers cw on cw.id = ta.worker_id
  where ta.task_id = t.id and ta.role = 'collaborator'
) ca on true
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
    -- 0029: the start-window conjunct. A deadline two working days out is only
    -- a risk once the task could already have been started; before that it is
    -- merely scheduled. Null start_date still fires -- see 0029's header.
    (c.is_open and t.status = 'pending'
       and t.due_date is not null
       and t.due_date >= d.today
       and t.due_date <= c.due_soon_until
       and (t.start_date is null or t.start_date <= d.today))       as risk_due_soon,
    (c.is_open and ld.late_titles is not null)                      as risk_late_dependency,
    -- coalesce, not `j.status = 'paused'`: job_id is nullable, and a
    -- three-valued boolean here is exactly the bug 0006 exists to fix.
    (c.is_open and coalesce(j.status, '') = 'paused')               as risk_paused_job
) r;

-- create or replace view preserves existing grants, but restating them costs
-- nothing and makes this file readable on its own.
grant select on task_board to authenticated, service_role;
