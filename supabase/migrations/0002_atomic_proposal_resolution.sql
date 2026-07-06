-- Atomic proposal resolution.
-- 'executing' is a claim state: pending → executing happens via compare-and-set,
-- so concurrent approve clicks can never both execute. finalize_proposal flips
-- the final status and appends the resolution event in one transaction.

alter table proposals drop constraint proposals_status_check;
alter table proposals add constraint proposals_status_check
  check (status in ('pending', 'executing', 'approved', 'rejected', 'failed', 'expired'));

create or replace function finalize_proposal(p_id uuid, p_status text, p_event text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation uuid;
begin
  update proposals
    set status = p_status, resolved_at = now()
    where id = p_id
    returning conversation_id into v_conversation;

  if v_conversation is not null and p_event is not null then
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
end;
$$;
