-- Reversible tenant-wide translation.
--
-- companies.language (0014) decides what Capo STORES. Until now flipping it
-- only affected rows written from then on, so a tenant that started in
-- Portuguese and switched to Spanish kept a permanently half-translated
-- dashboard with no way back. 0014's own comment states that as a constraint
-- ("nothing retranslates existing rows"); this migration is what relaxes it.
--
-- The dial stays a one-way door in the DB. What makes it safe is the snapshot:
-- every string the translator overwrites is recorded here BEFORE the write, so
-- revert_translation_batch() can put the tenant back exactly as it was — not a
-- round-trip re-translation, the original bytes.
--
-- Scope of a batch mirrors packages/core/src/translation/scope.ts exactly, and
-- the (table_name, column_name) check below is that list expressed in SQL.
-- Proper nouns (workers.name, jobs.client_name, jobs.address, companies.name)
-- are deliberately NOT translatable, and neither is anything conversational
-- (messages, proposals, summaries): the transcript is a record of what was
-- actually said, and capabilities/guard.ts authorizes writes by matching the
-- model's quote against it.

-- ── batches ────────────────────────────────────────────────────────────────
create table translation_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  from_locale text not null check (from_locale in ('pt-PT', 'es-ES', 'en-US')),
  to_locale   text not null check (to_locale   in ('pt-PT', 'es-ES', 'en-US')),
  check (from_locale <> to_locale),
  -- 'running' is not a claim state like proposals.executing — a batch is
  -- resumable by design, and both 'running' and 'failed' can be picked back up.
  -- Only 'completed' and 'reverted' are terminal.
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'reverted')),
  item_count int not null default 0,
  done_count int not null default 0,
  error text,
  origin text not null check (origin in ('web', 'chat')),
  -- NULLABLE on purpose: resolveProposal executes with userId = null (an
  -- approval click is not a conversation turn), so the chat path has no user.
  created_by uuid references profiles(id),
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz,
  reverted_at timestamptz,
  expires_at  timestamptz not null default (now() + interval '30 days')
);

create index translation_batches_company_created_idx
  on translation_batches (company_id, created_at desc);

-- One live batch per tenant. This index IS the throttle: double-submitted
-- forms, two open tabs, and a manager toggling the dial three times in a row
-- all become impossible at the schema level rather than by app-side guessing.
create unique index translation_batches_one_active_idx
  on translation_batches (company_id) where status in ('pending', 'running');

-- ── items: the snapshot ────────────────────────────────────────────────────
create table translation_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references translation_batches(id),
  -- Denormalised so RLS is the same company_id = current_company_id() shape as
  -- every other table (0007) with no join. row_id is polymorphic across four
  -- tables and therefore deliberately NOT a foreign key, so 0009's
  -- cross-company FK triggers do not apply here: this column plus RLS plus
  -- "the writer always filters its target by company_id" is the boundary.
  company_id uuid not null references companies(id),
  table_name  text not null,
  row_id uuid not null,
  column_name text not null,
  -- One (table, column) pair per translatable field — the SQL expression of
  -- packages/core/src/translation/scope.ts. Constraining the PAIR rather than
  -- the two columns independently is what makes the dynamic UPDATE in
  -- revert_translation_batch() safe: ('jobs','materials') cannot be stored, so
  -- format(%I) can never be pointed at a column that does not exist.
  check ((table_name, column_name) in (
    ('tasks', 'title'), ('tasks', 'description'), ('tasks', 'materials'),
    ('jobs', 'name'), ('workers', 'trade'), ('memories', 'content')
  )),
  -- jsonb, not text: tasks.materials is text[] and everything else is a scalar
  -- string. One column round-trips both losslessly; two typed columns would
  -- need a discriminator anyway and would be free to drift apart.
  old_value jsonb not null,
  new_value jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'applied', 'skipped', 'failed', 'reverted')),
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  -- Idempotency key: re-collecting a batch cannot duplicate a field, so a
  -- crashed-and-resumed run converges instead of stacking snapshots.
  unique (batch_id, table_name, row_id, column_name)
);

create index translation_items_batch_status_idx on translation_items (batch_id, status);

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table translation_batches enable row level security;
alter table translation_items enable row level security;

-- Same uniform three-policy shape as 0007, generated in a loop for the same
-- reason: so no table can drift from the pattern. No DELETE policy, matching
-- every other table in the schema — undo MARKS rows reverted, it never deletes
-- them, and purging past expires_at is a service-role operator chore.
do $$
declare t text;
begin
  foreach t in array array['translation_batches', 'translation_items'] loop
    execute format($f$
      create policy %1$I_select_company on %1$I
        for select to authenticated
        using (company_id = (select private.current_company_id()));
      create policy %1$I_insert_company on %1$I
        for insert to authenticated
        with check (company_id = (select private.current_company_id()));
      create policy %1$I_update_company on %1$I
        for update to authenticated
        using (company_id = (select private.current_company_id()))
        with check (company_id = (select private.current_company_id()));
    $f$, t);
  end loop;
end $$;

-- ── column grants: the snapshot is immutable ───────────────────────────────
-- The most important lines in this migration. A tenant may advance a batch and
-- record translations, but can never rewrite old_value, from_locale, to_locale
-- or company_id. The bytes undo replays are therefore protected at the grant
-- layer, not by convention — the same posture 0007 takes with profiles.company_id.
--
-- Supabase default-grants ALL on new public tables, so revoke first.
revoke all on table translation_batches from anon, authenticated;
grant select, insert on table translation_batches to authenticated;
grant update (status, item_count, done_count, error, started_at, finished_at)
  on table translation_batches to authenticated;

revoke all on table translation_items from anon, authenticated;
grant select, insert on table translation_items to authenticated;
grant update (new_value, status, applied_at)
  on table translation_items to authenticated;

-- ── undo ───────────────────────────────────────────────────────────────────
-- One statement, one transaction. A partially-applied undo is strictly worse
-- than no undo, and replaying 500 rows through PostgREST would be 500 round
-- trips inside a serverless function's duration limit. This is the one place in
-- the feature where atomicity is non-negotiable.
--
-- SECURITY DEFINER, so RLS does NOT protect it: the auth.uid() clause below is
-- the entire tenant boundary. Hardened exactly like finalize_proposal (0007) —
-- auth.uid() is null only for service/system callers, and anon cannot execute.
create function revert_translation_batch(p_batch uuid)
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
  if auth.uid() is not null
     and v_batch.company_id <> private.current_company_id() then
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
      -- table_name/column_name come from the paired CHECK above, which is a
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
revoke execute on function revert_translation_batch(uuid) from public, anon;
grant execute on function revert_translation_batch(uuid) to authenticated, service_role;
