-- The schedule becomes DATA, and a run becomes something you can look at
-- (issue #51, part B).
--
-- ── WHY THIS MIGRATION EXISTS ──────────────────────────────────────────────
-- On 13 August 2026 the 07:00 briefing went out at 07:49. Federico watched an
-- empty WhatsApp for forty-nine minutes and recorded the morning as a failure.
-- It was not a failure; it was late, and NOTHING IN THE PRODUCT COULD SAY SO.
-- Answering "when did it actually run, who got it, and who did not" took a
-- Vercel log drain and a database session.
--
-- Part A widened the hour gate to a two-hour window so a late dispatch still
-- sends. This is part B: making the schedule editable, and making a run
-- legible from inside the app.
--
-- Three things land here, and they are deliberately three separate objects
-- rather than columns bolted onto notification_log:
--
--   company_schedules   what time each company's two daily sends are aimed at
--   cron_runs           one row per company per job per day: due vs actual,
--                       and every count that explains an absence
--   company_send_history()  a SECURITY DEFINER reader over notification_log,
--                       which stays deny-all for tenants
--
-- ── WHY NOT JUST ADD COLUMNS TO notification_log ───────────────────────────
-- Because claimNotification's INSERT is the idempotency lock the whole cron
-- rests on, and it names its columns. A new NOT-NULL-ish column in that insert
-- makes a deploy landing BEFORE this migration fail every claim with 42703 —
-- which is not "the history is missing", it is "nobody in the estate gets a
-- message this morning". A separate table written by a swallowing helper costs
-- a missing history row in that window and nothing else.
--
-- The delivery-status columns below are the one exception, and they are safe
-- for exactly the opposite reason: nothing INSERTS them. They are written only
-- by an UPDATE from the webhook, which is already wrapped in a catch.

-- ── company_schedules ──────────────────────────────────────────────────────
-- vercel.json is a static file baked into the deployment. A tenant cannot edit
-- a Vercel cron entry, so "the manager can change the time of the morning
-- message" is impossible as long as the time lives there. It moves here, and
-- vercel.json is reduced to an hourly heartbeat that asks "is anything due for
-- anyone now?".
--
-- ── ABSENCE IS THE DEFAULT, AND THAT IS THE WHOLE DEPLOY STORY ─────────────
-- There is deliberately NO backfill. A company with no row uses the built-in
-- default hour (7 for the briefing, 16 for the check-in), which is what every
-- company uses today. So:
--   * a deploy landing before this migration reads no table, degrades to the
--     defaults, and behaves byte-identically to the current product;
--   * a deploy landing after it, with nobody having touched the screen,
--     behaves byte-identically too.
-- A backfill would have made the table's existence load-bearing on day one.
create table company_schedules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  -- The two predefined sends. A CHECK rather than a free-text column because
  -- the routes that read this are named after these exact strings, and a typo
  -- in the app would otherwise silently mean "this company has no schedule"
  -- (i.e. back to the default) rather than raising.
  job_kind text not null check (job_kind in ('daily_briefing', 'task_checkin')),
  -- Europe/Lisbon, the hour the send is AIMED at. The window opens here and
  -- runs SEND_WINDOW_HOURS wide (apps/web/lib/cron.ts).
  --
  -- The range is not decoration. The lower bound is quiet hours: nobody's
  -- phone should buzz at 04:00 because a manager mistyped. The upper bound is
  -- structural — sendWindowEnd() CLAMPS at 23 and must never wrap past
  -- midnight, because notification_date comes from lisbon_today() and a run on
  -- the far side of midnight looks like a fresh unclaimed day to the
  -- idempotency lock, i.e. it messages everybody a second time. At 21 the
  -- window is 21–22 and cannot reach 23:59. The same two numbers live in
  -- apps/web/lib/schedule.ts and `pnpm scheduler-check` asserts the no-wrap
  -- property from them.
  send_hour smallint not null check (send_hour between 5 and 21),
  -- Switching a send OFF is the only lever in this feature that can only ever
  -- REDUCE spend, which is why it ships while "add another send" does not.
  -- Every recipient of every send is a paid Meta template.
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- WHO moved the crew's morning. Stamped by the trigger below rather than
  -- written by the client, and absent from the tenant's grant, so it cannot be
  -- forged — same posture as task_photos.uploaded_by (0023).
  updated_by uuid references profiles(id),
  -- One schedule per company per job. This is also what makes the app's write
  -- a plain upsert rather than a read-modify-write with a race in it.
  unique (company_id, job_kind)
);

