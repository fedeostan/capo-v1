-- Auth + multi-tenancy. profiles links each auth.users row to a company; RLS
-- policies turn the deny-all posture (0001) into per-company access for
-- authenticated users. System paths are untouched by design: n8n connects as
-- the postgres role (table owner — RLS does not apply without FORCE) and the
-- app's service-role client bypasses RLS. The tenant key for every policy is
-- private.current_company_id(), derived from the caller's JWT — never from
-- client input.

-- ── profiles: the auth identity ↔ company link ────────────────────────────
-- One row per user; users → company is many-to-one (one manager today, more
-- later). phone is the manager's messaging identity (the shared Capo number
-- sends to it); unique so future inbound routing can resolve a sender.
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid not null references companies(id),
  full_name text not null check (char_length(full_name) between 1 and 120),
  phone text not null unique check (phone ~ '^\+[1-9]\d{7,14}$'),
  created_at timestamptz not null default now()
);
create index profiles_company_id_idx on profiles (company_id);
alter table profiles enable row level security;

-- Column-level guard: even through their own UPDATE policy, a user can only
-- touch full_name/phone — never company_id. Re-pointing a profile at another
-- company would be a full cross-tenant read, so it is blocked at the grant
-- layer, not just the policy layer.
revoke update on table profiles from authenticated;
grant update (full_name, phone) on table profiles to authenticated;

-- ── tenant helper ──────────────────────────────────────────────────────────
-- security definer so policies on OTHER tables don't recurse into profiles
-- RLS; lives in a non-exposed schema so PostgREST cannot call it as an RPC.
create schema if not exists private;
grant usage on schema private to authenticated;

create function private.current_company_id() returns uuid
language sql stable security definer set search_path = ''
as $$ select company_id from public.profiles where id = auth.uid() $$;
revoke execute on function private.current_company_id() from public;
grant execute on function private.current_company_id() to authenticated;

-- ── policies ───────────────────────────────────────────────────────────────
-- profiles: own row only. No INSERT policy — rows are created exclusively by
-- complete_onboarding() below (or the operator), never by direct API writes.
create policy profiles_select_own on profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_update_own on profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- companies: read/rename your own; creation happens only via onboarding.
create policy companies_select_own on companies
  for select to authenticated using (id = (select private.current_company_id()));
create policy companies_update_own on companies
  for update to authenticated
  using (id = (select private.current_company_id()))
  with check (id = (select private.current_company_id()));

-- Tables carrying company_id directly: one uniform shape, generated in a loop
-- so no table can drift from the pattern. SELECT/INSERT/UPDATE only — nothing
-- user-facing deletes today, so DELETE stays denied (no policy).
do $$
declare t text;
begin
  foreach t in array array[
    'workers', 'jobs', 'tasks', 'memories', 'conversations', 'proposals',
    'transcription_vocab'
  ] loop
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

-- messages / conversation_summaries scope through their conversation. The
-- subquery hits conversations under the caller's own RLS, so it can only ever
-- see own-company conversations.
create policy messages_select_company on messages
  for select to authenticated
  using (exists (
    select 1 from conversations c
    where c.id = conversation_id
      and c.company_id = (select private.current_company_id())
  ));
create policy messages_insert_company on messages
  for insert to authenticated
  with check (exists (
    select 1 from conversations c
    where c.id = conversation_id
      and c.company_id = (select private.current_company_id())
  ));

create policy conversation_summaries_select_company on conversation_summaries
  for select to authenticated
  using (exists (
    select 1 from conversations c
    where c.id = conversation_id
      and c.company_id = (select private.current_company_id())
  ));
create policy conversation_summaries_insert_company on conversation_summaries
  for insert to authenticated
  with check (exists (
    select 1 from conversations c
    where c.id = conversation_id
      and c.company_id = (select private.current_company_id())
  ));

-- task_dependencies scopes through tasks; INSERT checks BOTH edges so a
-- dependency can never point into another company's graph.
create policy task_dependencies_select_company on task_dependencies
  for select to authenticated
  using (exists (
    select 1 from tasks t
    where t.id = task_id
      and t.company_id = (select private.current_company_id())
  ));
create policy task_dependencies_insert_company on task_dependencies
  for insert to authenticated
  with check (
    exists (
      select 1 from tasks t
      where t.id = task_id
        and t.company_id = (select private.current_company_id())
    )
    and exists (
      select 1 from tasks t
      where t.id = depends_on_task_id
        and t.company_id = (select private.current_company_id())
    )
  );

-- dispatch_log: deliberately NO policies — stays deny-all for users. n8n
-- writes it as the postgres role and no user surface reads it.

-- ── finalize_proposal hardening ────────────────────────────────────────────
-- The function is SECURITY DEFINER, so RLS does not protect it: scope the
-- update to the caller's company when a JWT is present. auth.uid() is null
-- only for service/system callers — anon can no longer execute it at all
-- (revoked below), so null-uid cannot be spoofed through the API.
create or replace function finalize_proposal(p_id uuid, p_status text, p_event text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation uuid;
begin
  update proposals
    set status = p_status, resolved_at = now()
    where id = p_id
      and (auth.uid() is null or company_id = private.current_company_id())
    returning conversation_id into v_conversation;

  if v_conversation is not null and p_event is not null then
    insert into messages (conversation_id, role, channel, content, content_format)
    values (
      v_conversation,
      'event',
      'system',
      jsonb_build_object('parts', jsonb_build_array(
        jsonb_build_object('type', 'text', 'text', p_event)
      )),
      'ui-message@7'
    );
  end if;
end;
$$;
revoke execute on function finalize_proposal(uuid, text, text) from public, anon;
grant execute on function finalize_proposal(uuid, text, text) to authenticated, service_role;

-- ── onboarding ─────────────────────────────────────────────────────────────
-- Atomic company + profile creation for a logged-in user who has neither.
-- SECURITY DEFINER because the caller has no INSERT rights on either table —
-- this function IS the only door, and it hard-checks the JWT identity.
create function complete_onboarding(p_company_name text, p_full_name text, p_phone text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;
  -- serialize per user: two concurrent calls cannot orphan a company
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_user::text));
  if exists (select 1 from public.profiles where id = v_user) then
    raise exception 'profile already exists';
  end if;
  if p_company_name is null or length(trim(p_company_name)) = 0 then
    raise exception 'company name required';
  end if;

  insert into public.companies (name) values (trim(p_company_name))
    returning id into v_company;
  insert into public.profiles (id, company_id, full_name, phone)
    values (v_user, v_company, trim(p_full_name), p_phone);
  return v_company;
end;
$$;
revoke execute on function complete_onboarding(text, text, text) from public, anon;
grant execute on function complete_onboarding(text, text, text) to authenticated;
