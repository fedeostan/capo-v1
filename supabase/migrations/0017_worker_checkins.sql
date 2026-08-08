-- The 16:30 Europe/Lisbon check-in: "did you finish today's tasks?", asked by a
-- WhatsApp template and answered by tapping one of its two quick-reply buttons.
--
-- This migration records ANSWERS and nothing else. It deliberately does NOT
-- touch tasks.status: flipping a task because someone tapped a button is a
-- separate decision with a much larger blast radius, and the day it lands it
-- should land against a table that already holds the answers.
--
-- Nothing here writes dispatch_log or reads dispatch_tasks_today. The SMS
-- contract stays frozen (AGENTS.md). The ASK is claimed in notification_log
-- under kind='task_checkin' — a different kind from 'daily_briefing', which is
-- what keeps the two daily sends from colliding on that table's
-- unique (kind, audience, worker_id, profile_id, notification_date).

-- ── worker_checkins ────────────────────────────────────────────────────────
-- One row per worker per day, holding their LATEST answer.
--
-- Written only at ANSWER time. The ask is already fully recorded in
-- notification_log (kind, date, task_ids snapshot, send status), so a row here
-- means "this person actually answered" — which is why `answer` is not null and
-- there is no third 'unanswered' state to interpret. "Who was asked and did not
-- reply" is a LEFT JOIN against notification_log, not a null in this table.
create table worker_checkins (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  worker_id uuid not null references workers(id),
  -- Copied from the ask, never read off the clock at answer time. The buttons
  -- stay tappable indefinitely, so a worker answering at 23:50 — or the next
  -- morning — must still be recorded against the day they were ASKED about.
  checkin_date date not null,
  -- The notification_log row of the ask, and the id that travels inside the
  -- WhatsApp quick-reply payload (see checkinPayload() in
  -- packages/core/src/channels/whatsapp.ts). Carrying the ASK id rather than
  -- the worker id is what gives the webhook a single row to check ownership
  -- against instead of inferring which day a tap belongs to.
  --
  -- Nullable only so a backfill or an operator correction does not have to
  -- invent one; the webhook always sets it.
  notification_id uuid references notification_log(id),
  -- Deliberately 'not_done', not 'pending'. 'pending' already means "we have
  -- not acted yet" in notification_log.status and proposals.status, and a
  -- worker saying "ainda não" is an ANSWER, not the absence of one. Reusing the
  -- word would force a mapping between two vocabularies that can drift.
  answer text not null check (answer in ('done', 'not_done')),
  -- Set explicitly by the writer on every upsert. A DEFAULT alone fires only on
  -- INSERT, so a worker who taps "Ainda não" at 16:35 and then "Sim, terminei"
  -- at 17:40 would keep the 16:35 timestamp against the 17:40 answer — a wrong
  -- value rather than a missing one, which is the kind that survives review.
  answered_at timestamptz not null default now(),
  -- The tasks the worker was ASKED about, snapshotted at 16:30 and copied from
  -- the ask. Not re-derived from task_board at answer time: the manager may
  -- have reassigned or closed something in between, and the answer is about
  -- what was on the card.
  task_ids jsonb not null default '[]',
  -- Meta's wamid for the tap. The dedupe key that separates a webhook
  -- REDELIVERY (Meta retries on non-200 or timeout, same wamid) from a genuine
  -- change of mind (new wamid, and worth a fresh acknowledgement).
  inbound_message_id text,
  created_at timestamptz not null default now()
);

-- One answer per worker per day, last tap wins. This is also the ON CONFLICT
-- target the webhook upserts against, which is what makes a redelivered webhook
-- and a change of mind converge on one row instead of stacking a history nobody
-- asked for.
alter table worker_checkins
  add constraint worker_checkins_once_per_day
    unique (worker_id, checkin_date);

create index worker_checkins_company_date_idx
  on worker_checkins (company_id, checkin_date desc);

-- ── cross-company FK guard ─────────────────────────────────────────────────
-- Same posture and the same reasoning as 0009: RLS checks a row's OWN
-- company_id but never the company of the rows its foreign keys point at. The
-- only writer here is the WhatsApp webhook on the SERVICE ROLE, which is
-- precisely the path RLS does not cover — so the route's own ownership read is
-- the first boundary and this is the second. Without it, a tap whose payload
-- named another tenant's ask would land a foreign notification_id on an
-- own-company row.
create or replace function private.assert_worker_checkin_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.workers w
    where w.id = new.worker_id and w.company_id = new.company_id
  ) then
    raise exception 'worker_id % is not in company %', new.worker_id, new.company_id
      using errcode = 'check_violation';
  end if;
  if new.notification_id is not null and not exists (
    select 1 from public.notification_log n
    where n.id = new.notification_id and n.company_id = new.company_id
  ) then
    raise exception 'notification_id % is not in company %', new.notification_id, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger worker_checkins_fks_same_company
  before insert or update of company_id, worker_id, notification_id on worker_checkins
  for each row execute function private.assert_worker_checkin_same_company();

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Unlike notification_log (0016), which is deny-all because it is an outbound
-- SEND ledger read only by the operator app on the service role, this is tenant
-- data: the crew's answers about the tenant's own tasks, and the manager is its
-- natural reader. A SELECT policy now means the check-in screen is a screen,
-- not a screen plus a migration.
--
-- SELECT only, and no grants beyond it. There is deliberately NO insert or
-- update policy: the sole writer is the WhatsApp webhook on the service role. A
-- tenant able to write here could forge a worker's answer — and that answer is
-- exactly what a later PRD will trust when it decides whether a task is
-- finished. No delete policy either, matching every other table in the schema.
alter table worker_checkins enable row level security;

create policy worker_checkins_select_company on worker_checkins
  for select to authenticated
  using (company_id = (select private.current_company_id()));

-- Supabase default-grants on new public tables, so revoke before granting.
-- This line, not the absent policy, is what actually makes the answers
-- unforgeable — see the 0014 note that column grants REPLACE rather than add.
revoke all on table worker_checkins from anon, authenticated;
grant select on table worker_checkins to authenticated;
