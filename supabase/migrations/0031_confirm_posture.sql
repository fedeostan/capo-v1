-- 0031 — the confirmation posture (issues #57, #64)
--
-- WHAT THE MANAGER SEES
-- Until now, when Capo could quote the manager's own words back verbatim it
-- carried the write out immediately. "Assign the plastering to Zé" → done, no
-- card, no tap. That is fast and it is also the complaint in #57: a change
-- landed on the real board before the manager had a chance to say "yes, that
-- one".
--
-- This column is the dial that decides which of those two worlds a given
-- manager lives in. It is PER PROFILE, not per company, for the same reason
-- Claude Code's permission mode is per person and not per repository: it is a
-- working style, not a company policy. Two managers in the same tenant may
-- legitimately want different answers.
--
--   always_ask  — every mutating instruction produces an approval card first.
--                 Safer; costs a tap per change.
--   trust_quote — the behaviour that shipped before this migration: act
--                 immediately when the guard can match the model's quote
--                 against what the manager actually typed.
--
-- ── the default is the safe one, and it is NOT NULL ─────────────────────────
-- `not null default 'always_ask'` means every existing row and every future row
-- gets the cautious posture with no backfill statement and no window in which a
-- null has to be interpreted. A nullable column would have forced every reader
-- to decide what null means, and the failure mode of getting that wrong is a
-- silent unconfirmed write — precisely what #57 is about.
--
-- The CHECK is here rather than only in TypeScript because the WhatsApp path
-- runs on the service role, where RLS and app-level validation are both absent.
alter table profiles
  add column confirm_posture text not null default 'always_ask'
    check (confirm_posture in ('always_ask', 'trust_quote'));

-- ── the grant, and why every other column has to be re-listed ───────────────
-- COLUMN GRANTS ARE NOT ADDITIVE. `grant update (confirm_posture)` would
-- REPLACE the allowed set rather than extend it, silently removing write access
-- to full_name, phone, language and the two consent timestamps — i.e. breaking
-- the whole /perfil form and the `set_language` tool with no error anywhere at
-- deploy time.
--
-- The five columns below are copied verbatim from 0025_whatsapp_optin.sql:87,
-- which is the last statement to have re-granted UPDATE on this table. Nothing
-- between 0026 and 0030 touches profiles' grants (0028 explains at length why
-- it deliberately does not), so that list is still the live one.
--
-- profiles_update_own already scopes every write to id = auth.uid(), so there
-- is no one else's posture to move: a manager can only ever loosen or tighten
-- their OWN confirmation setting.
revoke update on table profiles from authenticated;
grant update (full_name, phone, language, whatsapp_opt_in_at, whatsapp_opt_out_at, confirm_posture)
  on table profiles to authenticated;

-- ── deliberately NOT done here ──────────────────────────────────────────────
-- No INSERT policy and no INSERT grant change. `profiles` has no INSERT policy
-- at all, and under RLS an INSERT with no permissive policy is refused outright
-- — rows come from complete_onboarding(), which is SECURITY DEFINER and
-- therefore picks the column default. See 0028:84-93: that absence is
-- load-bearing and invisible, and adding a policy here to "make onboarding set
-- the posture" would reopen the stale INSERT grant it protects.
--
-- No cleanup of stale `proposals`. Defaulting every manager to always_ask means
-- pending approval cards will accumulate faster than before, and nothing in
-- this schema expires them (the 'expired' status in 0001 exists but is never
-- written). That is a known, reported risk, not something to fix silently in a
-- migration about a settings column.
comment on column profiles.confirm_posture is
  'Per-manager confirmation posture for mutating agent tools. always_ask (default): every write becomes an approval card. trust_quote: the guard may execute directly when it can match the model''s manager_instruction against the manager''s own recent words. Enforced in packages/core/src/capabilities/guard.ts.';
