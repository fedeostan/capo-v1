-- "Is it there?" — the daily materials walk-around (issue #154).
--
-- ── WHY THIS TABLE EXISTS ──────────────────────────────────────────────────
-- The materials screen had two horizons and both answer the same question:
-- what to BUY tonight (tomorrow) and what to ORDER tonight (the week). Neither
-- answers the question the manager actually has at 06:40, which is not "what
-- do I buy" but "is it on site". Facu called that omission critical and he is
-- right: the crew's 07:00 message tells each person what their own task needs,
-- and the one person who has to make sure it is there gets no list at all.
--
-- ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
-- This is a CHECK LIST, never an inventory. There are no quantities, no units,
-- no deliveries and no consumption, because none of those exist anywhere in
-- this product: a material is a line of text on `tasks.materials` and nothing
-- has ever recorded that four bags of cement arrived on Tuesday. A screen
-- claiming to show "what there is" would be inventing it — the same finding
-- the activity feed records about its deliberately absent delivery event.
--
-- Real stock tracking (option B in the issue) is a different product that
-- needs somebody to keep it accurate every day, and the moment it is wrong
-- once nobody trusts it again. Nothing here is groundwork for it, and this
-- table must not be grown into it: adding a quantity column is not an
-- extension of this feature, it is the start of a different one.

create table material_checks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),

  -- ── KEYED ON THE OBRA, NOT ON THE TASK ───────────────────────────────────
  -- Materials hang off a TASK in the schema (`tasks.materials`), and every
  -- WRITE of a material still names its task row — that invariant is
  -- untouched. But a manager walks a SITE. Standing in the Casa de Paco they
  -- ask "is the cement here?", never "is the cement for the tiling task
  -- here?", and the screen already answers at that grain: it groups by obra
  -- and renders ONE row per distinct material string, however many tasks of
  -- that obra happen to need it. A tick keyed on the task would therefore be
  -- a tick the screen cannot show — one row, three underlying tasks, three
  -- possible states and no honest way to draw them.
  --
  -- NULLABLE, and the null is a real case rather than a defect. `tasks.job_id`
  -- is nullable, so a task can belong to no obra; the screen collects those
  -- into a single "Sem obra" group and this table keys them the same way. The
  -- unique index below is therefore NULLS NOT DISTINCT (0016/0033 use the same
  -- device on notification_log) so that group gets exactly one tick per
  -- material per day like every other group, instead of a fresh row on every
  -- tap.
  job_id uuid references jobs(id),

  -- ── KEYED ON THE EXACT STORED STRING ─────────────────────────────────────
  -- The screen's own map is keyed on the material string verbatim, so keying
  -- the tick any other way would let the two drift — a tick rendered against a
  -- row it does not belong to is worse than no tick, because it is an answer
  -- and it is wrong. 120 characters is `MAX_MATERIAL_LENGTH` in
  -- apps/web/app/(app)/_tasks/materials-actions.ts, restated here so a value
  -- this table cannot hold cannot be written.
  --
  -- Known consequence, stated rather than hidden: ('tasks','materials') is a
  -- TRANSLATABLE column (0015/0021), so a bulk translate_company_data rewrites
  -- these strings and today's ticks stop matching — the affected rows simply
  -- render unticked again. The cost is bounded to the rest of one day by the
  -- date in the key, which is why it is acceptable rather than a reason to
  -- invent a material id the product does not have.
  material text not null check (char_length(material) between 1 and 120),

  -- ── THE DAY IS PART OF THE KEY, AND IT COMES FROM THE ONE CLOCK ──────────
  -- A walk-around is a daily act. A tick that never reset would be silently
  -- wrong from the second morning onward — the worst kind of wrong, because it
  -- reads as a confident "yes" about a site nobody has looked at since
  -- Tuesday.
  --
  -- The reset is BY CONSTRUCTION and there is deliberately no sweep job:
  -- yesterday's rows are not today's rows, because the reader only ever asks
  -- for `check_date = lisbon_today()`. Nothing in this repo sweeps anything,
  -- and a sweep that fails leaves stale state behind and says nothing.
  --
  -- DEFAULT, not a client value, and `check_date` is absent from the INSERT
  -- grant below. A client that could send a date is a client that can tick
  -- tomorrow. lisbon_today() is the same SQL clock task_board reads, so this
  -- column cannot disagree with the list it is ticking (AGENTS.md, one clock).
  check_date date not null default lisbon_today(),

  -- ── THREE STATES, BECAUSE "UNTICK" IS A STATE ────────────────────────────
  -- 'on_site' and 'missing' are the two answers; 'unknown' is what a manager
  -- who taps an active chip again gets — they have withdrawn an answer they
  -- gave in error. It is NOT the same as having no row at all (never asked),
  -- and it exists so that undoing a tick is an UPDATE rather than a DELETE.
  -- Uniform with the rest of this schema: "forget this memory" and the
  -- translation undo both mark rather than delete, and there is no DELETE
  -- policy here either (push_subscriptions is still the only one).
  status text not null check (status in ('on_site', 'missing', 'unknown')),

  -- WHO ticked, stamped by the triggers below from auth.uid() and absent from
  -- every grant, so attribution is unforgeable at the GRANT layer rather than
  -- in app code — the posture company_schedules.updated_by (0036) and
  -- task_photos.uploaded_by (0023) set.
  checked_by uuid references profiles(id),
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- One tick per material per obra per Lisbon day. NULLS NOT DISTINCT so the
-- "no obra" group collapses to one row per material like every other group;
-- without it every tap on those rows would insert a new row and the last
-- writer would be invisible.
create unique index material_checks_key_idx
  on material_checks (company_id, job_id, material, check_date)
  nulls not distinct;

