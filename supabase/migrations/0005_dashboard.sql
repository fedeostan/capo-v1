-- Dashboard read surface. Factors "today in Europe/Lisbon" into lisbon_today()
-- so the SMS dispatch and the dashboard can never disagree about the date, and
-- adds the read-only views the PWA dashboard queries. The dashboard reads; the
-- chat writes — nothing here is writable surface.

create function lisbon_today() returns date
language sql stable
as $$ select (now() at time zone 'Europe/Lisbon')::date $$;

-- Internal refactor only: identical columns and rows to 0003, with the inline
-- today-expression replaced by lisbon_today(). The n8n contract is unchanged.
create or replace view dispatch_tasks_today
with (security_invoker = true) as
select
  w.id   as worker_id,
  w.name as worker_name,
  w.phone as worker_phone,
  t.id   as task_id,
  t.title as task_title,
  t.description as task_description,
  j.name as job_name,
  j.address as job_address,
  t.start_date,
  t.due_date,
  t.status
from tasks t
join workers w on w.id = t.assignee_worker_id
left join jobs j on j.id = t.job_id
where w.active
  and w.phone is not null
  and t.status in ('pending', 'in_progress')
  and (t.job_id is null or j.status = 'active')
  and lisbon_today()
      between coalesce(t.start_date, (t.created_at at time zone 'Europe/Lisbon')::date)
          and coalesce(t.due_date, 'infinity');

-- One row per open task with the date buckets precomputed in SQL, because the
-- coalesce(created_at at time zone ...) window is not expressible in PostgREST
-- filters. Differences from the dispatch view are deliberate: no phone/assignee
-- requirement, and 'blocked' is included (the dashboard shows it with a badge;
-- SMS does not nag about it). active_today/active_tomorrow keep the dispatch
-- job filter (paused obras are silenced), overdue does not — an overdue task
-- must surface even when its obra is paused, so the UI can badge it instead.
create view dashboard_tasks
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
  greatest(0, lisbon_today() - t.due_date) as days_overdue
from tasks t
left join jobs j on j.id = t.job_id
left join workers w on w.id = t.assignee_worker_id
where t.status not in ('done', 'cancelled');

-- Active obras with their task tallies for the Obras screen.
create view dashboard_obras
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
where j.status = 'active'
group by j.id;
