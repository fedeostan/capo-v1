-- 0037 — memory gets an owner, a ceiling, and a night shift (issue #48)
--
-- WHAT THIS ANSWERS
-- `memories` (0001) has been the product's only durable, cross-conversation
-- store since the first migration, and it has two structural gaps that #48
-- names directly:
--
--   1. EVERY memory belongs to the COMPANY. There is no per-person memory at
--      all — no profile_id, and the RLS policies 0007 generated for this table
--      are the plain company-scoped triple. "Talk to me in short sentences" is
--      therefore stored where a second manager of the same company would read
--      it as if he had said it.
--   2. NOTHING EVER REVIEWS THE DAY. `remember` is called mid-conversation, in
--      the moment, when the model happens to notice. There is no pass that
--      re-reads what happened and asks what is worth keeping.
--
-- This migration is the schema half of both. It is ADDITIVE in the strict
-- sense: every row that exists when it lands keeps meaning exactly what it
-- meant before, because NULL profile_id is defined as "the whole company", and
-- that is what every existing row is.
--
-- ── WHY NULL MEANS COMPANY-WIDE, AND NOT THE OTHER WAY ROUND ───────────────
-- Same reasoning as workers.language (0014): the null is the INHERIT case, so
-- a backfill is unnecessary and a deploy landing before this migration behaves
-- byte-identically to the deploy after it. Giving the column a default, or
-- defining NULL as "personal", would have made a backfill mandatory and made
-- the migration's arrival load-bearing on day one.
--
-- ── THE DISTINCTION THIS COLUMN IS NOT ─────────────────────────────────────
-- `subject_type`/`subject_id` (0001) say what a memory is ABOUT — a job, a
-- worker. `profile_id` says who it BELONGS TO. "Zé is slow on tiling" is about
-- a worker and belongs to the company; "address me by my first name" is about
-- nobody and belongs to one profile. Do not collapse them: a memory about a
-- worker that belonged to one manager would be invisible to the colleague who
-- most needs it.

-- ── memories.profile_id ────────────────────────────────────────────────────
alter table memories
  add column profile_id uuid references profiles(id) on delete cascade;

comment on column memories.profile_id is
  'Who this memory BELONGS TO. NULL = the whole company (every existing row, and every row `remember` wrote before 0037). Set = one manager, and only they ever see it. Distinct from subject_type/subject_id, which say what it is ABOUT.';

-- The prompt read: this company''s active memories, newest first, capped.
-- Partial on `active` because an inactive memory is never read by anything on
-- the request path — the /perfil screen reads it, once, on demand.
create index memories_prompt_idx on memories (company_id, created_at desc)
  where active;

-- ── a ceiling on ONE memory ────────────────────────────────────────────────
-- Every active memory is injected WHOLESALE into the system prompt on every
-- turn, so an unbounded `content` is an unbounded per-message cost forever
-- after. The read-time cap in packages/core/src/agent/memory/prompt-memories.ts
-- is the bound that actually matters (40 rows / 6000 chars); this one stops a
-- single row from eating the whole budget on its own.
--
-- NOT VALID on purpose. `remember` has had no length limit since 0001, so rows
-- longer than this may already exist in production; a validating constraint
-- would fail the migration on data we cannot see from here. NOT VALID enforces
-- it on every INSERT and UPDATE from now on and leaves history alone — which is
-- the correct trade, because history is already bounded by the read-time cap.
alter table memories
  add constraint memories_content_length check (char_length(content) <= 240)
  not valid;

-- ── cross-company FK guard ─────────────────────────────────────────────────
-- Uniform with 0009 / 0018 / 0023 / 0024 / 0027 / 0032: RLS checks a row's OWN
-- company_id and never the company of the rows its foreign keys point at.
--
-- It matters here for the same reason it mattered in 0024, and severely. A
-- memory whose company_id is tenant A's but whose profile_id belongs to tenant
-- B satisfies NEITHER select policy below — A's manager fails the profile test,
-- B's manager fails the company test — so it would be a row naming another
-- tenant's user that no tenant can see and therefore nobody can find. The
-- tenant's own UPDATE grant reaches profile_id nowhere (see the grants below),
-- but the service role writes on this path too and RLS does not cover it.
create or replace function private.assert_memory_fks_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.profile_id is not null and not exists (
    select 1 from public.profiles p
    where p.id = new.profile_id and p.company_id = new.company_id
  ) then
    raise exception 'profile_id % is not in company %', new.profile_id, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger memories_fks_same_company
  before insert or update of company_id, profile_id on memories
  for each row execute function private.assert_memory_fks_same_company();

-- ── RLS: company scope AND profile scope ───────────────────────────────────
-- 0007 generated the plain company-scoped triple for this table in a loop, and
-- it was correct for as long as every memory belonged to the company. The
-- moment one can belong to a person, "same company" is not enough: a colleague
-- IS in your company. Same two-predicate shape as notifications (0024), and for
-- the same reason — this is the second per-profile relation in the schema.
--
-- Replaced rather than added to: two permissive policies on one command are
-- ORed, so leaving 0007's company-only SELECT in place beside a narrower one
-- would leave the wider rule in force and the new one decorative.
drop policy memories_select_company on memories;
drop policy memories_insert_company on memories;
drop policy memories_update_company on memories;

-- The read every turn makes. `profile_id is null` is the company half and must
-- stay first in the OR: it is what keeps every pre-0037 row readable.
create policy memories_select_scoped on memories
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (profile_id is null or profile_id = (select auth.uid()))
  );

