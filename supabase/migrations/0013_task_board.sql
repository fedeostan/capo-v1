-- The read surface for the /tarefas board: one row per task (open AND closed)
-- with its obra/worker denormalised, the date window exposed as columns so an
-- arbitrary date can be filtered through PostgREST, and every schedule-risk
-- signal precomputed. Like every other read view here it is security_invoker,
-- so RLS applies to the caller.
--
-- Why a new view instead of extending dashboard_tasks: that view hard-excludes
-- done/cancelled, omits assignee/duration/materials, hardcodes its buckets to
-- lisbon_today() with no column an arbitrary date could filter on, and knows
-- nothing about dependencies.
--
-- Purely additive. dispatch_tasks_today (the frozen n8n/Twilio contract) is not
-- touched. dashboard_tasks is deliberately LEFT IN PLACE so an old bundle
-- served mid-deploy keeps working; dropping it is a follow-up migration.
--
-- Structured with LATERAL rather than a CTE because a SELECT list cannot
-- reference its own aliases: each stage reads the earlier ones, and
-- lisbon_today() is evaluated exactly once per row.

create view task_board
with (security_invoker = true) as
select
  t.id,
  t.company_id,
  t.title,
  t.description,
  t.status,
  t.start_date,
  t.due_date,
  t.duration_days,
  t.materials,
  t.job_id,
  t.assignee_worker_id,
  t.created_at,
  t.updated_at,
  j.name   as job_name,
  j.status as job_status,
  w.name   as worker_name,
  d.today,
  c.is_open,
  c.job_active,
  c.window_start,
  c.window_end,
  b.active_today,
  b.active_tomorrow,
  r.overdue,
  case when t.due_date is null then 0
       else greatest(0, d.today - t.due_date) end as days_overdue,
  r.risk_blocked,
  r.risk_late_start,
  r.risk_due_soon,
  r.risk_late_dependency,
  r.risk_paused_job,
  -- Deliberately disjoint from `overdue`: the Atrasadas and Em risco filters
  -- must never show the same task twice, or the manager double-counts their
  -- trouble. Something already late is not "at risk", it is late. The
  -- individual risk_* flags are NOT suppressed, so an overdue+blocked task
  -- still renders its "bloqueada" reason under Atrasadas.
  (c.is_open
   and not r.overdue
   and (r.risk_blocked or r.risk_late_start or r.risk_due_soon
        or r.risk_late_dependency or r.risk_paused_job)) as at_risk,
  ld.late_titles as late_dependency_titles,
  dp.all_titles  as depends_on_titles
from tasks t
left join jobs    j on j.id = t.job_id
left join workers w on w.id = t.assignee_worker_id
cross join lateral (select lisbon_today() as today) d
cross join lateral (
  select
    (t.status not in ('done', 'cancelled'))    as is_open,
    (t.job_id is null or j.status = 'active')  as job_active,
    coalesce(t.start_date,
             (t.created_at at time zone 'Europe/Lisbon')::date) as window_start,
    coalesce(t.due_date, 'infinity'::date)     as window_end,
    -- "within the next two WORKING days", in pure SQL, matching the planner's
    -- own weekend-skipping scheduler: Thu->Mon, Fri->Tue, Sat->Tue, rest +2.
    d.today + (case extract(isodow from d.today)::int
                 when 4 then 4
                 when 5 then 4
                 when 6 then 3
                 else 2
               end) as due_soon_until
) c
left join lateral (
  -- Predecessors that are themselves unfinished and past their own deadline.
  -- array_agg over no rows yields NULL, which is what risk_late_dependency tests.
  select array_agg(x.title order by x.due_date, x.title) as late_titles
  from task_dependencies td
  join tasks x on x.id = td.depends_on_task_id
  where td.task_id = t.id
    and x.status not in ('done', 'cancelled')
    and x.due_date is not null
    and x.due_date < d.today
) ld on true
left join lateral (
  select array_agg(x.title order by x.title) as all_titles
  from task_dependencies td
  join tasks x on x.id = td.depends_on_task_id
  where td.task_id = t.id
) dp on true
cross join lateral (
  select
    (c.is_open and c.job_active
       and d.today     between c.window_start and c.window_end) as active_today,
    (c.is_open and c.job_active
       and d.today + 1 between c.window_start and c.window_end) as active_tomorrow
) b
cross join lateral (
  -- overdue keeps 0005's deliberate asymmetry: unlike the active_* buckets it
  -- ignores job_active, so an overdue task on a paused obra still surfaces
  -- (badged, not hidden).
  select
    (c.is_open and t.due_date is not null and t.due_date < d.today) as overdue,
    (c.is_open and t.status = 'blocked')                            as risk_blocked,
    (c.is_open and t.status = 'pending'
       and t.start_date is not null and t.start_date < d.today)     as risk_late_start,
    (c.is_open and t.status = 'pending'
       and t.due_date is not null
       and t.due_date >= d.today
       and t.due_date <= c.due_soon_until)                          as risk_due_soon,
    (c.is_open and ld.late_titles is not null)                      as risk_late_dependency,
    -- coalesce, not `j.status = 'paused'`: job_id is nullable, and a
    -- three-valued boolean here is exactly the bug 0006 exists to fix.
    (c.is_open and coalesce(j.status, '') = 'paused')               as risk_paused_job
) r;

grant select on task_board to authenticated, service_role;