create index company_schedules_company_idx on company_schedules (company_id);

-- Attribution and freshness, stamped rather than trusted. `updated_by` falls
-- back to its previous value for a service-role write (auth.uid() is null
-- there), so a system edit never erases who last chose the time.
create or replace function private.stamp_company_schedule()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), old.updated_by, new.updated_by);
  return new;
end;
$$;

create trigger company_schedules_stamp
  before update on company_schedules
  for each row execute function private.stamp_company_schedule();

-- On INSERT there is no `old`, so a separate function keeps the coalesce
-- honest instead of referencing a record that does not exist.
create or replace function private.stamp_company_schedule_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

create trigger company_schedules_stamp_insert
  before insert on company_schedules
  for each row execute function private.stamp_company_schedule_insert();

alter table company_schedules enable row level security;

-- SELECT / INSERT / UPDATE for the owning company, no DELETE — the schema's
-- standing posture (push_subscriptions is still the only DELETE policy). A
-- manager who no longer wants the afternoon check-in switches `enabled` off;
-- deleting the row would mean "back to the default", which is the opposite of
-- what they asked for and would be indistinguishable from never having chosen.
create policy company_schedules_select_company on company_schedules
  for select to authenticated
  using (company_id = (select private.current_company_id()));
create policy company_schedules_insert_company on company_schedules
  for insert to authenticated
  with check (company_id = (select private.current_company_id()));
create policy company_schedules_update_company on company_schedules
  for update to authenticated
  using (company_id = (select private.current_company_id()))
  with check (company_id = (select private.current_company_id()));

-- Supabase default-grants ALL on new public tables, so revoke first, then
-- re-grant a COLUMN LIST. `updated_by` and `updated_at` are absent on purpose:
-- the triggers own them, and a tenant naming either is refused by the grant
-- rather than silently overwritten by the trigger. Same reasoning as 0025/0028
-- on workers, and the same property — attribution that cannot be forged even
-- inside your own company.
--
-- ⚠ WHY THE UPDATE GRANT ALSO CARRIES company_id AND job_kind, which look like
-- identity columns nobody should be able to move. Because the app writes this
-- table with an UPSERT — it has to, since 0036 backfills nothing, so the FIRST
-- save for any company is an insert and every later one is an update — and
-- PostgREST compiles an upsert to
--     insert … on conflict (company_id, job_kind) do update
--       set company_id = excluded.company_id, job_kind = excluded.job_kind, …
-- i.e. it assigns EVERY column in the payload, including the conflict target.
-- With a narrower grant the insert succeeds and every subsequent save fails
-- with "permission denied", which is a Save button that works exactly once per
-- company and then silently stops.
--
-- Nothing is actually loosened by that. `company_id` is bounded by the RLS
-- policies above on BOTH sides — `using` refuses another company's row and
-- `with check` refuses moving one into another company — and `job_kind` is
-- bounded by its CHECK constraint plus the unique index, so the worst a tenant
-- can do with it is rename their own schedule row and fall back to the default
-- for the other job, which the screen shows and one save undoes.
revoke all on table company_schedules from anon, authenticated;
grant select on table company_schedules to authenticated;
grant insert (company_id, job_kind, send_hour, enabled) on table company_schedules to authenticated;
grant update (company_id, job_kind, send_hour, enabled) on table company_schedules to authenticated;