-- The screen's read: this company's ticks for today. The unique index above
-- leads with company_id but buries check_date behind two columns the read does
-- not filter on, so it cannot serve this.
create index material_checks_company_date_idx
  on material_checks (company_id, check_date);

-- ── attribution, stamped rather than trusted ───────────────────────────────
-- Two functions rather than one, exactly as 0036 does, because `old` does not
-- exist on an INSERT and a coalesce that references it would fail at runtime
-- on the first tick rather than in CI.
create or replace function private.stamp_material_check_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.checked_at := now();
  new.checked_by := coalesce(auth.uid(), new.checked_by);
  return new;
end;
$$;

create trigger material_checks_stamp_insert
  before insert on material_checks
  for each row execute function private.stamp_material_check_insert();

-- On UPDATE the previous value is kept when there is no authenticated caller,
-- so a service-role fix-up never erases who actually walked the site.
create or replace function private.stamp_material_check_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.checked_at := now();
  new.checked_by := coalesce(auth.uid(), old.checked_by, new.checked_by);
  return new;
end;
$$;

create trigger material_checks_stamp_update
  before update on material_checks
  for each row execute function private.stamp_material_check_update();

-- ── cross-company FK guard ─────────────────────────────────────────────────
-- Uniform with 0009 / 0024 / 0037: RLS checks a row's OWN company_id and never
-- the company of the rows its foreign keys point at. A tick whose company_id
-- is tenant A's but whose job_id is tenant B's obra would be a row naming
-- another tenant's site, visible to A and meaningless there.
--
-- `checked_by` is deliberately NOT guarded here, and the reason is trigger
-- ordering rather than indifference: BEFORE triggers fire in name order, so
-- this one ('f') runs before the stamp ('s') and would only ever inspect the
-- NULL the grant forces. The column is written exclusively from auth.uid(),
-- whose profile is what private.current_company_id() is derived from, so it
-- cannot name a stranger by construction.
create or replace function private.assert_material_check_fks_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.job_id is not null and not exists (
    select 1 from public.jobs j where j.id = new.job_id and j.company_id = new.company_id
  ) then
    raise exception 'job_id % is not in company %', new.job_id, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger material_checks_fks_same_company
  before insert or update of company_id, job_id on material_checks
  for each row execute function private.assert_material_check_fks_same_company();

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table material_checks enable row level security;

-- SELECT / INSERT / UPDATE for the owning company, and no DELETE — see the
-- 'unknown' status above. Unlike most tables added lately this one genuinely
-- needs the two write policies: the tick is a TENANT write, made from the
-- manager's own browser on their own RLS-scoped client.
create policy material_checks_select_company on material_checks
  for select to authenticated
  using (company_id = (select private.current_company_id()));

create policy material_checks_insert_company on material_checks
  for insert to authenticated
  with check (company_id = (select private.current_company_id()));

create policy material_checks_update_company on material_checks
  for update to authenticated
  using (company_id = (select private.current_company_id()))
  with check (company_id = (select private.current_company_id()));

-- Supabase default-grants ALL on a new public table, so revoke first and then
-- re-grant a COLUMN LIST.
--
-- Absent from INSERT, on purpose and each for its own reason:
--   check_date  — the day IS the reset, and a client that can name it can tick
--                 tomorrow. The column default is the only writer.
--   checked_by  — attribution; the trigger owns it.
--   checked_at  — freshness; the trigger owns it.
--
-- UPDATE reaches `status` ALONE. The identity columns must not move: a tenant
-- who could rewrite `material` or `job_id` on an existing row could relabel
-- yesterday's answer as today's about a different site, which is the one lie
-- this table would otherwise make easy. There is no upsert on this path (the
-- app reads, then inserts or updates by id), so the 0036 trap — PostgREST
-- assigning every payload column including the conflict target — does not
-- apply and the grant can stay this narrow.
revoke all on table material_checks from anon, authenticated;
grant select on table material_checks to authenticated;
grant insert (company_id, job_id, material, status) on table material_checks to authenticated;
grant update (status) on table material_checks to authenticated;

comment on table material_checks is
  'One daily tick per material per obra: is it on site, or missing? A check list, never an inventory — no quantities, no stock, no deliveries. Resets by construction, because check_date is part of the key and comes from lisbon_today().';
