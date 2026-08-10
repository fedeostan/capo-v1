-- WhatsApp business-scoped user IDs (BSUIDs) — Stage 1: somewhere to put them.
--
-- Every inbound WhatsApp message resolves to a tenant through ONE value: the
-- sender's phone. profiles.phone → company_id for a manager, workers.phone for
-- a worker replying to their 07:00 briefing. An unrecognised number is a
-- deliberate silent no-op (apps/web/app/api/whatsapp/route.ts).
--
-- Meta is taking that value away. WhatsApp usernames roll out through 2026, and
-- when a person adopts one Meta OMITS the `from` field entirely — that is the
-- whole point of the feature. In its place, since April 2026, every message
-- carries `from_user_id`: a business-scoped user ID, e.g. PT.13491208655302741918,
-- stable for a person across username changes and scoped to our business
-- portfolio. Meta requires every business on the platform to support it.
--
-- The window this migration exists to catch: once someone adopts a username,
-- Meta keeps showing their phone for 30 days after the last exchange, then
-- never again. Right now BOTH identifiers arrive on the same message, which is
-- the only period in which the new one can be bound to a person we already
-- know by the old one. Miss it and they arrive as a stranger with nothing in
-- the database able to say otherwise.
--
-- This migration adds STORAGE ONLY. Nothing resolves a sender by BSUID —
-- phone remains the sole resolution key, and resolving by BSUID is Stage 2
-- (issue #28). Applying this changes no behaviour whatsoever.

-- ── the columns ────────────────────────────────────────────────────────────
-- Note the asymmetry, which is inherited rather than invented.
--
-- profiles.phone is `not null unique` (0007:17); workers.phone carries only a
-- format check (0003:8), with no uniqueness at all, because two companies may
-- legitimately hold the same crew member — the webhook's own .limit(2)
-- ambiguity guard exists for exactly that case.
--
-- A BSUID is scoped to a business PORTFOLIO, and Capo is one portfolio across
-- every tenant. So a BSUID is exactly as tenant-ambiguous as a phone number:
-- no more, no less. Each new column therefore takes its own table's existing
-- uniqueness posture. Making workers.whatsapp_user_id unique would be a
-- stricter rule than the phone beside it and would reject a legitimate shared
-- crew member; dropping the unique on profiles would loosen the guarantee
-- Stage 2 will lean on.
--
-- Nullable on both, and it stays null until that person messages us — there is
-- no backfill available. Meta only reveals a BSUID on an inbound message.
--
-- The format check mirrors isBsuid() in packages/core/src/channels/whatsapp.ts
-- byte for byte: ISO-3166 alpha-2, a period, up to 128 alphanumerics. Two
-- enforcement points, one rule; scripts/whatsapp-check.mts asserts the TS half.
--
-- What the single-dot pattern deliberately REJECTS is a parent BSUID
-- (US.ENT.11815799212886844830). Meta issues those to multi-portfolio
-- businesses; we are a single portfolio and must never store one. A parent
-- BSUID stored here would look like an identity and resolve to the wrong human
-- the day Stage 2 starts reading this column, so it is refused at the boundary
-- rather than filtered later.
alter table profiles
  add column whatsapp_user_id text unique
    check (whatsapp_user_id is null or whatsapp_user_id ~ '^[A-Z]{2}\.[A-Za-z0-9]{1,128}$');

alter table workers
  add column whatsapp_user_id text
    check (whatsapp_user_id is null or whatsapp_user_id ~ '^[A-Z]{2}\.[A-Za-z0-9]{1,128}$');

-- Stage 2's lookup key. profiles gets its index free from `unique`; workers
-- has no uniqueness, so it needs one explicitly. Partial, because the column is
-- null for everyone who has not yet messaged us and those rows are never the
-- target of a lookup.
create index workers_whatsapp_user_id_idx on workers (whatsapp_user_id)
  where whatsapp_user_id is not null;

-- ── grants: read the asymmetry here too, it is NOT the same on both tables ──
-- profiles is column-grant protected. 0007:28 revoked the table-wide UPDATE and
-- 0014:43 re-granted an explicit list — `grant update (full_name, phone,
-- language) on table profiles to authenticated`. Column grants are not
-- additive: the granted set is exactly what is listed. whatsapp_user_id is
-- absent from that list ON PURPOSE and this migration does NOT extend it. The
-- omission is what makes the column service-role-write-only at the GRANT layer
-- — a structural guarantee that only the webhook can set it, which is stronger
-- than any policy because grants are checked before RLS is ever evaluated.
-- A future reader must not "fix" the omission.
--
-- workers has no such protection, and pretending otherwise would be worse than
-- saying it plainly: workers still carries Supabase's default table-wide UPDATE
-- grant to authenticated, plus workers_update_company (0007:70). A tenant can
-- therefore write ANY column on their own company's worker rows, this one
-- included. Granting the column narrowly would mean revoking the table-wide
-- grant and enumerating every existing column — a change to the grant surface
-- whose only verification gate is scripts/rls-isolation-matrix.mjs, which needs
-- credentials. That does not belong in a stage whose contract is "no behaviour
-- change".
--
-- Consequence, stated here so issue #28 inherits the caveat and not the
-- assumption: A TENANT CAN FORGE workers.whatsapp_user_id FOR THEIR OWN CREW.
-- Harmless today, because nothing reads the column. It is a hard gate on
-- Stage 2, which must never resolve a worker by BSUID without also scoping the
-- lookup by company — the same discipline the phone path already applies.
-- profiles.whatsapp_user_id being unique AND service-role-write-only is the
-- guarantee that actually holds globally, and is the one Stage 2 should build
-- resolution on.

-- ── RLS: nothing to add ────────────────────────────────────────────────────
-- Deliberately no new policies. A column is covered by whatever policies its
-- table already has, and both tables already have the right ones:
-- profiles_select_own (0007:45) lets a manager read their own row, and
-- workers_select_company (0007, generated in the per-company loop) lets a
-- tenant read their own crew. Neither table gains a row, a relation or a
-- reachable surface here, so the tenant boundary is unchanged.
