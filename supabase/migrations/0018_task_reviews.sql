-- The completion claim, and the manager's control over it.
--
-- Until now status='done' was an instantaneous, unaudited field flip: no
-- completed_at, no completed_by, no evidence, no reviewer. PRD 4 adds a
-- WORKER-declared completion path, and a worker's claim must never silently
-- become 'done'. This migration builds the landing zone it lands in.

-- ── the new status ─────────────────────────────────────────────────────────
-- Same drop-and-recreate shape as 0002 did for proposals_status_check.
-- Placed between in_progress and blocked so the enum reads in lifecycle order;
-- nothing depends on the ARRAY's ordering.
alter table tasks drop constraint tasks_status_check;
alter table tasks add constraint tasks_status_check
  check (status in ('pending', 'in_progress', 'pending_review', 'blocked', 'done', 'cancelled'));

-- Five existing SQL surfaces see this new value. All five are already
-- correct and are deliberately NOT edited — recorded here because the next
-- person to add a status will need the same map:
--
--   task_board.is_open (0013:71) is `status not in ('done','cancelled')` — a
--     DENYLIST. pending_review therefore stays OPEN: still on the Tarefas
--     board, still counted overdue when its due_date has passed. That is the
--     whole safety property: a false completion claim stays visible.
--     Note the asymmetry INSIDE that same view: risk_late_start and
--     risk_due_soon (0013:116-121) are gated on `status = 'pending'` —
--     allowlists — so a pending_review task is never "at risk". Intended.
--     "At risk of starting late" is meaningless for work already declared
--     finished; overdue is the signal that matters, and it still fires.
--
--     A third signal in the SAME view, task_board.risk_late_dependency
--     (0013:92), scans predecessor tasks with `x.status not in
--     ('done','cancelled')` — a DENYLIST. A task declared finished but not
--     yet approved therefore still counts as a late dependency blocking its
--     successors. Defensible (it is not confirmed done yet), but it is a
--     real behaviour change and sits in the same view as the allowlist
--     asymmetry above.
--
--   dispatch_tasks_today (0003:34) is `status in ('pending','in_progress')` —
--     an ALLOWLIST, so it excludes the new status with no edit. The view
--     definition stays byte-identical against
--     docs/plans/dispatch-viewdef-baseline.sql, as AGENTS.md requires.
--
--   dashboard_tasks (0006:31, replacing 0005:71) is `status not in
--     ('done','cancelled')` — a DENYLIST like task_board, so pending_review
--     tasks DO appear in it. Superseded predecessor of task_board; no live
--     reader and no new ones.
--
--   dashboard_obras.pendentes (0005:82-83) counts `status not in
--     ('done','cancelled')` — a DENYLIST, so a pending_review task counts as
--     *pendente* on the Obras screen. Behaviourally right, and unlike
--     dashboard_tasks this view IS live-read (apps/web/app/dashboard-data.ts,
--     typed as DashboardObra in packages/ui/src/dashboard-ui.tsx:17).

-- ── task_reviews: the control task ─────────────────────────────────────────
-- Deliberately NOT a row in `tasks`. A tasks row automatically enters
-- task_board, the 07:00 briefing, materials_outlook, every agenda horizon and
-- the operator's per-status counts — polluting every existing surface with
-- rows that are not site work. tasks.source is also constrained to
-- ('manager','capo') (0001:45) and the schema treats tasks as real
-- construction work. Own table, own read surface, rendered onto the Tarefas
-- board by joining onto the task's existing row at the page level.
create table task_reviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  task_id uuid not null references tasks(id),
  -- NULL = manager-initiated ("I want to go check this"), non-null = a worker
  -- declared it finished. Same nullable-means-something posture as
  -- workers.language (0016).
  declared_by_worker_id uuid references workers(id),
  declared_at timestamptz not null default now(),
  -- The worker's own words. The ONE place worker-authored text crosses to the
  -- manager, which is why the UI renders it as an attributed quote and never
  -- as UI copy. It cannot authorize anything: the manager-side guard
  -- (packages/core/src/capabilities/guard.ts) matches manager_instruction
  -- against recentUserTexts, drawn from the MANAGER's own thread, so a note
  -- saying "ignore previous instructions" produces at worst one approval card
  -- the manager rejects.
  note text,
  -- 'dismissed' is the manager saying "Nao precisa controlo" — the photos were
  -- enough. It closes the review and the task without a site visit, and is a
  -- genuinely different outcome from 'approved' (which means someone looked).
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'dismissed')),
  resolved_by uuid references profiles(id),
  resolved_at timestamptz
);

-- At most one live review per task. This index IS the throttle — a worker
-- double-declaring, a double-tapped button and two open tabs all become
-- impossible at the schema level rather than by app-side guessing. Same
-- device as translation_batches_one_active_idx (0015).
create unique index task_reviews_one_pending_idx
  on task_reviews (task_id) where status = 'pending';

-- The board join: "every pending review for this tenant", newest first.
create index task_reviews_company_status_idx
  on task_reviews (company_id, status, declared_at desc);

-- ── cross-company FK guard ─────────────────────────────────────────────────
-- RLS checks a row's OWN company_id, never the company of the rows its FKs
-- point at. Exactly the hole 0009 exists to close, and task_reviews has three
-- of them. Enforced as a trigger so it binds on every path — user JWT,
-- service-role, postgres, and the SECURITY DEFINER functions below.
create or replace function private.assert_task_review_fks_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.tasks t
    where t.id = new.task_id and t.company_id = new.company_id
  ) then
    raise exception 'task_id % is not in company %', new.task_id, new.company_id
      using errcode = 'check_violation';
  end if;
  if new.declared_by_worker_id is not null and not exists (
    select 1 from public.workers w
    where w.id = new.declared_by_worker_id and w.company_id = new.company_id
  ) then
    raise exception 'declared_by_worker_id % is not in company %',
      new.declared_by_worker_id, new.company_id using errcode = 'check_violation';
  end if;
  if new.resolved_by is not null and not exists (
    select 1 from public.profiles p
    where p.id = new.resolved_by and p.company_id = new.company_id
  ) then
    raise exception 'resolved_by % is not in company %', new.resolved_by, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger task_reviews_fks_same_company
  before insert or update of company_id, task_id, declared_by_worker_id, resolved_by
  on task_reviews
  for each row execute function private.assert_task_review_fks_same_company();

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table task_reviews enable row level security;