-- A manager may write a company memory or one of their own, and nothing else.
-- Without the second predicate a manager could file a memory AGAINST a
-- colleague — attacker-chosen text appearing in someone else's agent context
-- under the app's own chrome, which is the same threat 0024 refuses by having
-- no INSERT policy at all. Here an INSERT policy is unavoidable (`remember`
-- runs on the tenant's own client on the web), so the predicate does the work.
create policy memories_insert_scoped on memories
  for insert to authenticated
  with check (
    company_id = (select private.current_company_id())
    and (profile_id is null or profile_id = (select auth.uid()))
  );

-- UPDATE is what "forget this" and the bulk translation both run. WITH CHECK
-- repeats the predicate so a row cannot be handed to a colleague on its way
-- out — the column grant below already forbids naming profile_id, and this is
-- the second lock on the same door.
create policy memories_update_scoped on memories
  for update to authenticated
  using (
    company_id = (select private.current_company_id())
    and (profile_id is null or profile_id = (select auth.uid()))
  )
  with check (
    company_id = (select private.current_company_id())
    and (profile_id is null or profile_id = (select auth.uid()))
  );

-- No DELETE policy, deliberately and unchanged. "Forget this" sets active =
-- false, exactly as the translation undo marks rather than removes (0015) and
-- as a resolved review and a read notification do. From the manager's side the
-- memory is gone — nothing on the request path reads an inactive row — while
-- "why did Capo say that in March" stays answerable.

-- ── column grants ──────────────────────────────────────────────────────────
-- `memories` has carried Supabase's default `grant all` since 0001: nothing has
-- ever revoked it, so a tenant could UPDATE any column of their own memories,
-- including (from today) profile_id. Column grants REPLACE rather than add
-- (0014, 0025, 0031), so these two lists are the complete set a tenant may ever
-- write.
--
-- The three real writers on the tenant's own client, and nothing else:
--   remember (capabilities/memory.ts)   INSERT
--   runTranslationBatch (translation/)  UPDATE (content, updated_at)
--   forgetMemory (/perfil/memoria)      UPDATE (active, updated_at)
--
-- `active` is absent from the INSERT list on purpose: a memory is born active,
-- and a caller that could choose would be able to file one already forgotten.
revoke all on table memories from anon, authenticated;
grant select on table memories to authenticated;
grant insert (company_id, profile_id, kind, content, subject_type, subject_id)
  on table memories to authenticated;
grant update (content, active, updated_at) on table memories to authenticated;

-- ── memory_consolidations ──────────────────────────────────────────────────
-- The nightly review's ledger, and — the part that matters — its WATERMARK.
--
-- ── WHY ITS OWN TABLE AND NOT cron_runs (0036) ─────────────────────────────
-- Three reasons, any one of which is sufficient:
--   * cron_runs.job_kind is CHECKed to the two SENDS, and /perfil/automacoes
--     renders it through a Record<'daily_briefing' | 'task_checkin', …> in
--     @capo/i18n — so a third kind is a tsc error there, and papering over it
--     would put a job that messages nobody on a screen about messages sent to
--     people, each of which costs money per recipient.
--   * cron_runs has nowhere to put a watermark, and the watermark is the whole
--     safety property (below).
--   * cron_runs is written by the route that WON a notification_log claim.
--     There is no send here, so there is no claim; this table IS the claim.
--
-- ── THE UNIQUE KEY IS THE IDEMPOTENCY LOCK ─────────────────────────────────
-- The hour gate on the nightly route is four Lisbon hours wide, so four hourly
-- heartbeats pass it every night. `unique (company_id, run_date)` is what makes
-- that safe: the second tick's INSERT trips 23505 and the run is a no-op by
-- construction, exactly as notification_log's key makes a widened send window
-- safe. Do NOT protect this with app-level state instead.
--
-- ── THE WATERMARK IS WHAT TURNS SILENCE INTO LATENESS ──────────────────────
-- `covers_until_at` is stamped only on a run that SUCCEEDED, and the next run
-- starts from the newest such stamp — not from "yesterday". So a night that is
-- skipped, that fails, or that lands outside the window is simply covered by
-- the following night, over a wider span. That is the property that makes an
-- hour gate acceptable here at all: on 13 August 2026 an hour gate on a send
-- route was eleven minutes from total, silent failure, and the reason it was
-- dangerous is that a missed morning is a morning gone forever. A missed
-- consolidation is not.
--
-- A row is therefore claimed BEFORE the model call, with covers_until_at NULL,
-- and stamped after. Dying in between costs one night's claim and advances
-- nothing — the failure mode that loses work is the reverse order.
create table memory_consolidations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  -- lisbon_today() on the run. One clock (AGENTS.md).
  run_date date not null,
  -- 'pending' is the claim; the other three are outcomes. 'empty' is not a
  -- failure and is the common case — most nights hold nothing durable — and it
  -- is distinguished from 'done' so "the night agent writes nothing, ever" is a
  -- greppable fact rather than an inference from a quiet memories table.
  status text not null default 'pending'
    check (status in ('pending', 'done', 'failed', 'empty')),
  -- created_at of the last message this run consolidated. NULL until the run
  -- succeeds. The next run reads MAX over the succeeded rows.
  covers_until_at timestamptz,
  messages_read integer not null default 0 check (messages_read >= 0),
  memories_written integer not null default 0 check (memories_written >= 0),
  -- Why a run failed, for the operator. Never shown to a manager.
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (company_id, run_date)
);

