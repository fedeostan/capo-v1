-- Extend the dashboard read surface so the materials-anticipation screen, the
-- team screen, and the agent's `agenda`/`materials_outlook` tools all read the
-- SAME date logic the Hoje/Amanhã/Atrasadas screens already read.
--
-- Why a view change instead of querying `tasks` directly: the active-window
-- rule (lisbon_today() between coalesce(start_date, created_at) and
-- coalesce(due_date, 'infinity')) is not expressible as a PostgREST filter.
-- Every consumer that re-implements it in TypeScript is a chance for Capo and
-- the dashboard to disagree about what day it is — which is exactly the bug
-- this migration exists to make impossible.
--
-- `create or replace view` may only APPEND columns, never reorder or retype
-- them. Everything before `materials` below is byte-identical to 0005; the new
-- columns are appended. dispatch_tasks_today is deliberately untouched — it is
-- the external n8n/Twilio contract.

create or replace view dashboard_tasks
with (security_invoker = true) as
select
  t.id,
  t.company_id,
  t.title,
  t.description,
  t.status,
  t.start_date,
  t.due_date,
  t.job_id,
  j.name  as job_name,
  j.status as job_status,
  w.name  as worker_name,
  ((t.job_id is null or j.status = 'active')
    and lisbon_today()
        between coalesce(t.start_date, (t.created_at at time zone 'Europe/Lisbon')::date)
            and coalesce(t.due_date, 'infinity')) as active_today,
  ((t.job_id is null or j.status = 'active')
    and lisbon_today() + 1
        between coalesce(t.start_date, (t.created_at at time zone 'Europe/Lisbon')::date)
            and coalesce(t.due_date, 'infinity')) as active_tomorrow,
  (t.due_date < lisbon_today()) as overdue,
  greatest(0, lisbon_today() - t.due_date) as days_overdue,
  -- ── appended in 0013 ──
  t.materials,
  t.duration_days,
  t.assignee_worker_id,
  j.address as job_address,
  -- Window-intersection (not point-in-window like active_today): a task counts
  -- for the week if any part of it overlaps [today, today+6]. This is the
  -- horizon the materials screen uses for lead-time ordering.
  ((t.job_id is null or j.status = 'active')
    and coalesce(t.start_date, (t.created_at at time zone 'Europe/Lisbon')::date) <= lisbon_today() + 6
    and coalesce(t.due_date, 'infinity') >= lisbon_today()) as active_this_week
from tasks t
left join jobs j on j.id = t.job_id
left join workers w on w.id = t.assignee_worker_id
where t.status not in ('done', 'cancelled');
