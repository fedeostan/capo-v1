-- Planning engine: tasks gain an estimated duration and materials list.
-- task_dependencies already exists (0001) with RLS + cross-company guards
-- (0007/0009) — reused as-is by the day-by-day plan's dependency edges.
alter table tasks add column duration_days integer check (duration_days is null or duration_days > 0);
alter table tasks add column materials text[];
