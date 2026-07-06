-- overdue was three-valued: `due_date < lisbon_today()` yields NULL for tasks
-- without a deadline. Make it a real boolean so filtering on false doesn't
-- silently drop no-deadline tasks.
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
  (t.due_date is not null and t.due_date < lisbon_today()) as overdue,
  greatest(0, lisbon_today() - t.due_date) as days_overdue
from tasks t
left join jobs j on j.id = t.job_id
left join workers w on w.id = t.assignee_worker_id
where t.status not in ('done', 'cancelled');
