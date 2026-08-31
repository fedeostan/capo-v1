-- Serialize agent turns per conversation (issue #125).
--
-- ── the problem ────────────────────────────────────────────────────────────
-- Two WhatsApp messages seconds apart are two serverless invocations racing
-- through handleInbound: message 2's turn loads the thread while message 1's
-- turn is mid-flight, so it answers without seeing that turn's answer or its
-- tool results. Live consequences on one tenant: three crew members proposed
-- twice (#124's six cards), one obra planned twice. A debounce was rejected
-- by the product owner — no fixed delay on the lone uncontended message that
-- is the common case.
--
-- ── the design ─────────────────────────────────────────────────────────────
-- A turn for a conversation may not begin while another runs for the same
-- conversation. The lock lives HERE, in Postgres, because there is nowhere
-- else for it to live: a warm serverless instance shares no memory with the
-- invocation racing it. Three columns on `conversations` and three RPCs:
--
--   claim_conversation_turn   'claimed' | 'queued'. ONE atomic row update:
--                             a free or expired lock is taken; a held one
--                             gets a queued mark. There is no path that does
--                             neither — that atomicity is the whole race
--                             closure. A contender's mark either lands before
--                             the holder's release check reads the row, or
--                             its claim sees a free lock and wins it.
--   finish_conversation_turn  'released' | 'continue' | 'lost'. The holder
--                             calls it after persisting its answer; 'continue'
--                             means messages queued behind the running turn,
--                             and the holder answers them as ONE MERGED TURN
--                             (reload the window, run again) instead of each
--                             queuer starting a blind turn of its own.
--   renew_conversation_turn   the lease heartbeat, called between model
--                             steps. A turn that dies stops renewing and the
--                             lock self-clears within the TTL: a conversation
--                             must NEVER jam shut (#126's failure mode held a
--                             turn open for 75 minutes; this lock is bounded
--                             at p_ttl_seconds no matter how a turn dies).
--
-- The lease is time-bounded, so 'lost' exists: a holder that outlives its
-- lease may find another token on the row. It must then stop — its context is
-- stale by definition — and touch nothing.
--
-- The code path (handleInbound) DEGRADES when these functions are missing:
-- PGRST202/42883 answers "run unlocked", byte-for-byte the pre-0040 product.
-- A deploy landing before this migration is applied loses serialization for a
-- while — which is today's behaviour — never the chat itself. Same posture as
-- readCompanySchedules (0036).
--
-- ── the guard shape (the 0021 lesson) ──────────────────────────────────────
-- All three functions are SECURITY DEFINER, so RLS does not apply inside them
-- and the explicit check is the ENTIRE tenant boundary. The null-company case
-- RAISES rather than being folded into one boolean expression: the folded
-- form (`if auth.uid() is not null and x <> current_company_id()`) fails OPEN
-- when the company resolves to NULL, which is every signup that never
-- finished onboarding — exploit-confirmed against this production database
-- and closed in 0021. So: non-null auth.uid() with no company → raise;
-- non-null auth.uid() whose company does not own the conversation → raise,
-- with the same message as a genuine miss so another tenant's uuid is never
-- confirmed to exist.
--
-- A NULL auth.uid() proceeds unguarded. That is safe because of the grants
-- below, not in spite of them: `anon` (and public) have EXECUTE revoked, so
-- the only callers that exist are `authenticated` — whose JWT always carries
-- a uid, so the guard always applies — and `service_role`, the webhook path,
-- which resolved the tenant itself before it ever had a conversation id to
-- pass. There is no caller that reaches the null-uid branch untrusted.
--
-- ── why the columns are not tenant-writable ────────────────────────────────
-- `conversations` still carries its Supabase default table-wide grants from
-- 0001, and the uniform 0007 policy triple includes UPDATE — so without the
-- revoke below, a tenant could write the three lock columns directly through
-- PostgREST: hold their own conversation shut for a TTL, or clear a running
-- turn's lock and reopen the race this migration exists to close. No code
-- path updates `conversations` on a tenant client (the only tenant write is
-- ensureConversation's INSERT), so the revoke costs nothing and makes the
-- lock unforgeable at the grant layer — the same move 0011 made on
-- `companies`. SELECT and INSERT grants are untouched; the 0007 UPDATE
-- policy stays behind, unreachable, a record rather than a hazard.

alter table conversations
  add column turn_lock_token uuid,
  add column turn_lock_expires_at timestamptz,
  add column turn_queued_at timestamptz;

comment on column conversations.turn_lock_token is
  'Bearer token of the invocation currently running a turn (issue #125). Written only by the claim/finish/renew RPCs; null means no turn is running.';
comment on column conversations.turn_lock_expires_at is
  'Lease expiry for turn_lock_token. An expired lease is a free lock: a dead turn stops renewing and the conversation unjams itself within the TTL.';
comment on column conversations.turn_queued_at is
  'Set when a message arrived while a turn held the lock. The holder reads it at finish time and answers the queued messages as one merged turn.';

revoke update on table conversations from anon, authenticated;

-- ── claim ──────────────────────────────────────────────────────────────────
-- ONE UPDATE statement, deliberately: under READ COMMITTED a concurrent
-- writer blocks on the row lock and this statement then re-evaluates its CASE
-- conditions against the committed row version, so two simultaneous claims on
-- a free lock resolve to exactly one 'claimed' and one 'queued'. Splitting it
-- into read-then-write would reopen the race in the very function built to
-- close it.
--
-- A successful claim CLEARS turn_queued_at: the claimer is about to load the
-- full thread, so any mark left by the previous holder's era is covered by
-- this turn — carrying it forward would make the new holder's finish report a
-- phantom 'continue' and bill an extra model call answering nothing.
create function claim_conversation_turn(p_conversation uuid, p_token uuid, p_ttl_seconds integer default 120)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The clamp bounds a caller mistake, not a taste: below 10s a healthy turn
  -- loses its lock between steps; above 600s a dead turn jams the
  -- conversation for ten minutes, which is the failure the lease exists to
  -- bound. The code constant is 120.
  v_ttl integer := least(greatest(coalesce(p_ttl_seconds, 120), 10), 600);
  v_company uuid;
  v_claimed boolean;
begin
  if auth.uid() is not null then
    v_company := private.current_company_id();
    if v_company is null then
      raise exception 'no company for %', auth.uid() using errcode = 'insufficient_privilege';
    end if;
    if not exists (
      select 1 from public.conversations c
      where c.id = p_conversation and c.company_id = v_company
    ) then
      -- Same message as a genuine miss: never confirm another tenant's id.
      raise exception 'conversation not found' using errcode = 'insufficient_privilege';
    end if;
  end if;

  update public.conversations c
  set turn_lock_token = case
        when c.turn_lock_expires_at is null or c.turn_lock_expires_at < now()
        then p_token else c.turn_lock_token end,
      turn_lock_expires_at = case
        when c.turn_lock_expires_at is null or c.turn_lock_expires_at < now()
        then now() + make_interval(secs => v_ttl) else c.turn_lock_expires_at end,
      turn_queued_at = case
        when c.turn_lock_expires_at is null or c.turn_lock_expires_at < now()
        then null else now() end
  where c.id = p_conversation
  -- RETURNING sees NEW values. IS NOT DISTINCT FROM rather than `=`: a row
  -- whose token is somehow null while its lease is live would otherwise make
  -- this NULL and report a real row as missing.
  returning (c.turn_lock_token is not distinct from p_token) into v_claimed;

  if not found then
    raise exception 'conversation not found' using errcode = 'no_data_found';
  end if;
  return case when v_claimed then 'claimed' else 'queued' end;
end;
$$;

-- ── finish ─────────────────────────────────────────────────────────────────
-- SELECT ... FOR UPDATE then branch: the row lock makes the read-and-decide
-- atomic against a concurrent claim, whose single UPDATE blocks until this
-- transaction commits. So a queuer's mark either lands before the read below
-- — and the holder merges it — or the queuer's claim attempt runs after the
-- release and wins the lock for a turn of its own. No mark is ever read as
-- both, and none is read as neither.
--
-- p_force is the code's error path and merge cap: clear everything token-
-- permitting, never report 'continue'. A capped or failing turn must leave
-- the conversation immediately free — the next inbound message picks the
-- thread up.
create function finish_conversation_turn(p_conversation uuid, p_token uuid, p_force boolean default false)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_lock_token uuid;
  v_queued_at timestamptz;
begin
  if auth.uid() is not null then
    v_company := private.current_company_id();
    if v_company is null then
      raise exception 'no company for %', auth.uid() using errcode = 'insufficient_privilege';
    end if;
    if not exists (
      select 1 from public.conversations c
      where c.id = p_conversation and c.company_id = v_company
    ) then
      raise exception 'conversation not found' using errcode = 'insufficient_privilege';
    end if;
  end if;

  select c.turn_lock_token, c.turn_queued_at
    into v_lock_token, v_queued_at
    from public.conversations c
    where c.id = p_conversation
    for update;
  if not found then
    raise exception 'conversation not found' using errcode = 'no_data_found';
  end if;

  -- Somebody else owns the lease (ours expired and was claimed). Touch
  -- NOTHING: the new holder's turn is live and this row is its state.
  if v_lock_token is distinct from p_token then
    return 'lost';
  end if;

  if (not p_force) and v_queued_at is not null then
    -- Messages queued while the turn ran. Keep the lock, renew the lease so
    -- the merged iteration is not racing its own expiry, clear the mark —
    -- the caller reloads the window, which holds every queued message,
    -- because a queuer persists its message BEFORE its claim sets the mark.
    -- 120 matches the code constant; the next iteration's step renewals
    -- extend it anyway.
    update public.conversations c
    set turn_queued_at = null,
        turn_lock_expires_at = now() + make_interval(secs => 120)
    where c.id = p_conversation;
    return 'continue';
  end if;

  update public.conversations c
  set turn_lock_token = null,
      turn_lock_expires_at = null,
      turn_queued_at = null
  where c.id = p_conversation;
  return 'released';
end;
$$;

-- ── renew ──────────────────────────────────────────────────────────────────
-- The heartbeat. Token in the WHERE clause, so an expired-and-reclaimed lease
-- renews nothing and answers false — the holder learns it is lost at the next
-- finish. `turn_lock_token = p_token` is null-safe here: a null stored token
-- makes the comparison NULL, the row does not match, and found is false.
create function renew_conversation_turn(p_conversation uuid, p_token uuid, p_ttl_seconds integer default 120)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ttl integer := least(greatest(coalesce(p_ttl_seconds, 120), 10), 600);
  v_company uuid;
begin
  if auth.uid() is not null then
    v_company := private.current_company_id();
    if v_company is null then
      raise exception 'no company for %', auth.uid() using errcode = 'insufficient_privilege';
    end if;
    if not exists (
      select 1 from public.conversations c
      where c.id = p_conversation and c.company_id = v_company
    ) then
      raise exception 'conversation not found' using errcode = 'insufficient_privilege';
    end if;
  end if;

  update public.conversations c
  set turn_lock_expires_at = now() + make_interval(secs => v_ttl)
  where c.id = p_conversation
    and c.turn_lock_token = p_token;
  return found;
end;
$$;

-- Functions default to PUBLIC execute; see the guard-shape note above for why
-- this exact grant set is what makes the null-uid branch safe.
revoke execute on function claim_conversation_turn(uuid, uuid, integer) from public, anon;
grant execute on function claim_conversation_turn(uuid, uuid, integer) to authenticated, service_role;
revoke execute on function finish_conversation_turn(uuid, uuid, boolean) from public, anon;
grant execute on function finish_conversation_turn(uuid, uuid, boolean) to authenticated, service_role;
revoke execute on function renew_conversation_turn(uuid, uuid, integer) from public, anon;
grant execute on function renew_conversation_turn(uuid, uuid, integer) to authenticated, service_role;
