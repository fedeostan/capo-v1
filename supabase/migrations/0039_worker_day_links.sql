-- The crew member's own day, on a web page (issue #114, filed first against the old
-- Firebase codebase, then rewritten against this tree).
--
-- ── WHAT THE 07:00 MESSAGE STRUCTURALLY CANNOT SAY ─────────────────────────
-- The briefing renders `task_board` rows where `active_today` is true, and
-- `active_today` is `today between window_start and coalesce(due_date,
-- 'infinity')` (0013). A task whose deadline has already passed therefore has
-- `active_today = false` and appears in NEITHER daily send. The board shows it
-- under Atrasadas; the person who has to do it hears nothing about it. That is
-- the gap this link closes: a read-only page carrying today's work AND the
-- overdue work, in the crew member's own language, with nothing to install and
-- nothing to log into.
--
-- ── WHY A TABLE AND NOT A SIGNED TOKEN ─────────────────────────────────────
-- A stateless signed token (HMAC over worker_id + date) needs no table and is
-- tempting for exactly that reason. It is refused here because it cannot be
-- REVOKED: a crew member who leaves, a phone that is lost, a number that is
-- reassigned — with a signature there is no row to delete and the link keeps
-- working until its own expiry, whatever the manager does. A row can be
-- deleted. It also cannot be counted, and "has anyone ever opened this?" is a
-- question Federico will ask.
--
-- ── THE TOKEN IS A BEARER CREDENTIAL AND TRAVELS IN PLAIN TEXT ─────────────
-- It goes over WhatsApp, where it sits in a chat log on a phone that is passed
-- around a van. Four properties follow, and all four are enforced here rather
-- than in app code:
--
--   LONG      — 32 random bytes, base64url. Not guessable, and the CHECK below
--               refuses anything short enough to be.
--   NARROW    — it resolves to (company_id, worker_id) and to nothing else.
--               There is no session, no cookie, no write path, and the page it
--               opens has no control on it. The worst a leaked token buys is a
--               read of one crew member's own to-do list.
--   ROTATED   — one row per worker per LISBON DAY (the unique index below), so
--               a new token is minted each morning and yesterday's stops being
--               the one in circulation.
--   EXPIRING  — `expires_at`, enforced by the READER (resolveDayLink in
--               apps/web/lib/day-link.ts) exactly as checkin_photo_requests'
--               TTL is. Nothing sweeps this table: a sweep that fails leaves
--               live credentials behind, whereas a reader that checks cannot.
--               The row survives its expiry on purpose — "which token did we
--               send on the 3rd" stays answerable.
create table worker_day_links (
  -- The credential itself, and the primary key: a lookup is one index probe on
  -- the value the visitor supplied, and there is no second identifier that
  -- could be enumerated in its place.
  token text primary key
    check (length(token) between 32 and 128),
  company_id uuid not null references companies(id),
  worker_id uuid not null references workers(id),
  -- The Lisbon day this token was minted FOR. It is what makes rotation a
  -- CONSTRAINT rather than a convention (see the unique index below), and it is
  -- also, in effect, the validity window: expires_at is the end of this day.
  link_date date not null,
  -- The end of `link_date` in Europe/Lisbon, computed by lisbonDayEnd() in
  -- apps/web/lib/day-link.ts. A DAY BOUNDARY rather than a duration, because
  -- #114 settles what a leaked link may expose — today only — and the page reads
  -- the LIVE board rather than a morning snapshot. A "48 hours" TTL would
  -- quietly widen that promise to tomorrow's work as well.
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- Bookkeeping, deliberately not a limit. A crew member who opens their list
  -- six times has not done anything wrong, and a link that stopped working
  -- after one tap would be a link that stops working when WhatsApp prefetches
  -- it. Recorded because "nobody ever opens this" and "everybody opens this"
  -- are different products and today we cannot tell them apart.
  opened_count integer not null default 0 check (opened_count >= 0),
  last_opened_at timestamptz
);

-- ONE LIVE TOKEN PER CREW MEMBER PER DAY. This is what makes minting idempotent
-- on the cron path: two invocations pass the send window every day (#51), and
-- the second one's insert is refused (23505) rather than putting a second
-- credential for the same person into circulation.
create unique index worker_day_links_worker_date_idx
  on worker_day_links (worker_id, link_date);

create index worker_day_links_company_date_idx
  on worker_day_links (company_id, link_date desc);

-- ── cross-company FK guard ─────────────────────────────────────────────────
-- Same posture and the same reasoning as 0009, 0017, 0018, 0023 and 0034: RLS
-- checks a row's OWN company_id and never the company of the rows its foreign
-- keys point at. The only writer is the briefing cron on the SERVICE ROLE — the
-- one path RLS does not cover at all — and this row's whole job is to answer
-- "which company's board may this visitor read", so a row pairing an honest
-- company_id with another tenant's worker would be a cross-tenant read wearing
-- a valid signature.
create or replace function private.assert_worker_day_link_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.workers w
    where w.id = new.worker_id and w.company_id = new.company_id
  ) then
    raise exception 'worker_id % is not in company %', new.worker_id, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger worker_day_links_fks_same_company
  before insert or update of company_id, worker_id on worker_day_links
  for each row execute function private.assert_worker_day_link_same_company();

-- ── RLS ────────────────────────────────────────────────────────────────────
-- notification_log's posture (0016) and checkin_photo_requests' (0034): RLS on,
-- deliberately ZERO policies, i.e. deny-all for `authenticated` and `anon`.
--
-- A tenant that could READ this table would hold every one of their crew's live
-- credentials, which is not information a manager needs — the manager has the
-- board. A tenant that could WRITE one could mint a token pointing at a worker
-- and then read that worker's day through the public page; the trigger above
-- constrains it to their OWN company, but "one manager silently reads another
-- manager's crew page" is still not a thing to leave available. And `anon` is
-- the visitor of the public page itself: the page resolves the token on the
-- service role precisely so that the anonymous browser never gets a database
-- credential of any kind.
--
-- Asserted by scripts/rls-isolation-matrix.mjs (checkWorkerDayLinkScope).
alter table worker_day_links enable row level security;

revoke all on table worker_day_links from anon, authenticated;

comment on table worker_day_links is
  'Bearer tokens for the read-only crew day page (/dia). Deny-all: minted and '
  'resolved by the service role only. One per worker per Lisbon day; TTL '
  'enforced by the reader, never by a sweep.';

-- ── the open counter ───────────────────────────────────────────────────────
-- A function rather than an UPDATE from the app because `opened_count + 1` is
-- an expression and supabase-js can only send values — a read-modify-write from
-- TypeScript would lose counts whenever two taps race, which on a link that
-- WhatsApp itself prefetches is not a hypothetical.
--
-- NOT security definer, and deliberately so: the only caller is the page's own
-- service-role client, which is exempt from RLS already. Adding definer rights
-- here would create a fourth SECURITY DEFINER surface whose entire guard would
-- have to be a token comparison, for a counter. The grants below are the
-- boundary instead — `anon` is the visitor's own role and must never be able to
-- reach this, even though it does nothing but increment.
create or replace function note_day_link_opened(p_token text)
returns void
language sql
set search_path = ''
as $$
  update public.worker_day_links
     set opened_count = opened_count + 1,
         last_opened_at = now()
   where token = p_token;
$$;

revoke all on function note_day_link_opened(text) from public, anon, authenticated;
grant execute on function note_day_link_opened(text) to service_role;
