-- A paused obra is PAUSED, not deleted (issue #95).
--
-- ── WHY THIS MIGRATION EXISTS ──────────────────────────────────────────────
-- Federico: "If a manager says 'I'm going on holidays', or 'I'm pausing this
-- construction', it doesn't mean that the site is out. It simply means no work
-- should be booked those dates."
--
-- dashboard_obras has carried `where j.status = 'active'` since 0005, and it
-- is the ONLY reader behind the Obras screen. So the moment a manager paused a
-- site, the site left the app: no row, no badge, no explanation, and no way
-- back except knowing the /obras/<uuid> URL by heart. Nothing had been
-- deleted, and nothing anywhere said so.
--
-- Every other surface already read `paused` the way the manager means it:
--
--   task_board.overdue        deliberately IGNORES job_active (0013), so an
--                             overdue task on a paused obra still surfaces
--   task_board.risk_paused_job exists precisely to BADGE those tasks
--   task_board.active_today/  exclude them, which is the "book no work" half
--     active_tomorrow          and is exactly right — the crew is not asked
--   loadObraOptions           already reads `jobs` rather than this view, with
--                             a comment saying why
--
-- This view was the one place that read `paused` as `gone`.
--
-- ── SHAPE ──────────────────────────────────────────────────────────────────
-- `create or replace view` with an IDENTICAL column list, in the same order
-- and the same types: Postgres allows appending columns to a view in place but
-- never reordering or retyping them, and here nothing is appended at all. Only
-- the WHERE clause moves. `status` was ALREADY selected, so the Obras screen
-- can badge a paused row with no new column and no type regeneration.
--
-- Grants survive `create or replace view` untouched, and security_invoker is
-- restated so RLS keeps applying to the caller rather than to the view owner.
--
-- ── WHAT STAYS OUT, AND WHY ────────────────────────────────────────────────
-- `done` is deliberately NOT included. A finished obra has no work left to
-- book, so it is not the case this issue is about, and the screen it belongs
-- on — a history of closed sites — does not exist yet. Adding it here would
-- quietly change what the `pendentes` and `concluidas` tallies mean on the
-- screen that DOES exist, which is a different product decision wearing this
-- one's clothes.
--
-- Consequence to remember: the Obras list is no longer "active obras". Any
-- future reader of this view that assumes every row is active has to filter on
-- `status` itself. There is exactly one reader today (loadObras in
-- apps/web/app/dashboard-data.ts) and it sorts paused rows to the bottom.

create or replace view dashboard_obras
with (security_invoker = true) as
select
  j.id,
  j.company_id,
  j.name,
  j.address,
  j.status,
  count(t.id) filter (where t.status not in ('done', 'cancelled')) as pendentes,
  count(t.id) filter (where t.status = 'done') as concluidas
from jobs j
left join tasks t on t.job_id = j.id
where j.status in ('active', 'paused')
group by j.id;

comment on view dashboard_obras is
  'Obras screen: sites that still have work to book, ACTIVE or PAUSED (issue #95). '
  'A paused site is one where no work should be booked right now — it is not gone, '
  'so it keeps its row and its tallies. Finished sites are excluded.';