-- ── cron_runs ──────────────────────────────────────────────────────────────
-- One row per company per job per day: what time it was DUE, what time it
-- actually ran, and every count that explains why somebody heard nothing.
--
-- ── WHY A SEPARATE TABLE AND NOT A VIEW OVER notification_log ──────────────
-- Because the interesting people are the ones with NO ROW in notification_log.
-- A worker with no recorded WhatsApp opt-in, a crew row switched off, a
-- company with no manager account at all — none of them are ever claimed, so
-- none of them appear in the send ledger. That is exactly the population issue
-- #51 spent half a day chasing, and no query over notification_log can
-- reconstruct it.
--
-- ── WHO WRITES IT, AND WHEN ────────────────────────────────────────────────
-- The route that WON the claims, and only that one. Since the window widened
-- (part A) two or three invocations pass the hour gate every morning;
-- notification_log's unique constraint makes the SENDS idempotent, and
-- counting claims is what makes this row ride the same lock. The one exception
-- is a company that had nobody claimable at all — no crew with consent, no
-- manager — which writes a zero row if none exists yet, because "nothing went
-- out today" is precisely the fact that used to be invisible.
create table cron_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  job_kind text not null check (job_kind in ('daily_briefing', 'task_checkin')),
  -- lisbon_today() on the run, i.e. the same date notification_log claims
  -- against. One clock (AGENTS.md).
  run_date date not null,
  -- THE COLUMN THIS WHOLE FEATURE EXISTS FOR: what the schedule said (Lisbon
  -- hour), against what the clock said when the platform actually knocked.
  -- 07:00 vs 07:49, in the product, without a hosting-company log.
  due_hour smallint not null,
  ran_hour smallint not null,
  ran_at timestamptz not null default now(),
  finished_at timestamptz,
  -- The three outcomes notification_log also records, denormalised so a run
  -- summary is one row rather than an aggregate over a table tenants cannot
  -- read.
  messaged integer not null default 0,
  skipped_idle integer not null default 0,
  failed integer not null default 0,
  -- The four ways to hear nothing WITHOUT a notification_log row.
  excluded_no_consent integer not null default 0,
  excluded_unreachable integer not null default 0,
  excluded_inactive integer not null default 0,
  managers_no_consent integer not null default 0,
  -- "Construções Ostan Lda. has two crew members and NO manager account, so
  -- the manager loop iterates an empty list and logs nothing at all" — issue
  -- #51, secondary finding 2. It was not merely unlogged; there was no shape
  -- for it. Only the briefing sets this; the check-in has no manager audience.
  no_manager_account boolean not null default false,
  -- One row per company per job per day. An upsert target, and the reason a
  -- second in-window invocation cannot append a duplicate summary.
  unique (company_id, job_kind, run_date)
);

create index cron_runs_company_date_idx on cron_runs (company_id, run_date desc);

alter table cron_runs enable row level security;

-- SELECT only. Written exclusively by the cron on the service role, which
-- bypasses policies — so there is deliberately no INSERT or UPDATE policy at
-- all, and a tenant cannot manufacture a morning that never happened.
create policy cron_runs_select_company on cron_runs
  for select to authenticated
  using (company_id = (select private.current_company_id()));

revoke all on table cron_runs from anon, authenticated;
grant select on table cron_runs to authenticated;

