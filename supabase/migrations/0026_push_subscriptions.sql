-- Web Push (PRD 7, #25): the device registry, plus the delivery stamp that
-- turns the 0024 inbox into the push queue.
--
-- Read this next to 0024. `notifications` decided WHO is told WHAT, by trigger,
-- so no producer can forget. This migration decides how that same row reaches a
-- phone whose owner is not looking at the app. It deliberately adds NO new
-- notification kind and NO new producer: a push exists if and only if a
-- notifications row exists, which is what makes "no push without an inbox
-- entry" structural rather than a rule someone has to remember.

-- ── push_subscriptions ─────────────────────────────────────────────────────
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  -- Per-PROFILE, like notifications and for the same reason: this is one
  -- person's phone. A colleague must not be able to read it (the endpoint is a
  -- capability — anyone holding it can ask the push service to buzz that
  -- device) and must not be able to delete it.
  profile_id uuid not null references profiles(id) on delete cascade,
  -- The push service URL the browser minted. GLOBALLY unique: one endpoint is
  -- one browser install. On a shared handset the row must MOVE to the new
  -- manager, never duplicate — two rows would buzz one device twice and, far
  -- worse, buzz it for the wrong person. The API route reclaims by endpoint on
  -- the service role before inserting.
  endpoint text not null unique,
  -- The browser's own encryption material. The payload is sealed with these
  -- before it leaves us, which is why Apple and Google carry an envelope they
  -- cannot open.
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  -- Written only by the dispatcher on the service role. There is no UPDATE
  -- grant below, so a tenant cannot launder a failing registration into a
  -- healthy-looking one.
  last_failed_at timestamptz
);

create index push_subscriptions_profile_idx on push_subscriptions (profile_id);

-- ── cross-company FK guard ─────────────────────────────────────────────────
-- Same hole 0009 exists to close, and the same shape as 0024's guard: RLS
-- checks a row's OWN company_id, never the company of the rows its FKs point
-- at. A row whose company_id is tenant A's but whose profile_id is tenant B's
-- would be invisible to both policies while still naming another tenant's user.
create or replace function private.assert_push_subscription_fks_same_company()
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

create trigger push_subscriptions_fks_same_company
  before insert or update of company_id, profile_id
  on push_subscriptions
  for each row execute function private.assert_push_subscription_fks_same_company();

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table push_subscriptions enable row level security;

-- Two predicates, like notifications. company_id is the tenant boundary;
-- profile_id is what makes this one person's phone rather than the company's.
create policy push_subscriptions_select_own on push_subscriptions
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and profile_id = (select auth.uid())
  );

create policy push_subscriptions_insert_own on push_subscriptions
  for insert to authenticated
  with check (
    company_id = (select private.current_company_id())
    and profile_id = (select auth.uid())
  );

-- THE FIRST DELETE POLICY IN THIS SCHEMA, and a deliberate departure from the
-- no-DELETE posture everywhere else. Everything else in this database records
-- a business event and therefore marks rather than removes. This records a
-- DEVICE, and "turn alerts off on this phone" has to actually remove the
-- address: a stale endpoint the push service still honours is exactly how
-- someone keeps being buzzed after opting out. Bounded to the caller's own
-- rows, and attacked directly in scripts/rls-isolation-matrix.mjs.
create policy push_subscriptions_delete_own on push_subscriptions
  for delete to authenticated
  using (
    company_id = (select private.current_company_id())
    and profile_id = (select auth.uid())
  );

-- ── column grants ──────────────────────────────────────────────────────────
-- Supabase default-grants ALL on new public tables, so revoke first.
-- No UPDATE grant at all: last_failed_at belongs to the dispatcher.
revoke all on table push_subscriptions from anon, authenticated;
grant select, delete on table push_subscriptions to authenticated;
grant insert (company_id, profile_id, endpoint, p256dh, auth, user_agent)
  on table push_subscriptions to authenticated;

-- ── the delivery stamp on the 0024 inbox ───────────────────────────────────
-- An unstamped row is an undelivered parcel. This is the whole queue.
alter table notifications
  add column pushed_at timestamptz,
  add column push_attempts smallint not null default 0;

-- MANDATORY, and the one line in this file that cannot be added later.
-- Without it, the first deploy after this migration treats every notification
-- ever written as undelivered and buzzes every manager about all of it.
update notifications set pushed_at = now();

-- The dispatcher's only query. Partial, so it stays proportional to what is
-- pending rather than to the whole history.
create index notifications_push_pending_idx
  on notifications (created_at) where pushed_at is null;

-- No grant change on notifications: the existing `grant update (read_at)`
-- already means a tenant cannot write either new column.
