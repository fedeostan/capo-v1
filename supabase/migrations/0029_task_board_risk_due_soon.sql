-- Narrow `risk_due_soon` so a task is only "at risk" once its start window has
-- actually opened.
--
-- The bug (issue #61): a task scheduled to start TOMORROW and due on Friday was
-- shown under the Em risco chip TODAY. 0013's risk_due_soon fired purely on the
-- proximity of the deadline -- `status = 'pending' and due_date between today
-- and due_soon_until` -- with no regard for whether the work was even supposed
-- to have begun yet. Nothing has gone wrong with that task: it is simply
-- scheduled.
--
-- A near deadline is only a RISK if the work could already have begun. Before
-- its start date the task is on plan, and calling that "at risk" trains the
-- manager to ignore the chip -- which is the real cost of a false positive. The
-- signal is only worth having if every task under it is one the manager should
-- act on today.
--
-- The change is one conjunct appended to risk_due_soon:
--
--     and (t.start_date is null or t.start_date <= d.today)
--
-- A null start_date keeps firing, unchanged: a task with no planned start could
-- have been begun at any time, so a near deadline on it is a genuine risk. The
-- sibling signal risk_late_start (`start_date < today`) is untouched -- a task
-- that should already have started and has not is still flagged, deadline or
-- no deadline.
--
-- This is a PURE NARROWING. The new conjunct can only ever make risk_due_soon
-- false where it was true, never the reverse, and `at_risk` is a disjunction
-- over the five risk_* flags, so at_risk can only lose rows too. No task that
-- was calm becomes alarming. That is the safe direction, which is why this
-- ships with no behaviour flag and no backfill: the next read of the view is
-- simply quieter.
--
-- Nothing else about the view changes. Columns keep their names, types and
-- order (Postgres forbids anything else under `create or replace view`), the
-- other four risk signals are byte-identical, and dispatch_tasks_today (the
-- frozen n8n/Twilio contract) is not touched.
--
-- The body below is copied from 0027 -- NOT from 0013. 0013 created the view;
-- 0027 replaced it, appending `job_address` as the 34th column. Rebuilding
-- from 0013 would drop that column, and `create or replace view` refuses
-- outright ("cannot drop columns from view"), so the mistake fails loudly
-- rather than silently -- but only at apply time. Anyone editing task_board
-- again must start from the LATEST replacement, which is now this file.
--
--
-- DEFERRED FOLLOW-UP: `risk_unconfirmed`
--
-- Issue #61 also asks for a sixth signal: a task nobody has confirmed is a task
-- at risk. Concretely, the crew gets a WhatsApp briefing at 07:00 and a
-- check-in at ~16:30; if a task on today's board has been asked about and no
-- worker has answered, the manager arguably should hear about it before the day
-- ends. That is a real gap and it is NOT built here, for two reasons.
--
-- First, the data. The honest source is `worker_checkins` (0017) -- the
-- recorded tap on the check-in template. The tempting one is `notification_log`
-- (0016), the outbound send ledger, because it knows what was ASKED. But
-- notification_log has RLS enabled with deliberately ZERO policies: nobody but
-- the service role may read it, ever. task_board is `security_invoker` and is
-- read by tenants on every board load, so joining notification_log into it
-- would manufacture a tenant-readable window onto a table whose whole design is
-- that tenants cannot read it. Any future risk_unconfirmed must key on
-- worker_checkins, or on a new column that is safe to expose -- never on the
-- send ledger.
--
-- Second, the semantics are moving underneath it. Issue #54 is changing what a
-- check-in tap MEANS: the tap will start filing a `pending_review` completion
-- claim rather than merely recording an answer. "Unconfirmed" therefore does
-- not yet have a settled definition -- is a task with an outstanding review
-- confirmed or not? Building a risk signal on top of semantics that change this
-- same week is how you ship a signal that is wrong by morning. It waits until
-- #54 has landed and the meaning of a tap is fixed.

create or replace view task_board
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
  dp.all_titles  as depends_on_titles,
  -- APPENDED by 0027. Everything above this line is byte-identical to 0013.
  j.address as job_address
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
    -- 0029: the start-window conjunct. A deadline two working days out is only
    -- a risk once the task could already have been started; before that it is
    -- merely scheduled. Null start_date still fires -- see the header.
    (c.is_open and t.status = 'pending'
       and t.due_date is not null
       and t.due_date >= d.today
       and t.due_date <= c.due_soon_until
       and (t.start_date is null or t.start_date <= d.today))       as risk_due_soon,
    (c.is_open and ld.late_titles is not null)                      as risk_late_dependency,
    -- coalesce, not `j.status = 'paused'`: job_id is nullable, and a
    -- three-valued boolean here is exactly the bug 0006 exists to fix.
    (c.is_open and coalesce(j.status, '') = 'paused')               as risk_paused_job
) r;

-- create or replace view preserves existing grants, but restating them costs
-- nothing and makes this file readable on its own.
grant select on task_board to authenticated, service_role;
