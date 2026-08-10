-- The in-app inbox: the first notification surface this product has ever had.
--
-- Until now the only way a manager learned anything was the 07:00 WhatsApp
-- briefing or scrolling the board. 0018 gave workers a way to declare a task
-- finished; without this table that claim sits on a board row nobody is
-- looking at.
--
-- Read carefully what this is NOT: it is not notification_log (0016). That
-- table is an OUTBOUND ledger — one row per paid WhatsApp template send, RLS
-- enabled with deliberately zero policies, written only by the cron as the
-- service role, and readable by nobody. This table is the opposite on every
-- axis: read by the tenant on every page load, written only by triggers, and
-- per-PROFILE rather than per-company. Sharing a name is as close as they get.

-- ── notifications ──────────────────────────────────────────────────────────
create table notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  -- Per-MANAGER, not per-company, and that is the whole reason the read
  -- state can mean anything. A company-scoped row with one read_at would let
  -- whichever manager opened the app first clear the badge for everyone
  -- else. One row per recipient; the fan-out happens in the trigger below.
  profile_id uuid not null references profiles(id) on delete cascade,
  -- Constrained on purpose, and the constraint is the point: this value is
  -- the key into the i18n catalog's `kind` Record, which is typed
  -- Record<NotificationKind, …> so a missing translation is a tsc error.
  -- Adding a kind is therefore always a TWO-place edit — this constraint and
  -- all three dictionaries — and a producer that skips the migration fails
  -- loudly here instead of rendering a blank line in the inbox.
  --
  -- Only 'review_pending' exists today. PRD #22 (worker completion) reuses it
  -- unchanged: a worker declaration IS a task_reviews insert, so it already
  -- flows through the trigger below with no edit. #23's 'reschedule_proposed'
  -- will need this list widened.
  kind text not null check (kind in ('review_pending')),
  -- What the notification is ABOUT, so the inbox can link somewhere useful
  -- and so the resolution trigger below can find the rows to retire. Nullable
  -- as a pair for a future kind that is about nothing in particular.
  subject_type text check (subject_type is null or subject_type in ('task_review')),
  subject_id uuid,
  -- DATA, never UI copy. title is the task's own title (stored in
  -- companies.language) and body is the worker's note (their own words). The
  -- sentence wrapped around them is resolved per reader from
  -- profiles.language at render time — see packages/i18n's notifications.kind.
  --
  -- Denormalised rather than joined: a notification must keep saying what it
  -- said when it was written, even after the task is renamed, translated by
  -- translate_company_data, or deleted. It is a record of a moment.
  --
  -- body carries WORKER-AUTHORED TEXT and inherits 0018's rule wholesale: the
  -- inbox renders it as an attributed quote, never as UI copy. It authorizes
  -- nothing — the manager-side guard matches against the MANAGER's own recent
  -- texts, so a note reading "ignore previous instructions" is just a quote
  -- the manager reads and disbelieves.
  title text,
  body text,
  -- NULL = unread. A timestamp rather than a boolean so "when did they see
  -- this" survives, and so marking read is idempotent under a double tap.
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- The inbox query: this profile's rows, newest first.
create index notifications_inbox_idx
  on notifications (profile_id, created_at desc);

-- The badge count, which runs on EVERY page load inside the app shell. A
-- partial index keeps that read proportional to what is unread rather than to
-- the whole history — the one query in this feature that has to stay cheap
-- forever.
create index notifications_unread_idx
  on notifications (profile_id) where read_at is null;

-- ── cross-company FK guard ─────────────────────────────────────────────────
-- RLS checks a row's OWN company_id, never the company of the rows its FKs
-- point at — the hole 0009 exists to close. Here it would be severe: a
-- notification whose company_id is tenant A's but whose profile_id belongs to
-- tenant B is invisible to BOTH policies below (A's manager fails the
-- profile_id test, B's manager fails the company test), so it would be
-- undetectable by reading alone while still being a row that names another
-- tenant's user. Enforced as a trigger so it binds on every path, including
-- the SECURITY DEFINER producers below.
create or replace function private.assert_notification_fks_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = new.profile_id and p.company_id = new.company_id
  ) then
    raise exception 'profile_id % is not in company %', new.profile_id, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger notifications_fks_same_company
  before insert or update of company_id, profile_id
  on notifications
  for each row execute function private.assert_notification_fks_same_company();

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table notifications enable row level security;

-- TWO predicates, not one. company_id is the tenant boundary every other
-- table uses; profile_id is what makes this an inbox rather than a company
-- bulletin board. Either alone would be a bug: company_id alone lets a
-- colleague read (and mark read) notifications addressed to someone else,
-- and profile_id alone would survive a profile being re-pointed at another
-- company — which 0007 blocks at the grant layer, but a policy should not
-- depend on another table's grants to be correct.
create policy notifications_select_own on notifications
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and profile_id = (select auth.uid())
  );