-- Written out rather than generated in the 0007/0015 loop, because this table
-- deliberately DIVERGES from the uniform three-policy shape: SELECT only, no
-- INSERT and no UPDATE policy. Every write — filing a claim as well as
-- resolving one — goes through the SECURITY DEFINER RPCs below
-- (open_task_review / resolve_task_review), which run as the table owner and
-- bypass RLS/grants entirely, so a policy for the RPCs to satisfy would be
-- pointless. A direct tenant INSERT would create a task_reviews row without
-- ever flipping the task to 'pending_review', breaking the "a review exists
-- => the task is in review" invariant Tasks 4-5 depend on. A direct UPDATE
-- could set the review to 'approved' while leaving the task open — precisely
-- the half-applied state this feature exists to prevent.
create policy task_reviews_select_company on task_reviews
  for select to authenticated
  using (company_id = (select private.current_company_id()));

-- ── column grants ──────────────────────────────────────────────────────────
-- Supabase default-grants ALL on new public tables, so revoke first.
--
-- Tenants get SELECT only — no INSERT, no UPDATE. Every write goes through
-- open_task_review() / resolve_task_review(), which run SECURITY DEFINER as
-- the table owner and are unaffected by this revoke. A tenant cannot file a
-- claim except through the RPC, and so cannot forge an outcome either:
-- status, resolved_by, resolved_at and declared_at are only ever set by code
-- that also moves the task's own status in the same transaction. Same
-- grant-layer posture as translation_items.old_value (0015) — the evidence
-- is immutable to the tenant that owns it.
revoke all on table task_reviews from anon, authenticated;
grant select on table task_reviews to authenticated;

-- ── open_task_review ───────────────────────────────────────────────────────
-- Moves the task to pending_review and files the claim, atomically. This is
-- also the exact seam PRD 4's restricted worker agent will call.
--
-- SECURITY DEFINER, so RLS does NOT apply and the auth.uid() check below is
-- the entire tenant boundary — same shape and same caveat as
-- revert_translation_batch (0015). auth.uid() is null for the service role and
-- for the cron, which is allowed through deliberately.
create function open_task_review(
  p_task uuid,
  p_worker uuid default null,
  p_note text default null
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
  insert into task_reviews (company_id, task_id, declared_by_worker_id, note)
  values (v_company, p_task, p_worker, p_note)
  returning id into v_review;

  update tasks set status = 'pending_review', updated_at = now() where id = p_task;

  return v_review;
end;
$$;

revoke execute on function open_task_review(uuid, uuid, text) from public, anon;
grant execute on function open_task_review(uuid, uuid, text) to authenticated, service_role;

-- ── resolve_task_review ────────────────────────────────────────────────────
-- Approve  → review 'approved',  task 'done'        (someone looked, it is fine)
-- Reject   → review 'rejected',  task 'in_progress' (go back and finish it)
-- Dismiss  → review 'dismissed', task 'done'        (no site visit needed)
--
-- Returns the task and its obra so the caller can revalidate the right paths
-- without a second read. Output columns are prefixed out_ because a bare
-- task_id would be ambiguous against task_reviews.task_id inside the body.
create function resolve_task_review(p_review uuid, p_resolution text)
returns table (out_task_id uuid, out_task_status text, out_job_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_task    uuid;
  v_new     text;
  v_job     uuid;
begin
  if p_resolution not in ('approved', 'rejected', 'dismissed') then
    raise exception 'invalid resolution %', p_resolution using errcode = 'check_violation';
  end if;
  v_new := case p_resolution when 'rejected' then 'in_progress' else 'done' end;

  -- Compare-and-set on status='pending': concurrent approve clicks cannot both
  -- land, and the second gets a clear error rather than silently re-resolving
  -- a review someone else already closed. Same device as 0002's 'executing'
  -- claim state.
  update task_reviews
     set status = p_resolution,
         resolved_by = auth.uid(),
         resolved_at = now()
   where id = p_review
     and status = 'pending'
     and (auth.uid() is null or company_id = private.current_company_id())
   returning company_id, task_reviews.task_id into v_company, v_task;

  if v_task is null then
    raise exception 'review % is not yours, or is not pending', p_review
      using errcode = 'no_data_found';
  end if;

  -- status = 'pending_review' guard: open_task_review refuses to open a
  -- review on a done/cancelled task, but without this, resolve had no
  -- matching guard — open a review, cancel the task directly through the
  -- tasks UPDATE policy, then approve, and 'cancelled' becomes 'done'. If
  -- the task moved out of pending_review since the review was filed, this
  -- update touches no row and the whole statement (including the
  -- task_reviews update above) rolls back with the exception.
  update tasks set status = v_new, updated_at = now()
   where id = v_task and company_id = v_company and status = 'pending_review'
   returning job_id into v_job;

  if not found then
    raise exception 'task % is no longer awaiting review', v_task
      using errcode = 'check_violation';
  end if;

  return query select v_task, v_new, v_job;
end;
$$;

revoke execute on function resolve_task_review(uuid, text) from public, anon;
grant execute on function resolve_task_review(uuid, text) to authenticated, service_role;
