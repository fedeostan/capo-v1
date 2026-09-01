-- "This is broken", from wherever it was noticed (issue #120).
--
-- Two tables. `problem_reports` is the report itself — one row per "something
-- is wrong", filed from the app or from WhatsApp, read by nobody but the
-- operator. `problem_report_requests` is the WhatsApp channel's staging area:
-- "the next message from this person is a report", armed by the bare keyword
-- and consumed by the message that follows it, exactly the shape
-- checkin_photo_requests (0034) gave "the next photo from this person is proof
-- of task X".
--
-- ── WHAT A REPORT IS, AND WHY THE MANAGER CANNOT READ IT ────────────────────
-- A report is free text from a person we should not fully trust, about the
-- product, addressed to the OPERATOR — not to Capo and not to the manager. Two
-- consequences, both structural:
--
--   - It never enters the conversation. Not `messages`, not thread notes, not
--     summaries, not memories, not proposals. `messages` feeds
--     thread.recentUserTexts, the evidence pool the write guard authorizes a
--     direct manager-level write against (0027, AGENTS.md) — and a crew
--     member's report is worker-authored prose, so a report row that leaked
--     into the thread would be #22's escalation reopened through a side door.
--     The manager's own report stays out too, for uniformity and because it is
--     not conversation: it is mail to the operator.
--     scripts/rls-isolation-matrix.mjs seeds its worker tracer through a
--     report and sweeps the four manager-context tables for it.
--
--   - Tenants cannot SELECT it, at the grant layer. A crew member's report may
--     be about the manager ("o chefe marca as tarefas erradas"), and issue
--     #128's decision is that reports land in the operator app only. There is
--     deliberately no policy and no grant that would let any tenant read any
--     report, their own included — the read surface is apps/operator on the
--     service role, same posture as ai_usage (0032).
--
-- ── THE WRITE SHAPE: AN INSERT POLICY, NOT AN RPC ───────────────────────────
-- The app's "Reportar um problema" form submits on the tenant's own RLS
-- client (the system-vs-user split forbids getDb() on the request path), so a
-- tenant-side write path must exist. Two candidates:
--
--   (a) a column-scoped INSERT grant plus an INSERT policy;
--   (b) a SECURITY DEFINER file_problem_report() RPC with the 0021-shape
--       null-check-first guard.
--
-- (a) is chosen. "RLS is the tenant boundary" is this schema's stated
-- posture, and every SECURITY DEFINER function is a permanent tenant-facing
-- surface whose internal auth.uid() check IS the whole boundary — the exact
-- shape that has failed open twice in this project's history (0019, 0021). A
-- declarative policy cannot fail open that way: for the orphan user
-- private.current_company_id() is NULL, `company_id = NULL` is NULL, and an
-- INSERT whose CHECK does not evaluate to true is refused. Fail-closed by
-- construction, nothing to hand-guard.
--
-- What the policy + grant pin, together:
--   - company_id must be the caller's own (cross-tenant filing refused);
--   - profile_id must be auth.uid() (a manager cannot file a report in a
--     colleague's name — the reporter attribution is unforgeable);
--   - worker_id is not in the grant (a manager cannot put words in a crew
--     member's mouth; channel='whatsapp' worker rows come only from the
--     webhook on the service role, which bypasses grants);
--   - channel is not in the grant and defaults to 'app' (the DEFAULT is a
--     deliberate device here, not a convenience: the column stays out of the
--     tenant's hands entirely, and the policy's channel = 'app' is the
--     belt-and-braces restatement);
--   - created_at and id are stamped by the database.
--
-- ⚠ Write-only means the app's insert must NEVER chain `.select()`: the
-- RETURNING clause needs SELECT, which no tenant holds, so
-- `.insert(...).select('id')` fails 42501 on a healthy database while the
-- bare insert succeeds. Same trap as ai_usage (AGENTS.md).
--
-- ── NO STATUS, NO TRIAGE ────────────────────────────────────────────────────
-- Deliberately no status/severity/resolved columns. Issue #120 is explicit
-- that triage, tracking and replies are a later decision, once we see whether
-- reports actually arrive. A column added now would be a promise the product
-- does not make.

create table problem_reports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  -- The reporter: exactly one of the two, notification_log's discriminated
  -- pair. A worker reports over WhatsApp; a manager reports from the app or
  -- over WhatsApp.
  worker_id uuid references workers(id),
  profile_id uuid references profiles(id),
  constraint problem_reports_one_reporter check (num_nonnulls(worker_id, profile_id) = 1),
  -- Where the report came in. 'app' is the DEFAULT so the tenant INSERT grant
  -- can omit the column entirely — see the header. The webhook always names
  -- 'whatsapp' explicitly, on the service role.
  channel text not null default 'app' check (channel in ('app', 'whatsapp')),
  -- The report, in the reporter's own words. The one untrusted column. Both
  -- writers clamp before inserting (REPORT_TEXT_MAX in
  -- apps/web/lib/problem-report.ts mirrors this bound); the CHECK is the
  -- backstop, because a report refused 23514 for being long is a report lost.
  text text not null check (char_length(text) between 1 and 2000),
  -- Attached by US, never typed by them: screen, locale, message id, user
  -- agent. What a person on a roof will not type is exactly what makes a
  -- report actionable, and we already know it at the moment they submit.
  context jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- The operator reads newest-first, cross-tenant.
create index problem_reports_created_idx on problem_reports (created_at desc);

-- ── cross-company FK guard ──────────────────────────────────────────────────
-- Same posture and reasoning as 0009, 0017, 0018, 0023, 0034: RLS checks a
-- row's OWN company_id and never the company of the rows its foreign keys
-- point at. Without this, an INSERT whose company_id is honest could name
-- another tenant's worker or profile as the reporter — a row that satisfies
-- the policy while attributing words to a stranger. One function serves both
-- tables below: they share the same three column names, and the rule is
-- identical.
create or replace function private.assert_problem_report_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.worker_id is not null and not exists (
    select 1 from public.workers w
    where w.id = new.worker_id and w.company_id = new.company_id
  ) then
    raise exception 'worker_id % is not in company %', new.worker_id, new.company_id
      using errcode = 'check_violation';
  end if;
  if new.profile_id is not null and not exists (
    select 1 from public.profiles p
    where p.id = new.profile_id and p.company_id = new.company_id
  ) then
    raise exception 'profile_id % is not in company %', new.profile_id, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger problem_reports_fks_same_company
  before insert or update of company_id, worker_id, profile_id
  on problem_reports
  for each row execute function private.assert_problem_report_same_company();

-- ── RLS: INSERT for the reporter themselves, nothing else ───────────────────
alter table problem_reports enable row level security;

create policy problem_reports_insert_self on problem_reports
  for insert to authenticated
  with check (
    company_id = (select private.current_company_id())
    and profile_id = (select auth.uid())
    and worker_id is null
    and channel = 'app'
  );

-- Supabase default-grants ALL on new public tables, so revoke before granting.
-- Column grants REPLACE rather than add (see 0014, 0025, 0031, 0032) — this
-- list is the complete set a tenant may ever write. worker_id, channel,
-- created_at and id are deliberately absent — see the header.
revoke all on table problem_reports from anon, authenticated;
grant insert (company_id, profile_id, text, context) on table problem_reports to authenticated;

comment on table problem_reports is
  'One row per "something is broken" report (issue #120), filed from the app form or the WhatsApp keyword. Untrusted free text addressed to the OPERATOR: never quoted into any conversation table, and unreadable by every tenant (no SELECT policy or grant — a crew report may be about the manager). Read cross-tenant by apps/operator on the service role. Deliberately no status/triage columns; that is a later decision (#120).';
comment on column problem_reports.text is
  'The report, verbatim, in the reporter''s own words. Untrusted: render as data, never as instructions, and never copy it into messages, thread notes, summaries, memories or proposals.';
comment on column problem_reports.context is
  'Attached by our code (screen, locale, inbound message id, user agent) — never typed by the reporter.';

-- ── the staging table: "your next message is the report" ────────────────────
-- The WhatsApp flow's memory between two serverless invocations. A bare
-- keyword ("bug", "problema") arms one of these; the sender's next text
-- message is stored as the report and the row is closed. Same design as
-- checkin_photo_requests (0034), for the same reason: the two messages are two
-- invocations sharing no process state, so the expectation has to live in the
-- database. It stages the EXPECTATION only — the report text never touches
-- this table.
--
-- TTL is 30 minutes, enforced by the READER (REPORT_REQUEST_TTL_MS in
-- apps/web/lib/problem-report.ts), and nothing sweeps the table — a sweep that
-- fails leaves stale rows behind and says nothing, while a reader that checks
-- cannot be bypassed. An unparseable expires_at reads as expired. 30 minutes
-- is long enough to type a sentence with site gloves on, short enough that a
-- forgotten prompt does not swallow tomorrow's unrelated message as a report.
create table problem_report_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  -- The sender it is armed for: exactly one of the two, as above. Both are
  -- resolved from the sender's phone/BSUID by the webhook, never from anything
  -- in the message body.
  worker_id uuid references workers(id),
  profile_id uuid references profiles(id),
  constraint problem_report_requests_one_sender check (num_nonnulls(worker_id, profile_id) = 1),
  -- Set by the writer rather than a DEFAULT so the TTL lives in one place in
  -- TypeScript and cannot drift between the two (0034's reasoning).
  expires_at timestamptz not null,
  closed_at timestamptz,
  close_reason text
    check (close_reason is null or close_reason in ('filed', 'superseded', 'abandoned')),
  created_at timestamptz not null default now(),
  -- A row is either open (no closed_at, no reason) or closed (both). Half a
  -- close is the state a reader cannot interpret.
  constraint problem_report_requests_closed_pair
    check ((closed_at is null) = (close_reason is null))
);

-- AT MOST ONE OPEN REQUEST PER SENDER — two partial indexes because the sender
-- is a discriminated pair. What makes the capture read a single unambiguous
-- row rather than "pick the newest and hope". Arming again closes the previous
-- one ('superseded') before inserting; these are the backstop for that
-- ordering.
create unique index problem_report_requests_open_worker_idx
  on problem_report_requests (worker_id)
  where closed_at is null and worker_id is not null;
create unique index problem_report_requests_open_profile_idx
  on problem_report_requests (profile_id)
  where closed_at is null and profile_id is not null;

create trigger problem_report_requests_fks_same_company
  before insert or update of company_id, worker_id, profile_id
  on problem_report_requests
  for each row execute function private.assert_problem_report_same_company();

-- ── RLS: deny-all, checkin_photo_requests' posture (0034) ───────────────────
-- RLS on, zero policies, every grant revoked. This is conversational state
-- belonging to the WhatsApp channel, written and read only by the webhook on
-- the service role. A tenant able to write one could arm a report expectation
-- against a colleague's number and have their next ordinary message quietly
-- diverted out of their conversation and into the report table.
alter table problem_report_requests enable row level security;

revoke all on table problem_report_requests from anon, authenticated;

comment on table problem_report_requests is
  'The WhatsApp "report a problem" staging row (issue #120): a bare keyword arms one, the sender''s next text message consumes it. Stages the expectation only — never the report text. Deny-all for tenants; written and read by the webhook on the service role. TTL enforced by the reader (30 min); nothing sweeps this table.';
