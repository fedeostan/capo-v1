-- Stripe billing: trial/subscription state on companies, env-gated at the
-- app layer (billing.ts) — these columns exist and default to 'trialing'
-- regardless of whether Stripe keys are configured. The live pilot company
-- is force-set to 'active' so it is never gated by this upgrade.
--
-- Column-level guard, same pattern as profiles in 0007: authenticated
-- currently holds full table-level UPDATE on companies (verified before
-- writing this migration — 0007 restricted profiles by column but left
-- companies unrestricted). Tenants may rename their company; they may never
-- touch billing state directly — only the Stripe webhook (service-role) can.
alter table companies
  add column stripe_customer_id text unique,
  add column stripe_subscription_id text,
  add column subscription_status text not null default 'trialing'
    check (subscription_status in ('trialing','active','past_due','canceled')),
  add column trial_ends_at timestamptz not null default (now() + interval '14 days');
update companies set subscription_status = 'active';
revoke update on table companies from authenticated;
grant update (name) on table companies to authenticated;
