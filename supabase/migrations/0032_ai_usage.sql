-- 0032 — ai_usage: the token ledger the cost dashboard is built on (issue #53)
--
-- WHAT THIS ANSWERS
-- Until now nothing in this codebase recorded what a model call cost. Every
-- request to Anthropic and Google was made, billed, and forgotten: the only
-- cost-adjacent row the schema held was notification_log (0016), which counts
-- paid WhatsApp template sends and nothing else. "How much did Capo spend on
-- this company / this manager / this crew member last month" had no answer
-- anywhere, at any price.
--
-- This table is one row per API REQUEST to a language model — not per turn.
-- One inbound manager message can be up to twelve requests (core.ts's
-- stopWhen(12)) and a worker message up to six, so a busy day writes hundreds
-- of rows, not dozens. That granularity is deliberate: a per-turn aggregate
-- cannot tell "one expensive answer" from "twelve cheap tool hops", and the
-- second is the failure mode worth catching.
--
-- ── TOKENS ARE STORED. EUROS ARE NOT. ──────────────────────────────────────
-- There is no price column here and there must never be one. Provider rates
-- change, and a euro figure frozen into a row is a number that was true once
-- and is silently wrong forever after — with no way to tell which rows were
-- priced under which rate card. Cost is COMPUTED AT READ TIME from one named
-- table of constants (packages/core/src/agent/pricing.ts), so re-pricing the
-- whole history is a code edit and re-pricing a row is impossible.
--
-- ── THE FOUR TOKEN COLUMNS ARE DISJOINT ────────────────────────────────────
-- This is the single most important thing to get right when reading this
-- table. Anthropic bills four different rates and they do not overlap:
--
--   input_tokens        full price. Prompt tokens that were NOT served from,
--                       and not written to, the prompt cache.
--   cache_read_tokens   0.1x the input rate. Prompt tokens served from cache.
--   cache_write_tokens  1.25x the input rate. Prompt tokens written INTO cache.
--   output_tokens       the (much higher) output rate.
--
-- Total prompt tokens for a request = input + cache_read + cache_write.
-- NEVER add cache_read or cache_write on top of a separately-totalled input
-- figure: that double-counts every cached request, which since #58 is most of
-- the conversation traffic. The AI SDK hands us exactly these four buckets
-- (LanguageModelV4Usage.inputTokens.{noCache,cacheRead,cacheWrite}), and
-- packages/core/src/agent/usage.ts maps them one-to-one.
--
-- Splitting them out is also what makes the prompt-caching work of #58
-- measurable at all. Recording only "input" and "output" would have left the
-- feature permanently unfalsifiable.

create table ai_usage (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),

  -- ── attribution ─────────────────────────────────────────────────────────
  -- WHO the spend belongs to, in three mutually exclusive shapes. The rule the
  -- constraint below encodes:
  --
  --   'manager' — a named person asked for something. profile_id is required,
  --               worker_id must be null. This covers the manager's chat, the
  --               plan generator, the summarizer that runs after their turn,
  --               and voice-note transcription.
  --   'worker'  — a crew member's own restricted agent turn (0027). worker_id
  --               is required, profile_id must be null.
  --   'system'  — company-wide work nobody personally asked for in the moment,
  --               most importantly a bulk data translation. Both null.
  --
  -- A DELIBERATE LIMIT, stated here so nobody later reads more into this table
  -- than it holds: a MANAGER's chat turn is a manager cost even when the
  -- conversation is entirely about one crew member. Token spend is attributed
  -- to whoever's words were sent to the model, never to whoever the words were
  -- about — there is no honest way to split "tell me how Zé is doing" between
  -- the manager and Zé. Per-worker WhatsApp cost is a different question with a
  -- real answer, and it comes from notification_log's recipient, not from here.
  actor text not null check (actor in ('manager', 'worker', 'system')),
  profile_id uuid references profiles(id),
  worker_id uuid references workers(id),

  -- WHICH part of the product spent it. Deliberately coarser than the model
  -- role below: two surfaces can share a role (the manager chat and the worker
  -- chat both run on 'conversation'), and it is the surface, not the role, that
  -- answers "what is the money going on".
  --
  -- Note there is no 'briefing' value, and its absence is a fact rather than an
  -- omission: the 07:00 crew briefing and the late-afternoon check-in call no
  -- model at all. They are deterministic template sends, and their cost lives
  -- in notification_log.
  --
  -- ADDING A SURFACE IS TWO EDITS: this CHECK, and the UsageSurface union in
  -- packages/core/src/agent/usage.ts. Same shape as notifications.kind (0024).
  -- Get it wrong in one direction and the insert is rejected — which, because
  -- usage recording is deliberately swallowed (see below), shows up as a
  -- surface that silently records nothing rather than as an error.
  surface text not null check (surface in (
    'manager_chat',      -- packages/core/src/agent/core.ts
    'worker_chat',       -- packages/core/src/agent/worker-core.ts
    'summarizer',        -- agent/memory/summarizer.ts, after a manager's turn
    'planner',           -- capabilities/plan.ts, generate_plan
    'translation',       -- translation/translate.ts, a bulk company translation
    'transcription',     -- agent/transcription.ts, voice note -> text
    'vocab_extraction'   -- api/transcribe/feedback, learning corrected terms
  )),

  -- The named role from packages/core/src/agent/models.ts, and the concrete
  -- model id it resolved to at the time of the call. BOTH, on purpose: the role
  -- survives a model swap (so "what does the summarizer cost" stays answerable
  -- across generations) while the id is what the rate card is keyed on (so
  -- history stays priced correctly after a swap instead of being retroactively
  -- re-priced at the new model's rate).
  model_role text not null,
  model_id text not null,
  provider text not null check (provider in ('anthropic', 'google')),

  -- ── the four disjoint buckets (see the header) ──────────────────────────
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),

  -- The reporting clock, stamped by the DATABASE and not by the caller — the
  -- same lisbon_today() task_board reads and worker_messages.usage_date uses
  -- (0027). Two consequences, both wanted: a day in the cost report means the
  -- same day the board means, including across a DST change; and no caller can
  -- shift its spend into another day, because no caller sends a date at all
  -- (the column is absent from the tenant INSERT grant below).
  usage_date date not null default lisbon_today(),
  created_at timestamptz not null default now(),

  -- The attribution rule from the block above, in SQL. A CASE rather than three
  -- ORed conditions so that a future fourth actor value fails loudly at the
  -- CHECK instead of falling through into "anything goes".
  constraint ai_usage_actor_target check (
    case actor
      when 'manager' then profile_id is not null and worker_id is null
      when 'worker'  then worker_id is not null and profile_id is null
      when 'system'  then profile_id is null and worker_id is null
    end
  )
);

