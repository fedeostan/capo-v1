-- SMS dispatch prep: tasks.start_date, E.164 phones, the n8n read contract
-- (dispatch_tasks_today view) and the n8n-owned idempotency ledger (dispatch_log).

alter table tasks add column start_date date;

-- Backfill existing PT mobile numbers before constraining (3 rows predate E.164).
update workers set phone = '+351' || phone where phone ~ '^9\d{8}$';
alter table workers add constraint workers_phone_e164
  check (phone is null or phone ~ '^\+[1-9]\d{7,14}$');

-- The ONLY surface n8n reads — treat as a stable API. "Today" is computed in
-- Europe/Lisbon inside the view so n8n never reasons about timezones.
-- security_invoker: without it the view runs with owner rights and the public
-- anon key could read through it despite deny-all RLS on the tables.
create view dispatch_tasks_today
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
  and (now() at time zone 'Europe/Lisbon')::date
      between coalesce(t.start_date, (t.created_at at time zone 'Europe/Lisbon')::date)
          and coalesce(t.due_date, 'infinity');

-- n8n's idempotency ledger: one dispatch per worker per day. n8n writes it;
-- Capo only owns the shape.
create table dispatch_log (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references workers(id),
  dispatch_date date not null,
  task_ids jsonb not null default '[]',
  channel text not null default 'sms',
  sent_at timestamptz not null default now(),
  provider_message_id text,
  unique (worker_id, dispatch_date)
);
alter table dispatch_log enable row level security;
