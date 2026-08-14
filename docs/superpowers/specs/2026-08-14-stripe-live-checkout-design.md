# Stripe checkout: sandbox → live (issue #85)

**Date:** 2026-08-14
**Issue:** https://github.com/fedeostan/capo-v1/issues/85
**Branch:** `claude/github-issue-85-cfd96e`

---

## 1. The problem, stated exactly

Production (`https://capo-v1.vercel.app`) is running against a Stripe **sandbox**,
not against the live account. This was confirmed from Stripe's own side rather
than inferred from the app: the sandbox account `acct_1TtrEZLaGmAMnE9x`
("Moussemango sandbox") holds a webhook endpoint
(`we_1TuAmhLaGmAMnE9xaKoeAC2P`) whose URL is the **production**
`https://capo-v1.vercel.app/api/stripe/webhook`. A sandbox webhook can only be
reached by sandbox keys, so production is holding `sk_test_…`.

State of the live account `acct_1TtrERLIxn6Jugmn` ("Moussemango"):

| Object | Live mode | Consequence if left as-is |
| --- | --- | --- |
| Product "Capo" + €45/month EUR recurring price `price_1U4J91LIxn6JugmnvZc5XN12` | present | — |
| Webhook endpoint | **absent** | `checkout.session.completed` never arrives. A paying company stays `subscription_status='trialing'`, and `getBillingState` blocks it the moment `trial_ends_at` passes — a paying customer locked out. |
| Billing portal configuration | **absent** | `stripe.billingPortal.sessions.create` throws in live mode until a configuration exists. "Gerir subscrição" errors. |

The lockout is total rather than partial because migration `0011` revoked
tenant `UPDATE` on `companies` and re-granted only `(name)`. The service-role
webhook is the **only** writer of `subscription_status`. No webhook, no door.

**Blast radius of the cutover: zero.** Every row in `companies` on the live
Supabase project has `stripe_customer_id IS NULL` and
`stripe_subscription_id IS NULL` (verified 2026-08-14, 6 rows). No subscriber is
stranded by moving worlds. The two real companies are `active` (force-set by
`0011`) and are never gated either way.

---

## 2. Decisions taken (Federico, 2026-08-14)

| Decision | Choice | Consequence |
| --- | --- | --- |
| VAT / IVA in Stripe | **None.** Stripe charges exactly €45, collects no NIF, computes no tax. Invoicing handled outside Stripe. | No Stripe Tax registration, no `tax_id_collection`, no `billing_address_collection`. The live price keeps `tax_behavior: "unspecified"`, which is immutable once used — a future IVA-bearing price must be a **new** price, leaving existing subscribers untouched. |
| Early subscriber during trial | **Keep their remaining free days.** | `subscription_data.trial_end` is passed at checkout. Requires §4.1. |
| Who configures live Stripe | **Claude, via the Stripe API.** | §3. The webhook signing secret is *not* printed into the session transcript; Federico reads it from the Dashboard. |
| Cancellation timing | **At period end.** | Portal configured with `cancellation_reason` off and `mode: 'at_period_end'`. Stripe fires `customer.subscription.deleted` on its own when the paid period expires; no code change. |
| Scope | A + B + C1 + C2 + C3 (all of it). | §3, §4. |

---

## 3. Stripe-side configuration (live account `acct_1TtrERLIxn6Jugmn`)

### 3.1 Webhook endpoint

- **URL:** `https://capo-v1.vercel.app/api/stripe/webhook`
- **Events, exactly three** — matching the `switch` in
  `apps/web/app/api/stripe/webhook/route.ts` and nothing else:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
- **Description:** `Capo billing — checkout + subscription status sync (live)`
- **API version:** account default (do not pin). The installed SDK is
  `stripe@18.5.0`; pinning an endpoint to a version the SDK does not expect is a
  silent payload-shape mismatch.

Vercel Deployment Protection does **not** block this: it is browser-session
based, and Stripe→server delivery is server-to-server.

### 3.2 Billing portal configuration

- `subscription_cancel`: enabled, `mode: 'at_period_end'`, `proration_behavior: 'none'`
- `payment_method_update`: enabled
- `invoice_history`: enabled
- `customer_update`: enabled for `email` and `address`
- `subscription_update`: **disabled** — there is one plan
- `business_profile.privacy_policy_url` / `terms_of_service_url`: **omitted.**
  Neither page exists in `apps/web/app/(public)` (checked 2026-08-14) and Stripe
  does not require them for a portal configuration. Pointing them at a 404 is
  worse than leaving them unset. Adding those pages later is a follow-up, not
  part of this change.

### 3.3 Sandbox cleanup