-- The two reads the operator dashboard actually makes: one company over a
-- window, and every company over a window.
create index ai_usage_company_date_idx on ai_usage (company_id, usage_date desc);
create index ai_usage_date_idx on ai_usage (usage_date desc);

-- ── cross-company FK guard ─────────────────────────────────────────────────
-- Uniform with 0009 / 0018 / 0023 / 0024 / 0027: RLS checks a row's OWN
-- company_id and never the company of the rows its foreign keys point at.
--
-- It matters here for the reason it mattered in 0027: most writers on this path
-- are the SERVICE ROLE (the WhatsApp webhook, the worker agent), which RLS does
-- not cover at all. For those rows this trigger is the only thing that stops a
-- mis-wired call site from filing one company's spend against another company's
-- manager or crew member.
create or replace function private.assert_ai_usage_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.profile_id is not null and not exists (
    select 1 from public.profiles p
    where p.id = new.profile_id and p.company_id = new.company_id
  ) then
    raise exception 'profile_id % is not in company %', new.profile_id, new.company_id
      using errcode = 'check_violation';
  end if;
  if new.worker_id is not null and not exists (
    select 1 from public.workers w
    where w.id = new.worker_id and w.company_id = new.company_id
  ) then
    raise exception 'worker_id % is not in company %', new.worker_id, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger ai_usage_fks_same_company
  before insert or update of company_id, profile_id, worker_id on ai_usage
  for each row execute function private.assert_ai_usage_same_company();

