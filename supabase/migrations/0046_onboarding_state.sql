-- 0046 — onboarding becomes a STATE the company carries, not a guess from counts
--
-- ── WHAT WENT WRONG ────────────────────────────────────────────────────────
-- Capo greeted a brand new manager, asked for the client name, created the
-- obra, said "done", and the onboarding ended there. Nothing was broken: the
-- onboarding instructions were DERIVED from row counts every turn
-- (packages/core/src/agent/context.ts, buildOnboardingBlock), and the derivation
-- switched itself off as soon as one job and one worker existed. There was no
-- "no tasks yet" gap at all, nothing ever asked what the business actually
-- does, and no step told the manager the dashboard exists.
--
-- ── WHY A COLUMN AND NOT BETTER COUNTING ───────────────────────────────────
-- Counts cannot answer the question. "Is this manager still being set up?" is
-- not the same question as "does this company have rows?", and the two come
-- apart in both directions:
--   - A live tenant deletes its last active obra between jobs. Counting would
--     restart the onboarding conversation for a business that has used Capo
--     for a year.
--   - A half-onboarded manager creates one obra and one worker and stops.
--     Counting called that finished, which is exactly the bug.
-- `onboarded_at` records a DECISION that was made once (the checklist was
-- complete and Capo said so), and a decision is not recoverable from the
-- current shape of the data. NULL means "still being onboarded".
--
-- ── THE BACKFILL IS MANDATORY ──────────────────────────────────────────────
-- Same class as 0026's pushed_at and 0033's welcome ledger: a marker column
-- added to a populated table replays history on its first deploy unless it is
-- stamped. Here the replay is not a mass mailing but it is nearly as bad — every
-- existing customer would be told, in their next message, that Capo is about to
-- set up their company from scratch. Anything with at least one job AND at least
-- one worker is a live tenant and is stamped now(). Anything less is genuinely
-- unfinished and stays NULL, which is the right answer for it.

alter table companies
  add column onboarded_at timestamptz,
  add column about text check (about is null or char_length(about) <= 600);

comment on column companies.onboarded_at is
  'When the initial setup conversation was declared complete (finish_onboarding). NULL = still being onboarded, and the agent keeps driving the checklist. Never derived from row counts: a live tenant with no active obra this week is not being re-onboarded.';

comment on column companies.about is
  'What this company does, in the manager''s own words, gathered in conversation during onboarding. Free text, at most 600 characters. Not a category and not a taxonomy: it exists so Capo knows what kind of work the crew is being asked about.';

-- Live tenants: already using the product, never to be re-onboarded.
update companies c
set onboarded_at = now()
where exists (select 1 from jobs j where j.company_id = c.id)
  and exists (select 1 from workers w where w.company_id = c.id);

-- ── grants ─────────────────────────────────────────────────────────────────
-- 0011 revoked the table-wide UPDATE this table carried from 0001 and re-granted
-- `(name)` alone, precisely so `subscription_status` could have exactly one
-- writer: the Stripe webhook. That stays true. This widens the tenant's column
-- list by the two columns the onboarding conversation writes and by nothing
-- else — the billing columns, `language` and `id` remain unreachable from a
-- tenant's own client.
--
-- `onboarded_at` is in the list because `finish_onboarding` runs on the tenant's
-- own RLS-scoped client on the web path, exactly as `remember` does. What a
-- tenant can therefore do is declare their OWN company set up early, which
-- costs them a checklist and nobody else anything. The tool re-reads the counts
-- before stamping, so that is a deliberate act rather than an accident.
--
-- The existing RLS policies on `companies` (0007) already scope every command
-- to the caller's own company row, so no policy change is needed or wanted.
revoke update on table companies from authenticated;
grant update (name, about, onboarded_at) on table companies to authenticated;