create index memory_consolidations_watermark_idx
  on memory_consolidations (company_id, covers_until_at desc)
  where covers_until_at is not null;

-- SELECT and nothing else, the cron_runs posture. The Memory screen says when
-- Capo last reviewed the conversation, which is the difference between "Capo
-- has learned nothing about us" and "the night shift is not running". Every
-- write is the service role's; a run row a tenant could write is not evidence
-- of anything.
alter table memory_consolidations enable row level security;

create policy memory_consolidations_select_company on memory_consolidations
  for select to authenticated
  using (company_id = (select private.current_company_id()));

revoke all on table memory_consolidations from anon, authenticated;
grant select on table memory_consolidations to authenticated;

comment on table memory_consolidations is
  'One row per company per night: the nightly memory review''s claim (unique on company_id, run_date), its outcome, and covers_until_at — the watermark that makes a missed night cost lateness instead of loss.';

-- ── ai_usage gains a surface ───────────────────────────────────────────────
-- The nightly review calls a model, so it must be counted (#53). Adding a
-- surface is TWO edits — this CHECK and the UsageSurface union in
-- packages/core/src/agent/usage.ts — and the failure mode of doing only one is
-- SILENCE: recordUsage swallows its errors, so a rejected insert presents as a
-- surface that quietly records nothing. `pnpm cost-check` reads the newest
-- migration that redefines this constraint and asserts it against the union.
alter table ai_usage drop constraint ai_usage_surface_check;
alter table ai_usage add constraint ai_usage_surface_check check (surface in (
  'manager_chat',      -- packages/core/src/agent/core.ts
  'worker_chat',       -- packages/core/src/agent/worker-core.ts
  'summarizer',        -- agent/memory/summarizer.ts, after a manager's turn
  'consolidation',     -- agent/memory/consolidate.ts, the nightly review
  'planner',           -- capabilities/plan.ts, generate_plan
  'translation',       -- translation/translate.ts, a bulk company translation
  'transcription',     -- agent/transcription.ts, voice note -> text
  'vocab_extraction'   -- api/transcribe/feedback, learning corrected terms
));