-- ── RLS: WRITE-ONLY for tenants, and no read surface at all ────────────────
--
-- This is not the notification_log posture (0016: RLS on, zero policies), and
-- the difference is forced by WHERE the write happens rather than chosen for
-- its own sake. notification_log is written by a cron on the service role, off
-- any tenant request. ai_usage is written DURING a tenant's own request, on
-- whatever client that request already holds — the RLS-scoped user client on
-- the web (AGENTS.md's system-vs-user client split forbids reaching for
-- getDb() there), and the service role on the WhatsApp and worker paths.
--
-- So: one INSERT policy, scoped to the caller's own company, and NOTHING else.
-- No SELECT policy means a tenant cannot read this table at all — not their own
-- rows, not anyone's. Cross-company cost belongs to the operator app, which
-- reads on the service role and bypasses RLS legitimately.
-- No UPDATE and no DELETE policy, matching every other table in this schema: a
-- recorded spend is a fact and facts are not edited.
--
-- KNOWN AND ACCEPTED, stated rather than hidden: an INSERT policy means a
-- tenant holding their own publishable key can fabricate ai_usage rows for
-- their OWN company. Three things bound that, and none of them is app code:
--   - company_id is pinned by the policy, so the forgery cannot reach another
--     tenant's numbers;
--   - usage_date is absent from the grant and comes from lisbon_today(), so
--     rows cannot be backdated into a closed period;
--   - there is no UPDATE and no DELETE, so a tenant can only ADD spend, never
--     erase it — i.e. the only available lie inflates their own bill.
-- If this table ever becomes an INPUT TO BILLING rather than an operator
-- instrument, that changes: move the write behind a SECURITY DEFINER function
-- that derives company_id from private.current_company_id(), and drop this
-- policy. Do not paper over it with an app-level check.
alter table ai_usage enable row level security;

create policy ai_usage_insert_company on ai_usage
  for insert to authenticated
  with check (company_id = (select private.current_company_id()));

-- Supabase default-grants ALL on new public tables, so revoke before granting.
-- Column grants REPLACE rather than add (see 0014, 0025, 0031) — this list is
-- the complete set a tenant may ever write. `usage_date`, `created_at` and `id`
-- are deliberately absent: all three are stamped by the database.
revoke all on table ai_usage from anon, authenticated;
grant insert (
  company_id, actor, profile_id, worker_id, surface,
  model_role, model_id, provider,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
) on table ai_usage to authenticated;

comment on table ai_usage is
  'One row per language-model API request: who it was for, which surface spent it, which model, and the four disjoint token buckets. Tokens only — never a currency amount. Cost is computed at read time from packages/core/src/agent/pricing.ts. Write-only for tenants (INSERT policy scoped to own company, no SELECT policy); read cross-tenant by apps/operator on the service role.';
comment on column ai_usage.input_tokens is
  'Full-price prompt tokens. EXCLUDES cache_read_tokens and cache_write_tokens — the three input columns are disjoint and sum to the request''s total prompt tokens.';
comment on column ai_usage.cache_read_tokens is
  'Prompt tokens served from the provider prompt cache (#58). Billed at 0.1x the input rate.';
comment on column ai_usage.cache_write_tokens is
  'Prompt tokens written into the provider prompt cache (#58). Billed at 1.25x the input rate.';
comment on column ai_usage.actor is
  'manager (profile_id set) | worker (worker_id set) | system (neither). A manager''s turn is a manager cost even when it is about a worker; per-worker WhatsApp cost comes from notification_log, not from here.';
