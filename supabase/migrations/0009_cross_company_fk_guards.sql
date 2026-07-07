-- Cross-company FK integrity. RLS checks a row's OWN company_id, but not the
-- company of the rows its foreign keys point at. task_dependencies got this
-- right in 0007 (both edges checked); tasks.job_id / tasks.assignee_worker_id
-- and proposals.conversation_id did not. Without these guards an authenticated
-- user could file an own-company task/proposal that references ANOTHER
-- company's worker/job/conversation — and the worker reference in particular
-- leaks through dispatch_tasks_today into the shared SMS feed (n8n reads it as
-- the RLS-exempt postgres role). Enforced as triggers so they bind on every
-- path — user JWT, service-role, or postgres.

create or replace function private.assert_task_fks_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.job_id is not null and not exists (
    select 1 from public.jobs j where j.id = new.job_id and j.company_id = new.company_id
  ) then
    raise exception 'job_id % is not in company %', new.job_id, new.company_id
      using errcode = 'check_violation';
  end if;
  if new.assignee_worker_id is not null and not exists (
    select 1 from public.workers w where w.id = new.assignee_worker_id and w.company_id = new.company_id
  ) then
    raise exception 'assignee_worker_id % is not in company %', new.assignee_worker_id, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger tasks_fks_same_company
  before insert or update of company_id, job_id, assignee_worker_id on tasks
  for each row execute function private.assert_task_fks_same_company();

create or replace function private.assert_proposal_conversation_same_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.conversation_id is not null and not exists (
    select 1 from public.conversations c
    where c.id = new.conversation_id and c.company_id = new.company_id
  ) then
    raise exception 'conversation_id % is not in company %', new.conversation_id, new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger proposals_conversation_same_company
  before insert or update of company_id, conversation_id on proposals
  for each row execute function private.assert_proposal_conversation_same_company();

-- Defense in depth for the event-message insert: finalize_proposal is
-- SECURITY DEFINER and bypasses messages RLS, so re-derive the conversation
-- through the proposal and confirm it belongs to the proposal's company before
-- writing the resolution event. With the trigger above this is now guaranteed
-- for new/updated rows, but the function must not rely on that invariant.
create or replace function finalize_proposal(p_id uuid, p_status text, p_event text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation uuid;
  v_company uuid;
begin
  update proposals
    set status = p_status, resolved_at = now()
    where id = p_id
      and (auth.uid() is null or company_id = private.current_company_id())
    returning conversation_id, company_id into v_conversation, v_company;

  if v_conversation is not null and p_event is not null then
    -- only write the event if the conversation truly belongs to the proposal's
    -- company (guards against a proposal that references a foreign conversation)
    if exists (
      select 1 from conversations c where c.id = v_conversation and c.company_id = v_company
    ) then
      insert into messages (conversation_id, role, channel, content, content_format)
      values (
        v_conversation,
        'event',
        'system',
        jsonb_build_object('parts', jsonb_build_array(
          jsonb_build_object('type', 'text', 'text', p_event)
        )),
        'ui-message@7'
      );
    end if;
  end if;
end;
$$;
