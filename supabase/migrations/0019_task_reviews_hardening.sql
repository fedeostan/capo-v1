-- Hardening pass on 0017, from Task 1's quality review (fix round 1).
-- 0017 is unmerged and lives only on this branch, so the fixes below were
-- also folded directly into 0018_task_reviews.sql in place — a fresh
-- database gets the corrected functions/grants on first apply. This file is
-- the delta actually needed against a database where 0017 already ran
-- (idempotent by construction: two create-or-replace, one drop-policy-if-
-- exists-shaped drop, one revoke), so re-running it after a from-scratch
-- 0017 apply is a harmless no-op.

-- ── C1 (critical): open_task_review's tenant guard failed OPEN ────────────
-- private.current_company_id() returns NULL for an authenticated user with
-- no profiles row yet (self-serve signup before complete_onboarding runs —
-- see apps/web/app/(public)/registar/actions.ts). `v_company <> NULL`
-- evaluates to NULL, and `true and NULL` is NULL, so the old `<>` guard
-- silently did not fire and the write proceeded. Because this function is
-- SECURITY DEFINER, that check is the ENTIRE tenant boundary — this was a
-- blind cross-tenant write for any confirmed-but-not-onboarded account.
--
-- M2 (folded into the same function): FOR UPDATE row lock on the task read,
-- closing the TOCTOU window where a concurrent transaction changes the
-- task's status between the read and the update below, making the
-- done/cancelled guard advisory. Same device as revert_translation_batch
-- (0015).
create or replace function open_task_review(
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

-- ── M1: resolve_task_review could resurrect a closed task ─────────────────
-- open_task_review refuses to open a review on a done/cancelled task, but
-- resolve had no matching guard: open a review, cancel the task directly
-- through the tasks UPDATE policy, then approve, and 'cancelled' becomes
-- 'done'. Added a status = 'pending_review' guard on the tasks UPDATE, with
-- a loud failure so the task_reviews update rolls back with it.
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

-- ── M6: revoke the INSERT grant; RPC-only writes ───────────────────────────
-- A column-scoped INSERT grant let a tenant insert a review row directly
-- through PostgREST, which never flips the task to 'pending_review' —
-- breaking the "a review exists => the task is in review" invariant Tasks
-- 4-5 depend on. Nothing needs the direct insert; every write path goes
-- through the RPCs, which run as the owner and are unaffected.
drop policy if exists task_reviews_insert_company on task_reviews;
revoke insert on table task_reviews from authenticated;