-- UPDATE exists solely so the reader can mark their own rows read. The
-- policy allows the statement; the column grant below decides what it may
-- touch. WITH CHECK repeats the predicate so a row cannot be handed to
-- another profile on its way out.
create policy notifications_update_own on notifications
  for update to authenticated
  using (
    company_id = (select private.current_company_id())
    and profile_id = (select auth.uid())
  )
  with check (
    company_id = (select private.current_company_id())
    and profile_id = (select auth.uid())
  );

-- No INSERT and no DELETE policy, deliberately. Every row is written by the
-- triggers below, so a tenant cannot manufacture a notification (which would
-- be, at worst, a way to put arbitrary attacker-chosen text in front of a
-- colleague under the app's own chrome). Nothing deletes: like the
-- translation undo (0015), this schema marks rather than removes.

-- ── column grants ──────────────────────────────────────────────────────────
-- Supabase default-grants ALL on new public tables, so revoke first.
--
-- read_at is the ONLY writable column, at the grant layer rather than only in
-- a policy. Same device as profiles' (full_name, phone) grant in 0007: with a
-- policy alone, an UPDATE that also rewrote `title` or `kind` would satisfy
-- the predicate and be applied, and the manager would be reading a
-- notification whose text their own browser chose.
revoke all on table notifications from anon, authenticated;
grant select on table notifications to authenticated;
grant update (read_at) on table notifications to authenticated;

-- ── producer: a pending review ─────────────────────────────────────────────
-- A TRIGGER, not a call inside open_task_review, and that is the load-bearing
-- choice in this migration. open_task_review is not the only way a review
-- gets filed — PRD 4's restricted worker agent will call it, the WhatsApp
-- webhook will, a backfill might insert directly as the service role — and
-- every one of those paths would otherwise have to remember to notify.
-- Attached to the table, the fan-out cannot be forgotten.
--
-- SECURITY DEFINER because the tenant has no INSERT grant on notifications
-- (see above) and because it reads profiles, which is RLS-covered.
create or replace function private.notify_review_pending()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (company_id, profile_id, kind, subject_type, subject_id, title, body)
  select
    new.company_id,
    p.id,
    'review_pending',
    'task_review',
    new.id,
    (select t.title from public.tasks t where t.id = new.task_id),
    new.note
  from public.profiles p
  where p.company_id = new.company_id
    -- Never notify the actor about their own action. A manager who tapped
    -- "pedir controlo" on the task detail screen does not need an unread
    -- badge telling them they did. IS DISTINCT FROM, not <>: auth.uid() is
    -- NULL for the service role and the cron (a worker-declared completion),
    -- and `p.id <> NULL` is NULL — under a plain <> that case would notify
    -- NOBODY, silently, which is the exact failure this feature exists to
    -- prevent. Same three-valued-logic trap as 0019/0021, inverted: here the
    -- naive form fails CLOSED, so it would have been a silent no-op rather
    -- than a leak. Still wrong, and much harder to notice.
    and p.id is distinct from auth.uid();
  return null; -- AFTER trigger; the return value is ignored.
end;
$$;

create trigger task_reviews_notify_pending
  after insert on task_reviews
  for each row execute function private.notify_review_pending();

-- ── retirement: the review stops being pending ─────────────────────────────
-- An unread badge pointing at a decision that has already been made is worse
-- than no badge: it trains the manager to ignore the badge. Every exit from
-- 'pending' retires the notification, whichever door it left by —
-- resolve_task_review (approved/rejected/dismissed) or the 0020
-- tasks_supersede_review trigger ('superseded', when update_task moved the
-- task out of pending_review behind the review's back).
--
-- Marks read rather than deleting: uniform with the rest of the schema, and
-- the inbox's history stays truthful about what the manager was told.
--
-- Note this reads as "read" even when the manager never opened the inbox —
-- correct, because resolving the review IS having dealt with it. Resolution
-- happens on the Tarefas board, not in the inbox, so requiring a second visit
-- to clear the badge would make the badge lie in the other direction.
create or replace function private.retire_review_notifications()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.notifications
     set read_at = now()
   where subject_type = 'task_review'
     and subject_id = new.id
     and read_at is null;
  return null;
end;
$$;

create trigger task_reviews_retire_notifications
  after update of status on task_reviews
  for each row
  when (old.status = 'pending' and new.status is distinct from 'pending')
  execute function private.retire_review_notifications();
