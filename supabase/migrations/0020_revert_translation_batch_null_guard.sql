-- revert_translation_batch's tenant guard failed OPEN on a NULL company.
--
-- Found while reviewing PR #31 (issue #19), where the identical defect had been
-- introduced into open_task_review by copying this very function's pattern, and
-- was fixed there in 0018_task_reviews_hardening.sql. This migration fixes the
-- original. Unlike 0018 — which could fold its fix back into the unmerged 0017
-- because that file had never been applied anywhere — 0015 is live. Rewriting
-- it in place would make the file describe SQL this project never ran, so the
-- correction lands here instead and 0015 stays a faithful record.
--
-- ── the bug ────────────────────────────────────────────────────────────────
-- The guard read:
--
--   if auth.uid() is not null
--      and v_batch.company_id <> private.current_company_id() then
--     raise exception 'batch not found';
--
-- private.current_company_id() (0007) is
--   select company_id from public.profiles where id = auth.uid()
-- which returns NULL — not zero rows, NULL — for an authenticated user with no
-- profiles row. Then, under three-valued logic:
--
--   v_batch.company_id <> NULL   →  NULL
--   true and NULL                →  NULL
--   if NULL then                 →  does not fire
--
-- The guard was skipped entirely and execution fell through to the replay loop.
--
-- ── why that state is reachable, and persistent ────────────────────────────
-- Signup and onboarding are separate steps. apps/web/app/(public)/registar/
-- actions.ts creates the auth user; the profiles row is written later, and only
-- by complete_onboarding() from apps/web/app/(public)/onboarding/actions.ts. A
-- user who confirms their email and never submits the onboarding form holds a
-- valid `authenticated` JWT with current_company_id() = NULL indefinitely. This
-- is not an exotic race — it is every abandoned signup.
--
-- ── why it was the whole boundary ──────────────────────────────────────────
-- The function is SECURITY DEFINER, so RLS does not apply to it and this check
-- is the entire tenant boundary. Any such user holding a batch uuid could
-- revert another tenant's batch, writing to that tenant's tasks / jobs /
-- workers / memories rows and flipping their companies.language back. Note the
-- call does not even error in that case — it returns {"reverted": N} and looks
-- like a success.
--
-- ── the fix ────────────────────────────────────────────────────────────────
-- IS DISTINCT FROM is the only comparison that returns a real boolean when
-- either side is NULL: it treats "one side is NULL, the other is not" as a
-- genuine mismatch and the guard fails closed. This is the exact form
-- open_task_review took in 0018.
--
-- The general rule, and the reason only this one call site was affected: a
-- tenant check written as an IF fails OPEN on a NULL company, because IF needs
-- `true` to branch and NULL is not true. The same comparison in a WHERE clause
-- fails CLOSED, because WHERE also needs `true` and a non-matching row is the
-- safe outcome. finalize_proposal (0007/0009) and resolve_task_review (0018)
-- use the WHERE form and were never exposed; so is every RLS policy in the
-- schema, which is why an orphan user is invisible to ordinary table reads and
-- this RPC was the only door. A sweep of every SECURITY DEFINER function in
-- supabase/migrations/ found no other instance of the IF form.
--
-- Body is otherwise byte-identical to 0015. Regression coverage lives in
-- scripts/rls-isolation-matrix.mjs as the orphan-actor attack — two tenants
-- structurally cannot catch this class of bug, because every ordinary attacker
-- has a company and therefore never produces the NULL.
create or replace function revert_translation_batch(p_batch uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.translation_batches%rowtype;
  v_item  public.translation_items%rowtype;
  v_reverted int := 0;
  v_skipped  int := 0;
  v_rows int;
begin
  -- for update serialises double-clicks: the loser sees status='reverted'.
  select * into v_batch from public.translation_batches
    where id = p_batch for update;
  if not found then
    raise exception 'batch not found';
  end if;
  -- IS DISTINCT FROM, not <>: private.current_company_id() is NULL for an
  -- authenticated user with no profiles row (self-serve signup before
  -- complete_onboarding runs). With <>, that NULL made the whole condition
  -- NULL, the IF did not fire, and this SECURITY DEFINER function's entire
  -- tenant boundary fell open. See the header for the full trace.
  if auth.uid() is not null
     and v_batch.company_id is distinct from private.current_company_id() then
    -- Same message as a genuine miss: never confirm another tenant's id exists.
    raise exception 'batch not found';
  end if;
  if v_batch.reverted_at is not null
     or v_batch.status not in ('completed', 'failed', 'running') then
    raise exception 'batch is not revertible';
  end if;

  for v_item in
    select * from public.translation_items
      where batch_id = p_batch and status = 'applied'
      order by id
  loop
    -- Conditional replay. A row the manager edited by hand AFTER the
    -- translation no longer matches new_value, and their edit must survive the
    -- undo: we only restore what this batch actually wrote.
    if v_item.column_name = 'materials' then
      -- tasks.materials is the only text[] in scope, so it is handled directly
      -- rather than through format(): reconstruct both arrays from jsonb.
      update public.tasks
        set materials = array(select jsonb_array_elements_text(v_item.old_value)),
            updated_at = now()
        where id = v_item.row_id
          and company_id = v_batch.company_id
          and materials is not distinct from
              array(select jsonb_array_elements_text(v_item.new_value));
    else
      -- table_name/column_name come from the paired CHECK in 0015, which is a
      -- fixed six-element allowlist — %I here cannot be steered by user input.
      execute format(
        'update public.%1$I set %2$I = $1%3$s
           where id = $2 and company_id = $3 and %2$I is not distinct from $4',
        v_item.table_name,
        v_item.column_name,
        -- Only tasks and memories carry updated_at (0001); jobs and workers do
        -- not, and naming a missing column would abort the whole revert.
        case when v_item.table_name in ('tasks', 'memories')
             then ', updated_at = now()' else '' end
      ) using v_item.old_value #>> '{}',
              v_item.row_id,
              v_batch.company_id,
              v_item.new_value #>> '{}';
    end if;

    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      update public.translation_items set status = 'reverted' where id = v_item.id;
      v_reverted := v_reverted + 1;
    else
      -- Diverged (hand-edited or deleted). Leave it 'applied' so the audit
      -- trail still shows this batch touched it, and report it as skipped.
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  -- Put the dial back too. Without this the text reverts and Capo immediately
  -- starts re-fragmenting the dashboard with tomorrow's rows. Guarded on the
  -- current value so a deliberate later change is not clobbered.
  update public.companies
    set language = v_batch.from_locale
    where id = v_batch.company_id and language = v_batch.to_locale;

  update public.translation_batches
    set status = 'reverted', reverted_at = now()
    where id = p_batch;

  return jsonb_build_object('reverted', v_reverted, 'skipped', v_skipped);
end;
$$;

-- create or replace preserves the existing ACL, so these are a no-op against a
-- database that already ran 0015. Re-asserted anyway so this file states the
-- function's full privilege posture rather than making a reader cross-reference
-- 0015 to confirm anon still cannot reach it.
revoke execute on function revert_translation_batch(uuid) from public, anon;
grant execute on function revert_translation_batch(uuid) to authenticated, service_role;
