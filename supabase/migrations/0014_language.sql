-- Multilingual support: two independent language dials, deliberately split.
--
--   profiles.language  — the HUMAN's language. Drives what Capo speaks, the
--                        deterministic approval cards, the transcription
--                        instruction, the rolling summary, and the whole web
--                        UI. Per user, because two managers on one company may
--                        not share a language, and the app is a personal
--                        surface.
--   companies.language — the TENANT's language. Drives STORED domain text
--                        (task titles, job names and descriptions, memories,
--                        generated plan titles) so the shared dashboard reads
--                        as exactly one language regardless of which manager
--                        dictated the row. A per-writer language here would
--                        fragment the dashboard with no way back: nothing
--                        retranslates existing rows.
--
-- Both default to 'pt-PT'. Every existing row is the Portuguese pilot, and a
-- NOT NULL column WITHOUT a default would break the two-tenant seeding in
-- scripts/rls-isolation-matrix.mjs and scripts/agent-smoke.mts, which insert
-- only the columns they know about.
--
-- text + check rather than a pg enum (house rule): adding a locale later is an
-- ALTER of one constraint, not an enum migration with its own transaction
-- rules.

-- ── language columns ───────────────────────────────────────────────────────
alter table profiles
  add column language text not null default 'pt-PT'
    check (language in ('pt-PT', 'es-ES', 'en-US'));

alter table companies
  add column language text not null default 'pt-PT'
    check (language in ('pt-PT', 'es-ES', 'en-US'));

-- ── column-level grants ────────────────────────────────────────────────────
-- Column grants are NOT additive: each grant REPLACES the allowed set, so every
-- previously-granted column must be re-listed or it silently loses write access.
--   profiles:  full_name, phone (0007) + language
--   companies: name (0011)            + language
-- company_id and the stripe/subscription columns stay ungranted — a tenant may
-- choose its own language, never its tenancy and never its billing state.
revoke update on table profiles from authenticated;
grant update (full_name, phone, language) on table profiles to authenticated;

revoke update on table companies from authenticated;
grant update (name, language) on table companies to authenticated;

-- ── onboarding ─────────────────────────────────────────────────────────────
-- REPLACE the function, do not add an overload. Two live candidates —
-- (text,text,text) and (text,text,text,text) — become ambiguous to PostgREST
-- the moment the wider one carries a DEFAULT: a three-argument request matches
-- both and fails with PGRST203 "Could not choose the best candidate function".
--
-- Dropping and recreating with p_language DEFAULT 'pt-PT' leaves exactly one
-- candidate, and the default is what makes the deploy window safe: the
-- currently-deployed three-argument caller in
-- apps/web/app/(public)/onboarding/actions.ts keeps working between this
-- migration being applied and the new app code shipping.
--
-- The additive-only convention governs DATA. A security-definer function is
-- code, and its signature is part of the application contract.
drop function if exists complete_onboarding(text, text, text);

create function complete_onboarding(
  p_company_name text,
  p_full_name text,
  p_phone text,
  p_language text default 'pt-PT'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_language text;
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

  -- Coerce rather than raise: a stale client sending a locale we have since
  -- retired should land on the default, not fail signup over a cosmetic
  -- preference. The check constraints above are still the real guard.
  v_language := case
    when p_language in ('pt-PT', 'es-ES', 'en-US') then p_language
    else 'pt-PT'
  end;

  -- Both dials start equal. They diverge only when someone changes one later.
  insert into public.companies (name, language) values (trim(p_company_name), v_language)
    returning id into v_company;
  insert into public.profiles (id, company_id, full_name, phone, language)
    values (v_user, v_company, trim(p_full_name), p_phone, v_language);
  return v_company;
end;
$$;
revoke execute on function complete_onboarding(text, text, text, text) from public, anon;
grant execute on function complete_onboarding(text, text, text, text) to authenticated;
