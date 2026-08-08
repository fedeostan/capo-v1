-- Closes a hole the fix-round-1 hardening (0018) left open: M1 made
-- resolve_task_review refuse to act on a task that has already left
-- pending_review, but nothing stopped the task leaving pending_review out
-- of band in the first place, and there was then no way back. Task 2 widens
-- update_task's status enum to accept pending_review, and update_task
-- (packages/core/src/capabilities/tasks.ts) writes status straight through
-- with no precondition — so "marca a tarefa como concluída" while a claim
-- is outstanding sets the task to 'done' and strands the review at
-- 'pending' permanently: task_reviews_one_pending_idx blocks a replacement
-- review, tenants have no UPDATE grant on task_reviews (0018, M6, working
-- as intended), and nothing can move the task back to pending_review.
-- Recovery would otherwise need service-role SQL.
--
-- The fix is structural, not a caller-side precondition, because this
-- project's rule is that safety boundaries live in code every path must
-- cross, not in prompts or callers (see AGENTS.md). A trigger on `tasks`
-- is the only thing every path crosses — the agent tool today, any future
-- write path tomorrow, and the board UI (which Task 5 already keeps off
-- pending_review tasks, but a trigger doesn't need that promise kept).

-- ── the new review outcome ─────────────────────────────────────────────────
-- 'superseded' is nobody's decision — it is the system noting that the
-- question a pending review was asking ("is this task actually done?")
-- stopped being answerable because the task moved on without the review's
-- involvement. That is why it is not folded into 'dismissed': 'dismissed'
-- is a manager choosing not to look; 'superseded' is nobody choosing
-- anything.
alter table task_reviews drop constraint task_reviews_status_check;
alter table task_reviews add constraint task_reviews_status_check
  check (status in ('pending', 'approved', 'rejected', 'dismissed', 'superseded'));

-- ── the trigger ─────────────────────────────────────────────────────────────
-- SECURITY DEFINER: this fires inside whatever UPDATE moved the task, which
-- may be an authenticated caller with no UPDATE grant on task_reviews at all
-- (0018, M6). Same posture as assert_task_review_fks_same_company (0017).
--
-- Only resolved_at is set, never resolved_by — nobody made a resolution
-- decision here, so attributing one would be a fabrication. This also keeps
-- the update outside the column list
-- (company_id, task_id, declared_by_worker_id, resolved_by) that
-- task_reviews_fks_same_company (0017) triggers on, so that guard does not
-- fire for a supersede and has nothing to object to.
--
-- `where status = 'pending'` is what makes this safe to fire unconditionally
-- on every exit from pending_review, including the legitimate one through
-- resolve_task_review(): by the time that RPC's own `update tasks` runs (and
-- this trigger with it), resolve_task_review has ALREADY moved the review to
-- 'approved'/'rejected'/'dismissed', so this trigger's WHERE matches no row
-- and the update is a no-op. That depends entirely on resolve_task_review
-- updating task_reviews before it updates tasks — see the load-bearing
-- comment on that ordering in the create-or-replace below. Verified
-- empirically for all three resolutions (see task-1-report.md, fix round 2)
-- rather than assumed.
create or replace function private.supersede_task_review()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.task_reviews
     set status = 'superseded', resolved_at = now()
   where task_id = new.id and status = 'pending';
  return new;
end;
$$;

-- AFTER UPDATE, not BEFORE: the task's own status change is the fact being
-- recorded, so it should not be blockable by anything this trigger does.
-- The WHEN clause fires only on a genuine exit from pending_review — a
-- pending_review -> pending_review update (e.g. an unrelated column touch
-- that still lists status, or a no-op write) has
-- `new.status is distinct from 'pending_review'` false, so it does not fire.
-- task_reviews_one_pending_idx needs no change: 'superseded' is not
-- 'pending', so the partial unique index frees up the instant this trigger
-- runs, and a fresh review can be opened on the task's next pending_review
-- pass.
create trigger tasks_supersede_review
  after update of status on tasks
  for each row
  when (old.status = 'pending_review' and new.status is distinct from 'pending_review')
  execute function private.supersede_task_review();

-- ── lock-order asymmetry (accepted, not restructured) ───────────────────────
-- resolve_task_review (below) locks task_reviews first, then tasks: its
-- `update task_reviews ... where status = 'pending'` runs before its
-- `update tasks ... where status = 'pending_review'`. This trigger runs the
-- other way around: it fires AFTER an UPDATE on tasks has already taken that
-- row's lock, and only then does `update task_reviews` inside
-- supersede_task_review() above — tasks first, task_reviews second.
--
-- So a manager calling resolve_task_review() concurrently with anything that
-- writes tasks.status directly (the agent's update_task, or a future
-- completeTask-style path) can take the two locks in opposite orders.
-- Postgres detects the resulting wait cycle and aborts one transaction with
-- `40P01 deadlock_detected` — the loser sees a clear, retryable error, and
-- there is no corruption or half-applied state either way; the aborted
-- transaction rolls back in full. This is expected and safe, not a bug to
-- chase if it shows up in logs. Restructuring to a single lock order would
-- mean either resolve_task_review updating tasks before task_reviews
-- (breaking the load-bearing ordering documented on that function below,
-- which is what keeps a legitimate approve/reject/dismiss from overwriting
-- itself with 'superseded') or this trigger somehow locking task_reviews
-- before its own firing UPDATE locks tasks (not possible — the trigger only
-- runs after that lock is already held). Given both paths are rare, both are
-- single-row, and the failure mode is a clean abort-and-retry, that
-- restructuring cost is not worth paying.

-- ── resolve_task_review: same body, one added comment ──────────────────────
-- Behaviourally identical to 0017/0018's version. The only change is the
-- comment above the task_reviews update, which was silently load-bearing for
-- tasks_supersede_review above and needed to say so before the next person
-- reorders these two statements and turns every approval into a supersede.
create or replace function resolve_task_review(p_review uuid, p_resolution text)
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

  -- ORDER IS LOAD-BEARING (0019): this update must run BEFORE the `update
  -- tasks` below. tasks_supersede_review (0019) fires on every tasks.status
  -- exit from pending_review, this call's own included, and only skips a row
  -- whose task_reviews.status is no longer 'pending'. Moving this review to
  -- its resolution FIRST is what makes the trigger's `where status =
  -- 'pending'` match nothing when it fires on the `update tasks` below — a
  -- no-op, as intended. Reorder these two statements and every legitimate
  -- approve/reject/dismiss would instead overwrite itself with 'superseded'.
  --
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