Disable (do not delete) `we_1TuAmhLaGmAMnE9xaKoeAC2P` in the sandbox. It aims at
the production URL and will never fire again once production holds live keys;
leaving it enabled is a future misdiagnosis waiting to happen. Disabling rather
than deleting keeps its delivery history readable.

---

## 4. Code changes

Two files. No migration. No change to `packages/db/src/types.ts`.

### 4.1 `apps/web/app/(app)/subscricao/actions.ts` — `startCheckout`

**C1 — pass the remaining trial.** Read `companies.trial_ends_at` alongside the
existing auth read and pass it as `subscription_data.trial_end` (Unix seconds).

Hard constraint, verified against the type documentation shipped in
`stripe@18.5.0` (`types/Checkout/SessionsResource.d.ts`), not from memory:

> `trial_end` — *"Unix timestamp representing the end of the trial period the
> customer will get before being charged for the first time. **Has to be at least
> 48 hours in the future.**"*

Below 48 hours Stripe rejects the whole checkout session — the manager taps
**Assinar** and gets an error instead of a payment page. A pure helper decides
what to do in that window:

```
resolveTrialEnd(trialEndsAt: string | null, now: Date): number | undefined
```

Returns a Unix-seconds timestamp to pass to Stripe, or `undefined` to mean "no
trial, charge immediately". Pure and side-effect free so it is testable without
credentials. `trialEndsAt` is typed nullable even though the column is `not null`,
because the caller reads the row with `maybeSingle()` and a missing row must not
throw on a checkout — `null` returns `undefined` (charge immediately), and that
branch is mechanical, not a decision. **The 48-hour rule inside it is Federico's
to write** — the trade-off is
between charging a manager who had one day left (correct to the euro, feels
mean) and extending them to the 48-hour floor (loses you at most one day, never
errors). Both are defensible; it is a product call, not a mechanic.

**C3 — reuse the Stripe customer.** If `companies.stripe_customer_id` is already
set, pass `customer: <id>` and omit `customer_email`. Otherwise pass
`customer_email` as today. Stripe rejects both together. Without this, a manager
who cancels and later re-subscribes gets a second Stripe customer; the webhook
overwrites `companies.stripe_customer_id` with the new one, and every later event
for the *old* customer matches no row — silently, which is exactly what C2 exists
to surface.

**C3 — stamp the company id on the subscription.** Add
`subscription_data.metadata: { company_id: companyId }`. `client_reference_id`
only rides the Checkout Session; it is absent from every
`customer.subscription.*` event. Metadata on the subscription gives those events
an identity that does not depend on the customer-id link having been written.

### 4.2 `apps/web/app/api/stripe/webhook/route.ts`

**C2 — make a zero-row update loud.** Both `.update()` calls today are checked
for `error` only. A Supabase update whose filter matches nothing is **not an
error**; it is a fully successful statement that touched no rows, and the current
code logs `billing.subscription_updated` as though it had worked.

Append `.select('id')` to both updates and branch on the returned array being
empty:

- `checkout.session.completed` with an unknown `client_reference_id` →
  `logEvent('billing.company_not_found', { companyId })`
- `customer.subscription.*` with an unmatched `stripe_customer_id` →
  attempt the C3 metadata fallback (below); if that also matches nothing,
  `logEvent('billing.subscription_orphan', { customerId, subscriptionId })`

This is the same posture `AGENTS.md` records for `loadCompanySnapshot`,
`recordThreadEvent` and `recordUsage`: the failure is swallowed, but it leaves a
greppable event so "billing quietly stopped working" stays falsifiable.

**C3 — metadata fallback.** When the `stripe_customer_id` match returns zero
rows, retry the update keyed on `subscription.metadata.company_id`. This recovers
the case where `checkout.session.completed` was missed or failed, which is
precisely the state a fresh live webhook is most likely to be in during its first
hours.

**Not changed:** `mapStripeStatus`. Stripe's `trialing` already folds to Capo's
`active`, so a subscriber inside their carried-over trial is unblocked with no
new status logic. This was verified, not assumed.

---

## 5. Vercel environment (Federico only)

Vercel environment variables on this project are marked Sensitive and are
therefore write-only — `vercel env pull` returns the literal string
`[SENSITIVE]`. Claude cannot read or set them.

Project `capo-v1`, **Production** scope:

| Variable | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | the live `sk_live_…` secret key |
| `STRIPE_PRICE_ID` | `price_1U4J91LIxn6JugmnvZc5XN12` |
| `STRIPE_WEBHOOK_SECRET` | the `whsec_…` of the endpoint created in §3.1, copied from the Stripe Dashboard |

Then redeploy. All three are read lazily inside functions
(`getStripe()`, `startCheckout`, the webhook route), never at module scope, so a
missing value degrades rather than breaking `next build`.

