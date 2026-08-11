-- WhatsApp opt-in: the consent record that replaces Meta's test-tier allow-list.
--
-- Until now the gate on "may Capo message this person?" was Meta's free-tier
-- allow-list: five numbers, each of which had to confirm an opt-in code on their
-- own handset before a single message could reach them. That was never designed
-- as a consent mechanism, but it functioned as one, and docs/human-todo.md
-- recorded the debt out loud: "no consent column was added — Meta's 5-number
-- allow-list is the gate in test mode, but a real opt-in record is required
-- before production under Meta's business-messaging policy."
--
-- The business is now verified and the production number has no allow-list, so
-- that gate is gone and this table has to hold the line instead. Meta's
-- business-messaging policy requires a recorded opt-in before any proactive
-- template send, and requires opt-outs to be honoured.
--
-- Per AGENTS.md, this is enforced STRUCTURALLY and in exactly one place —
-- loadCompanyBriefing() in apps/web/app/notifications/briefing.ts, which both
-- the 07:00 briefing and the late-afternoon check-in read. Not in a prompt, and
-- not duplicated per route.

-- ── the two timestamps ─────────────────────────────────────────────────────
-- Timestamps rather than a boolean, and BOTH kept, because the question this
-- has to answer under scrutiny is "when did this person consent, and had they
-- withdrawn it by the time you messaged them?". A boolean answers neither.
--
-- Nullable with no default. A null opt_in_at means "no consent on record",
-- which is the only safe reading of an absent value — a DEFAULT now() would
-- manufacture consent for every existing row, which is precisely the thing the
-- requirement exists to prevent. Existing rows are deliberately NOT backfilled;
-- see the note at the end of this file.
--
-- LATEST WINS. Effective state is:
--   opted in  ⟺  opt_in_at is not null
--                and (opt_out_at is null or opt_out_at < opt_in_at)
-- Nothing is ever cleared, matching the schema's no-DELETE posture everywhere
-- else: a withdrawal MARKS, and the pair of timestamps stays readable as the
-- audit trail of who asked for what and when.
alter table workers
  add column whatsapp_opt_in_at timestamptz,
  add column whatsapp_opt_out_at timestamptz;

alter table profiles
  add column whatsapp_opt_in_at timestamptz,
  add column whatsapp_opt_out_at timestamptz;

-- ── column grants ──────────────────────────────────────────────────────────
-- Column grants are NOT additive: each grant REPLACES the allowed set, so every
-- previously-granted column must be re-listed or it silently loses write access
-- (0014). workers has never had a column grant at all — it has carried
-- Supabase's default table-wide GRANT ALL since 0001 — so this is the first one,
-- and every column a manager legitimately edits must appear.
--   workers:  name, trade, phone, active (0001) + language (0016) + both
--   profiles: full_name, phone (0007) + language (0014)           + both
--
-- BOTH consent columns are granted, and it is worth being explicit about why,
-- because the tempting design is to withhold whatsapp_opt_out_at so a tenant
-- "cannot forge a withdrawal it was not given".
--
-- That protection is illusory here. A manager must be able to write
-- whatsapp_opt_in_at — they are the attesting party, and there is no other way
-- to record the consent they collected on site (Meta expects exactly this: a
-- business gathers opt-in through its own channels and attests it). But under
-- LATEST WINS, a fresh opt_in_at already supersedes any opt_out_at. So
-- withholding the opt-out column would not stop a tenant from re-enabling
-- someone; it would only stop a manager from recording "o Zé pediu para não
-- receber mais", which is a thing a manager legitimately does.
--
-- What actually keeps this honest is not the grant. It is that both timestamps
-- survive — the sequence is always reconstructable — and that add_worker and
-- update_worker are GUARDED tools, so recording consent on someone else's
-- behalf requires the manager's verbatim instruction rather than a model
-- inference from context.
--
-- workers.company_id does drop out of the writable set here. The existing
-- workers_update_company policy already has a WITH CHECK on it, so this changes
-- no behaviour; it just states the same rule at the layer 0007 and 0014 state
-- it at ("a tenant may not move itself, or its crew, between tenants").
revoke update on table workers from anon, authenticated;
grant update (name, trade, phone, active, language, whatsapp_opt_in_at, whatsapp_opt_out_at)
  on table workers to authenticated;

-- profiles gets BOTH columns, and that asymmetry with workers is the point: the
-- manager is their own subject here. Unticking the box on /perfil is a person
-- withdrawing their own consent, and profiles_update_own already scopes every
-- write to id = auth.uid(), so there is no one else's record to forge.
revoke update on table profiles from authenticated;
grant update (full_name, phone, language, whatsapp_opt_in_at, whatsapp_opt_out_at)
  on table profiles to authenticated;

-- ── on re-consent, which is a judgement call and not a technical one ────────
-- A manager CAN write workers.whatsapp_opt_in_at, so a manager can in principle
-- supersede a worker's STOP by re-attesting consent. That is deliberate: on a
-- six-person crew the real-world flow for "put Zé back on the briefings" runs
-- through the manager, not through a self-service portal the crew does not have.
--
-- Two things keep it honest. Both timestamps survive, so the sequence
-- (opted out Tuesday, re-attested Wednesday) is always reconstructable. And
-- update_worker is a GUARDED tool, so re-enabling someone requires the manager's
-- verbatim instruction quoted back — the model cannot drift into it.

-- ── no backfill, on purpose ────────────────────────────────────────────────
-- Every existing worker and profile starts with a null opt_in_at, so all
-- proactive sends stop until consent is actually recorded. That is the correct
-- behaviour and the entire reason the requirement exists: writing a consent
-- record nobody gave would be a lie told in SQL.
--
-- Once the crew has genuinely been asked, one statement turns them back on:
--   update workers set whatsapp_opt_in_at = now()
--    where company_id = '…' and active and phone is not null;
