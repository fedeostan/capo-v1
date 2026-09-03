-- The throttle behind Capo's own account emails (W1).
--
-- Until this migration, signup confirmation and password reset went out through
-- Supabase's built-in mailer, and GoTrue's own rate limits were the only thing
-- standing between a bored visitor and a mailbox full of Capo. Sending moved
-- into the app (apps/web/lib/auth-email.ts, Resend's HTTP API), and it took
-- those limits with it: /registar and /recuperar are unauthenticated forms that
-- take an arbitrary email address and cause a message to be delivered to it.
-- That is a mail-bombing primitive pointed at a stranger and a reputation
-- problem pointed at our own sending domain, so the limit has to come back
-- somewhere. This table is where.
--
-- ── WHAT A ROW MEANS ───────────────────────────────────────────────────────
-- One row per account email we ACTUALLY handed to Resend. Written after the
-- send succeeds, never before: a row written first would mean a Resend outage
-- spent somebody's allowance on messages that never arrived, and the person
-- who cannot get into their account is exactly the person who will try again.
--
-- ── WHY IT KEYS ON THE ADDRESS AND NOT ON A USER ───────────────────────────
-- Two of the three kinds are reachable for an address with no account at all
-- (a signup for a brand new email; a recovery for one that was never
-- registered). There is no user id to key on at the moment the decision is
-- taken, and inventing one would mean creating the user BEFORE deciding
-- whether to send, which is the wrong order. `email_lower` is the address the
-- action already lowercased.
--
-- ── WHY IT IS NOT `notification_log` ───────────────────────────────────────
-- Same instinct, deliberately not the same table. notification_log (0016) is
-- the PAID WhatsApp template ledger, and its unique key is what prevents a
-- double-billed send to a crew member; it is keyed on company, worker and day,
-- and every one of those is unknown here. An account email is sent to somebody
-- who may not belong to any company yet. Widening that key to accommodate a
-- second, unrelated product would put the double-send protection for the crew
-- channel at risk to save one small table.
--
-- ── NO COMPANY, SO NO TENANT SWEEP ─────────────────────────────────────────
-- Note for whoever next opens scripts/rls-isolation-matrix.mjs: this table
-- carries no company_id, so the per-tenant visibility sweep (which enumerates
-- relations by that column) does not reach it and correctly should not. Its
-- whole boundary is the deny-all posture below.
create table auth_email_sends (
  id uuid primary key default gen_random_uuid(),
  -- Lowercased by the caller before it gets here, matching what the signup and
  -- recovery actions already do to the submitted address.
  email_lower text not null,
  -- Which of the three doors this went out of. Kept for the log and for
  -- reading the table by hand after an incident; the throttle itself counts
  -- ALL kinds for an address together, on purpose. A limit that could be spent
  -- three times over by alternating doors is not a limit.
  kind text not null check (kind in ('confirm', 'resend', 'recovery')),
  sent_at timestamptz not null default now()
);

-- The only query this table has: "how many went to this address in the last
-- hour". Descending on sent_at so the count reads the head of the index.
create index auth_email_sends_email_sent_idx
  on auth_email_sends (email_lower, sent_at desc);

-- ── RLS ────────────────────────────────────────────────────────────────────
-- notification_log's posture (0016) and checkin_photo_requests' (0034): RLS on,
-- deliberately ZERO policies, every grant revoked. Deny-all for anon and for
-- authenticated, in that order of importance: the actor who reaches the two
-- forms that write here is ANONYMOUS by definition.
--
-- A reader of this table holds a list of the addresses that have tried to sign
-- up or recover a password, which is an account-enumeration oracle for exactly
-- the flows whose app-level copy is carefully written not to be one. A writer
-- of it could spend a victim's hourly allowance in advance and lock them out of
-- their own password reset. Neither is tenant data; there is no tenant.
--
-- The service role bypasses all of this, and is the only writer.
alter table auth_email_sends enable row level security;

revoke all on table auth_email_sends from anon, authenticated;

comment on table auth_email_sends is
  'Throttle ledger for account emails sent by the app through Resend (W1). One row per successful send. Service-role only: RLS on, zero policies, no grants.';
