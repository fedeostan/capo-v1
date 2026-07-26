-- Worker reminders move from SMS (external n8n + Twilio) to WhatsApp.
--
-- Nothing here touches dispatch_tasks_today or dispatch_log. The SMS path is
-- PAUSED, not removed: the n8n workflow is switched off outside this repo, and
-- its read contract stays byte-identical so it can be switched back on. That
-- is also exactly why the new sends get their own ledger below rather than
-- reusing dispatch_log — see notification_log.

-- ── workers.language ───────────────────────────────────────────────────────
-- The THIRD language dial, and the only one its subject sets for themselves:
-- a worker replies "ES" to their WhatsApp briefing and this column flips.
--
-- Nullable, unlike profiles.language and companies.language, and the null is
-- load-bearing: NULL means "inherit companies.language", so a company that
-- changes its language carries along every worker who never expressed a
-- preference. A NOT NULL DEFAULT would freeze today's company language into
-- every existing row and silently break that inheritance.
--
-- Note what this does NOT do: task titles and materials are stored in
-- companies.language and nothing retranslates existing rows (see 0014). A
-- worker on 'es-ES' therefore gets a Spanish sentence wrapping Portuguese task
-- titles. Deliberate — the alternative is a translation layer.
alter table workers
  add column language text
    check (language is null or language in ('pt-PT', 'es-ES', 'en-US'));

-- ── the clock ──────────────────────────────────────────────────────────────
-- Companion to lisbon_today() (0005, hardened in 0008). The reminder cron runs
-- on Vercel, which schedules in UTC, while "07:00" means 07:00 in Lisbon —
-- an offset that changes twice a year. Rather than teach the route about
-- WET/WEST, it asks Postgres what time it is there. One clock.
create function lisbon_hour() returns integer
language sql stable
as $$ select extract(hour from now() at time zone 'Europe/Lisbon')::int $$;
alter function lisbon_hour() set search_path = '';

-- ── notification_log ───────────────────────────────────────────────────────
-- Our own outbound ledger, deliberately NOT dispatch_log.
--
-- dispatch_log is the n8n/Twilio contract and carries unique (worker_id,
-- dispatch_date) — one row per worker per day across ALL channels. Writing
-- WhatsApp sends there would work today only because SMS is off; the day SMS
-- comes back, the morning text and the morning WhatsApp message would collide
-- on that constraint and one of them would silently fail to be recorded.
-- A separate table also lets us log manager-directed sends, which have no
-- worker_id at all.
create table notification_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  kind text not null,                          -- 'daily_briefing'
  audience text not null check (audience in ('worker', 'manager')),
  worker_id uuid references workers(id),
  profile_id uuid references profiles(id),
  notification_date date not null,
  channel text not null default 'whatsapp',
  -- 'pending' is written first, as a CLAIM on this target for today, before
  -- the Graph API call — that is what makes the unique constraint below an
  -- idempotency lock rather than an after-the-fact record. A row still sitting
  -- at 'pending' means the function died mid-send, which is worth knowing.
  -- 'skipped' is a real outcome, not an absence: we looked at this target and
  -- decided there was nothing worth a paid template send.
  status text not null check (status in ('pending', 'sent', 'failed', 'skipped')),
  task_ids jsonb not null default '[]',
  provider_message_id text,
  error text,
  created_at timestamptz not null default now(),
  constraint notification_log_one_target check (num_nonnulls(worker_id, profile_id) = 1)
);

-- Idempotency, and the reason the route can be retried or double-scheduled
-- safely. NULLS NOT DISTINCT because exactly one of worker_id/profile_id is
-- always null: under the default NULLS DISTINCT, every manager row would look
-- unique to Postgres and the manager could be messaged repeatedly.
alter table notification_log
  add constraint notification_log_once_per_day
    unique nulls not distinct (kind, audience, worker_id, profile_id, notification_date);

create index notification_log_company_date_idx
  on notification_log (company_id, notification_date desc);

-- Same posture as dispatch_log (0007): RLS enabled with deliberately NO
-- policies, i.e. deny-all for authenticated. The cron writes it as the service
-- role and no tenant surface reads it. Asserted by scripts/rls-isolation-matrix.mjs.
alter table notification_log enable row level security;