-- ── delivery truth ─────────────────────────────────────────────────────────
-- Until now `notification_log.status = 'sent'` meant "Meta accepted it", never
-- "it arrived". Meta announces the rest on a webhook whose payload is a THIRD
-- shape — `value.statuses`, alongside `value.messages` — and the webhook acked
-- and discarded it (issue #51, secondary finding 4).
--
-- Additive, nullable, and — crucially — NOT in claimNotification's INSERT.
-- They are written only by an UPDATE from the webhook, inside a catch, so a
-- deploy landing before this migration loses status updates and sends nothing
-- differently. That asymmetry is why these columns may live on the ledger
-- while cron_runs may not.
alter table notification_log
  add column delivered_at timestamptz,
  add column read_at timestamptz,
  add column failed_at timestamptz,
  -- Meta's numeric failure code, as it arrives on the status callback. Kept
  -- next to the existing free-text `error` rather than replacing it: `error`
  -- is our own send-time message and this is Meta's later verdict, and a
  -- message can succeed at send time and fail on delivery.
  add column delivery_error_code integer,
  add column delivery_error text;

-- The webhook looks a row up BY provider_message_id, which had no index — a
-- sequential scan of the whole estate's send ledger on every status callback,
-- and there are three or four of those per message.
create index notification_log_provider_message_idx
  on notification_log (provider_message_id)
  where provider_message_id is not null;

-- ── company_send_history ───────────────────────────────────────────────────
-- The ONE window into notification_log a tenant gets, and the table's deny-all
-- posture is otherwise untouched: RLS is still on, there are still no policies,
-- and `select * from notification_log` still returns nothing to anybody.
--
-- ⚠ SECURITY DEFINER means RLS does NOT apply inside this function. The
-- auth.uid() / company check below is therefore the ENTIRE tenant boundary,
-- exactly like open_task_review (0018) and set_task_collaborators (0035), and
-- scripts/rls-isolation-matrix.mjs attacks it directly for that reason.
--
-- ⚠⚠ THE NULL GUARD IS CHECKED FIRST AND RAISES, and that ordering is not
-- style. The shape `if auth.uid() is not null and v_company is distinct from
-- private.current_company_id()` FAILS OPEN when the company resolves to NULL:
-- `x <> NULL` is NULL, `true and NULL` is NULL, and `if NULL` does not fire.
-- That exact hole was confirmed exploitable against THIS production database
-- and closed in 0021. An authenticated user with no profiles row — Capo's real
-- signup-before-onboarding state — is not a hypothetical attacker, they are a
-- state the product creates on purpose. So: no company, no rows, raise.
--
-- Unlike the two RPCs above, this one does NOT let the service role through.
-- There is no system caller: the cron writes notification_log directly with a
-- service-role client and never needs to read it back through here.
create function company_send_history(p_from date, p_to date)
returns table (
  id uuid,
  kind text,
  audience text,
  worker_id uuid,
  profile_id uuid,
  notification_date date,
  status text,
  task_count integer,
  provider_message_id text,
  error text,
  created_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  delivery_error_code integer,
  delivery_error text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  v_company := private.current_company_id();
  if v_company is null then
    raise exception 'no company for %', auth.uid() using errcode = 'insufficient_privilege';
  end if;

  -- A range, capped, rather than "everything". The screen shows a fortnight;
  -- an unbounded read over a growing ledger is a slow page today and a timeout
  -- in a year. The cap is enforced here rather than trusted from the caller
  -- because the caller is a browser.
  if p_from is null or p_to is null or p_to < p_from or (p_to - p_from) > 92 then
    raise exception 'invalid date range' using errcode = 'check_violation';
  end if;

  -- Every source reference is qualified with `nl.`. Unqualified, each of them
  -- would resolve to the same-named OUT parameter above instead of to the
  -- column, which plpgsql reports as an ambiguity error at runtime — i.e. on
  -- the live screen and never in CI.
  return query
    select
      nl.id,
      nl.kind,
      nl.audience,
      nl.worker_id,
      nl.profile_id,
      nl.notification_date,
      nl.status,
      -- The COUNT, never the ids. A task id is useless on this screen and
      -- widening a read surface by a column nobody renders is how a debug view
      -- becomes an export.
      coalesce(jsonb_array_length(nl.task_ids), 0),
      nl.provider_message_id,
      nl.error,
      nl.created_at,
      nl.delivered_at,
      nl.read_at,
      nl.failed_at,
      nl.delivery_error_code,
      nl.delivery_error
    from notification_log nl
    where nl.company_id = v_company
      and nl.notification_date between p_from and p_to
    order by nl.notification_date desc, nl.created_at asc;
end;
$$;

revoke execute on function company_send_history(date, date) from public, anon;
grant execute on function company_send_history(date, date) to authenticated;
