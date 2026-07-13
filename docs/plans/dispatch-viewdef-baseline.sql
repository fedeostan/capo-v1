-- Baseline snapshot of dispatch_tasks_today, captured before the 2026-07-13 capo-upgrade.
-- select pg_get_viewdef('dispatch_tasks_today'::regclass, true);
-- Must remain byte-identical after every migration in this upgrade (see AGENTS.md global constraints).

 SELECT w.id AS worker_id,
    w.name AS worker_name,
    w.phone AS worker_phone,
    t.id AS task_id,
    t.title AS task_title,
    t.description AS task_description,
    j.name AS job_name,
    j.address AS job_address,
    t.start_date,
    t.due_date,
    t.status
   FROM tasks t
     JOIN workers w ON w.id = t.assignee_worker_id
     LEFT JOIN jobs j ON j.id = t.job_id
  WHERE w.active AND w.phone IS NOT NULL AND (t.status = ANY (ARRAY['pending'::text, 'in_progress'::text])) AND (t.job_id IS NULL OR j.status = 'active'::text) AND lisbon_today() >= COALESCE(t.start_date, (t.created_at AT TIME ZONE 'Europe/Lisbon'::text)::date) AND lisbon_today() <= COALESCE(t.due_date, 'infinity'::date);
