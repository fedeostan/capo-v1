-- The welcome message: once per person, ever (issue #45).
--
-- Nothing here creates a table. The welcome rides notification_log — the same
-- OUTBOUND ledger the 07:00 briefing and the late-afternoon check-in already
-- claim their sends on — because that table's unique constraint is this
-- project's idempotency lock and inventing a second mechanism beside it is how
-- two mechanisms end up disagreeing. This migration adds exactly two things: a
-- partial unique index that turns "once per day" into "once ever" for the
-- welcome kind, and a backfill so the first deploy does not replay history.
--
-- No new policy, and deliberately so. notification_log is RLS-enabled with zero
-- policies (0016) — deny-all for `authenticated`, written only by the cron on
-- the service role, readable by nobody through the tenant client. That posture
-- is unchanged here; #51B owns any question about making this table readable.

-- ── once EVER, not once per day ────────────────────────────────────────────
-- notification_log's existing lock is
--   unique nulls not distinct (kind, audience, worker_id, profile_id,
--                              notification_date)
-- which is exactly right for a DAILY send and exactly wrong for this one: under
-- it, a welcome could be claimed again tomorrow, and the sweep that looks for
-- "people never welcomed" would welcome the same crew every single morning, at
-- a paid template each.
--
-- So: a PARTIAL unique index, scoped to `kind = 'welcome'`, over the person
-- alone. The date column is absent from it on purpose — that absence IS the
-- feature.
--
-- NULLS NOT DISTINCT for the same reason 0016 needed it: exactly one of
-- worker_id / profile_id is non-null on every row (the notification_log_one_target
-- CHECK enforces that), so under Postgres's default NULLS DISTINCT every
-- manager row would look unique to the index and the manager could be welcomed
-- repeatedly.
--
-- Created BEFORE the backfill below, so the backfill is itself protected: if it
-- were ever re-run by hand, the second run would raise 23505 rather than
-- quietly doubling every row.
create unique index notification_log_welcome_once
  on notification_log (worker_id, profile_id)
  nulls not distinct
  where kind = 'welcome';

-- ── the backfill, which is MANDATORY ───────────────────────────────────────
-- Without it, the first deploy of this feature sends a "welcome to Capo" paid
-- template to every crew member and every manager who already has consent on
-- record — people who have been using Capo for weeks. That is the same failure
-- 0026 avoided when it stamped `pushed_at` on every existing notifications row:
-- a marker column added to a populated table replays history unless the history
-- is marked as already handled.
--
-- Every EXISTING worker and profile is marked, not only the consenting ones.
-- The welcome exists to introduce Capo the first time a number enters the
-- system; a row that predates the feature has already been introduced by
-- whatever means the pilot used, and a retroactive introduction would read as
-- the system having forgotten who it was talking to.
--
-- `status = 'skipped'` rather than 'sent', because 'skipped' is what
-- notification_log already means by "we looked at this target and decided there
-- was nothing worth a paid send" (0016). Claiming 'sent' would be a lie in the
-- one table an operator uses to reconstruct what Meta was actually paid for.
--
-- notification_date comes from lisbon_today() — one clock, as everywhere else.
-- It is not read by the once-ever index above; it is here because the column is
-- NOT NULL and the ledger should say when the decision was taken.
insert into notification_log (company_id, kind, audience, worker_id, notification_date, status)
select w.company_id, 'welcome', 'worker', w.id, lisbon_today(), 'skipped'
from workers w;

insert into notification_log (company_id, kind, audience, profile_id, notification_date, status)
select p.company_id, 'welcome', 'manager', p.id, lisbon_today(), 'skipped'
from profiles p;

-- ── the deploy gate ────────────────────────────────────────────────────────
-- A marker function, and the only reason it exists is that on THIS project a
-- migration has been skipped in production before while a later one was
-- applied. If the welcome code shipped without the two things above, the first
-- sweep would introduce Capo, by paid template, to every crew member and every
-- manager already using it — the exact failure this migration exists to
-- prevent, produced by the migration merely being late.
--
-- So the sweep asks for this function before it sends anything, and a missing
-- function is a REFUSAL: no welcome goes out until the ledger can enforce
-- once-ever. Fail closed, like every other gate in this product — a welcome
-- that is a day late is a nuisance, and a welcome sent to two hundred people
-- who have been using Capo for a month is a bill and an apology.
--
-- It returns a constant on purpose. There is nothing to compute: its EXISTENCE
-- is the fact being asked about.
create function welcome_ledger_ready() returns boolean
language sql immutable
as $$ select true $$;
alter function welcome_ledger_ready() set search_path = '';
-- service_role ONLY. The sweep is a system path (getDb(), no auth.uid()), and
-- no tenant surface has any reason to ask this question — so `authenticated` is
-- not granted it, the same posture 0007 takes with private.current_company_id().
-- Nothing here is secret; the narrow grant is simply the honest description of
-- who calls it, and scripts/rls-isolation-matrix.mjs needs no new check because
-- this adds no readable data at all.
revoke execute on function welcome_ledger_ready() from public;
grant execute on function welcome_ledger_ready() to service_role;

-- ── the window this leaves open, stated rather than hidden ─────────────────
-- A worker or manager row created BETWEEN this migration being applied and the
-- code being deployed is not marked, so they will be welcomed on the first
-- sweep after the deploy. That is a handful of seconds to a few minutes of
-- exposure, and the failure it produces is one extra correct-looking message to
-- somebody who genuinely was just added — the cheap direction.