**Precondition Federico must confirm:** the live Stripe account is *activated* —
business details submitted, bank account attached, no "complete your account"
banner in the Dashboard. Live API keys exist regardless of activation, so nothing
in this plan errors if it is incomplete; the refusal only appears when a real
card is entered.

### 5.1 Cutover order — strict, and the reason for each position

1. **Confirm the live account is activated.** Everything downstream is theatre
   if real cards are refused.
2. **Create the live webhook (§3.1) and portal configuration (§3.2).** Both are
   inert while production still holds sandbox keys — a live endpoint with no
   live traffic receives nothing. Creating them first means the doorbell already
   exists at the instant the keys change.
3. **Merge and deploy the code changes (§4).** Also inert: the new checkout
   arguments are valid in both worlds, so this can land before the key swap and
   be verified in the sandbox first.
4. **Swap the three Vercel variables and redeploy (§5).** This is the cutover
   instant. Before it, payments are sandbox; after it, live.
5. **Disable the sandbox webhook (§3.3).** Last, never earlier. Disabling it
   while production still holds sandbox keys opens a window in which a manager
   can pay and *nothing* records it — the exact failure this whole change exists
   to remove.

---

## 6. Verification

Ordered, and every step is falsifiable:

1. **Local, credential-free:** `pnpm turbo lint typecheck build` and
   `pnpm scheduler-check` (the CI merge gate). Note the Next 16 build lock —
   only one `next build` per workspace root, so serialise against other
   worktrees.
2. **Local, sandbox:** `stripe listen --forward-to localhost:3000/api/stripe/webhook`
   with the sandbox key in `.env.local`, then a real checkout through the app.
   Assert: `subscription_status` flips to `active`, both Stripe ids populate, and
   an early-trial checkout produces a Stripe subscription in state `trialing`
   with the expected `trial_end`. The Stripe CLI is already logged into the
   sandbox (`Moussemango sandbox`) — confirm with `stripe config --list` before
   running anything, so no `trigger` ever aims at live.
3. **Live, one real transaction:** after §5, one €45 checkout on a real card
   through `/subscricao`. Assert in Supabase that `subscription_status='active'`
   and `stripe_customer_id` is a `cus_…` from the **live** account, then cancel
   through the portal and assert the subscription shows `cancel_at_period_end`
   and Capo is still usable. Refund the €45 from the Dashboard afterwards.
4. **Negative check for C2:** in the sandbox, replay a
   `customer.subscription.updated` for a customer id no company holds
   (`stripe trigger` against a throwaway customer) and assert
   `billing.subscription_orphan` appears in the logs. Without this step C2 is
   untested code that only runs on the day something is already wrong.

There is no test suite in this repo; steps 2–4 are manual and none of them run in
CI. `resolveTrialEnd` is pure specifically so it *could* gain a check under
`scripts/` later — out of scope here.

---

## 7. Explicitly out of scope

- **Stripe Tax / IVA / NIF collection.** Decided against for now (§2). Revisiting
  means a new price object, not an edit to the existing one.
- **Promotion codes at checkout** (`allow_promotion_codes`). No discount exists.
- **Post-checkout reconciliation on the success page.** Tempting — it would close
  the few-second gap between the redirect back and the webhook landing — but it
  would introduce a *second* writer of billing state outside the webhook, against
  the boundary `0011` establishes. The carried-over trial (C1) also removes the
  urgency: an early subscriber is never blocked while the webhook catches up. The
  page's existing pull-to-refresh remains the answer.
- **Expiring stale `proposals`.** Unrelated known issue, recorded in `AGENTS.md`.
- **Custom production domain.** None is configured; `capo-v1.vercel.app` is the
  production domain. If one is added later, the webhook URL in §3.1 and
  `NEXT_PUBLIC_SITE_URL` both have to move, and the webhook must be updated
  *before* the domain cuts over or a payment window goes unrecorded.

---

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Live account not activated → real cards refused | Federico confirms in the Dashboard before §5 (stated in §5) |
| Env vars updated but not redeployed → production still on sandbox keys while the sandbox webhook is disabled → **payments recorded nowhere** | Strict cutover order, §5.1 step 5 last |
| A manager subscribes between the env swap and the webhook creation | Strict cutover order, §5.1 step 2 before step 4 — the live endpoint is inert until live keys are in place, so creating it early costs nothing |
| `trial_end` inside the 48-hour floor → checkout errors | `resolveTrialEnd` (§4.1), which is the whole reason that helper exists |
| Webhook secret mismatch → every delivery 400s | Step 3 of §6 is a real transaction; a mismatch shows immediately as `subscription_status` not flipping |
