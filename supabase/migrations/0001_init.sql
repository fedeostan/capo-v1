-- Capo foundation schema.
-- Domain tables (the task-graph) are deliberately separate from agent memory tables.
-- company_id everywhere: multi-tenancy is out of scope, but it is the scoping key
-- future triggers need — cheap now, painful to retrofit.

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table workers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  trade text,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  address text,
  client_name text,
  status text not null default 'active' check (status in ('active', 'paused', 'done')),
  starts_on date,
  ends_on date,
  created_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  job_id uuid references jobs(id),
  title text not null,
  description text,
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'blocked', 'done', 'cancelled')),
  assignee_worker_id uuid references workers(id),
  due_date date,
  -- who originated the task: the manager's explicit command or Capo's own suggestion
  source text not null check (source in ('manager', 'capo')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The task-graph edges. No tool exposes this yet; the day-by-day planning
-- engine will need edges, not just nodes.
create table task_dependencies (
  task_id uuid not null references tasks(id) on delete cascade,
  depends_on_task_id uuid not null references tasks(id) on delete cascade,
  primary key (task_id, depends_on_task_id)
);

-- Memory tier 1: conversational/episodic.
-- One perpetual thread per company, shared across channels (channel lives on the message).
create table conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  created_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id),
  -- 'event' is first-class: proposal resolutions etc. are system events,
  -- never to be conflated with something the manager said.
  role text not null check (role in ('user', 'assistant', 'tool', 'event')),
  channel text not null default 'web',
  content jsonb not null,
  -- the UIMessage shape broke between SDK majors before; version the payload
  content_format text not null default 'ui-message@7',
  created_at timestamptz not null default now()
);

create index messages_conversation_created_idx
  on messages (conversation_id, created_at);

create table conversation_summaries (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id),
  summary text not null,
  covers_until_message_id uuid not null references messages(id),
  created_at timestamptz not null default now()
);

-- Memory tier 2: durable/semantic. Queryable by kind/subject; no vectors.
create table memories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  kind text not null check (kind in ('company', 'job', 'worker', 'preference', 'fact')),
  subject_type text check (subject_type in ('job', 'worker')),
  subject_id uuid,
  content text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The propose/approve primitive. rendered_text is generated server-side from
-- action_args — never model-authored — so the card cannot lie about the payload.
create table proposals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  conversation_id uuid references conversations(id),
  action_name text not null,
  action_args jsonb not null,
  rendered_text text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'failed', 'expired')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- No client-side access this pass: RLS on with no policies (deny all through
-- PostgREST); the app talks to the DB with the service-role key only.
alter table companies enable row level security;
alter table workers enable row level security;
alter table jobs enable row level security;
alter table tasks enable row level security;
alter table task_dependencies enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table conversation_summaries enable row level security;
alter table memories enable row level security;
alter table proposals enable row level security;
