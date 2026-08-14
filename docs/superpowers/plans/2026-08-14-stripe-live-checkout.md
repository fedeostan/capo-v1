# Stripe live checkout — code changes (issue #85) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry a company's remaining free-trial days into the Stripe subscription it creates, and turn the billing webhook's silent zero-row updates into logged, recoverable events.

**Architecture:** Two files change and two are created. The 48-hour trial rule is extracted into a pure, credential-free function in its own file (it *cannot* live in `actions.ts` — see Task 1) and asserted by a new `scripts/billing-check.mts` in the same shape as `push-check`/`guard-check`. The webhook keeps its existing structure and gains `.select('id')` on both updates so a filter that matched nothing becomes visible, plus a metadata-keyed recovery path.

**Tech Stack:** Next.js 16 App Router, `stripe@18.5.0`, `@supabase/supabase-js` via `@capo/db`, `tsx` for the check scripts.

**Spec:** `docs/superpowers/specs/2026-08-14-stripe-live-checkout-design.md` (§4 is the authority; this plan implements it).

## Global Constraints

- Server-only env vars (`STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`) are read **lazily inside functions**, never at module scope. Moving one to module scope breaks `next build` in CI.
- No migration. No change to `packages/db/src/types.ts`. No new table, column, grant or policy.
- `mapStripeStatus` is **not** modified. Stripe's `trialing` already maps to Capo's `active`.
- The merge gate is `pnpm turbo lint typecheck build` plus, per PR, `pnpm scheduler-check`, `pnpm guard-check`, `pnpm whatsapp-check`, `pnpm push-check`, `pnpm cache-check`, `pnpm cost-check`. This plan adds `pnpm billing-check` to that list.
- Next 16 holds a build lock per workspace root — only one `next build` at a time. Serialise against other worktrees, and never `tail` a turbo failure.
- `stripe@18.5.0`: `subscription_data.trial_end` **must be at least 48 hours in the future** or the whole Checkout Session is rejected. Source: `node_modules/.pnpm/stripe@18.5.0_*/node_modules/stripe/types/Checkout/SessionsResource.d.ts`.
- All new log event names use the existing `billing.` prefix and go through `logEvent` from `@/lib/log`.

---

### Task 1: The pure trial rule and its check

**Files:**
- Create: `apps/web/lib/billing-trial.ts`
- Create: `scripts/billing-check.mts`
- Modify: `package.json` (root, `scripts` block)
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `STRIPE_MIN_TRIAL_SECONDS: number` — `172800`
  - `resolveTrialEnd(trialEndsAt: string | null, now: Date): number | undefined` — Unix **seconds** to hand to Stripe as `subscription_data.trial_end`, or `undefined` meaning "send no trial, charge immediately". Task 2 consumes both.

**Why this cannot live in `actions.ts`:** that file's first line is `'use server'`. In the App Router, **every export from a `'use server'` file must be an async function**, because each one is compiled into a callable HTTP endpoint. Exporting a synchronous helper there is a build error, and exporting an async one would publish the trial rule as a public endpoint. A separate module is required, not merely tidier.

- [ ] **Step 1: Create the module with everything except the rule**

Create `apps/web/lib/billing-trial.ts`:

```ts
// The 14-day trial lives in Capo's own database (companies.trial_ends_at), not
// in Stripe. When a manager subscribes early we hand the remaining days to
// Stripe as subscription_data.trial_end so they are not charged for days they
// were already given.
//
// Pure and dependency-free on purpose: no Db, no Stripe client, no Date.now().
// `now` is a parameter so scripts/billing-check.mts can assert every branch
// without credentials, a network, or a clock.
//
// It cannot live in subscricao/actions.ts: that file is 'use server', where
// every export must be an async function compiled into an HTTP endpoint.

/** Stripe rejects a Checkout Session whose trial_end is nearer than this. */
export const STRIPE_MIN_TRIAL_SECONDS = 48 * 60 * 60;

export function resolveTrialEnd(trialEndsAt: string | null, now: Date): number | undefined {
  // No company row (the caller uses maybeSingle) — nothing to carry over.
  if (!trialEndsAt) return undefined;

  const endsAtMs = Date.parse(trialEndsAt);
  // An unparseable timestamp must not break a checkout. Fail to "charge now",
  // which is the outcome that existed before this function did.
  if (Number.isNaN(endsAtMs)) return undefined;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const endsAtSeconds = Math.floor(endsAtMs / 1000);
  const secondsLeft = endsAtSeconds - nowSeconds;

  // ── FEDERICO WRITES THIS ────────────────────────────────────────────────
  // Return one of:
  //   undefined                              → no trial, charge €45 today
  //   endsAtSeconds                          → charge when their trial ends
  //   nowSeconds + STRIPE_MIN_TRIAL_SECONDS  → charge in exactly 48 hours
  //
  // Constraint: any number returned MUST be >= nowSeconds + STRIPE_MIN_TRIAL_SECONDS
  // or Stripe rejects the whole checkout and the manager sees an error.
  throw new Error('resolveTrialEnd: rule not implemented');
  // ────────────────────────────────────────────────────────────────────────
}
```

- [ ] **Step 2: Create the check script with the rule-independent assertions**

Create `scripts/billing-check.mts`:

```ts
// Billing check — the deterministic half of issue #85. Needs NO credentials,
// no network and no Stripe account, so it runs in CI on every PR. Sibling of
// push-check.mts and guard-check.mts.
//
// It guards one specific bug, which is silent until a real manager hits it:
// a trial_end nearer than 48 hours makes Stripe reject the entire Checkout
// Session, so the manager taps Assinar and gets an error instead of a payment
// page. See stripe@18.5.0 types/Checkout/SessionsResource.d.ts.
//
// Run with `pnpm billing-check`. Exit 0 = green, 1 = at least one failure.

import { resolveTrialEnd, STRIPE_MIN_TRIAL_SECONDS } from '../apps/web/lib/billing-trial.ts';

let failures = 0;
const lines: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `got ${String(actual)}, want ${String(expected)}`);
}

// A fixed clock. Never Date.now() — a check that depends on when it runs is
// not a check.
const NOW = new Date('2026-08-14T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function isoIn(seconds: number): string {
  return new Date(NOW.getTime() + seconds * 1000).toISOString();
}

// ── constants ──────────────────────────────────────────────────────────────
eq('the Stripe floor is 48 hours', STRIPE_MIN_TRIAL_SECONDS, 172800);

// ── rule-independent branches ──────────────────────────────────────────────
eq('no company row carries no trial', resolveTrialEnd(null, NOW), undefined);
eq('an unparseable timestamp carries no trial', resolveTrialEnd('not-a-date', NOW), undefined);

const twelveDays = isoIn(12 * 24 * 60 * 60);
eq(
  'twelve days left is passed through untouched',
  resolveTrialEnd(twelveDays, NOW),
  Math.floor(Date.parse(twelveDays) / 1000),
);

// ── the invariant that matters most ────────────────────────────────────────
// Whatever rule is chosen, nothing may ever be returned inside Stripe's floor.
// This holds for every rule and is the assertion that would have caught the
// bug this function exists to prevent.
for (const hoursLeft of [-72, -1, 0, 1, 24, 47, 47.9, 48, 48.1, 72, 336]) {
  const at = isoIn(Math.round(hoursLeft * 60 * 60));
  const result = resolveTrialEnd(at, NOW);
  check(
    `${hoursLeft}h left never returns a trial_end inside Stripe's floor`,
    result === undefined || result >= NOW_SECONDS + STRIPE_MIN_TRIAL_SECONDS,
    `got ${String(result)}`,
  );
}

console.log(lines.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: Wire the script up**

In root `package.json`, add to `scripts`, directly after `"cost-check"`:

```json
"billing-check": "tsx scripts/billing-check.mts",
```

In `.github/workflows/ci.yml`, add after the `Push check` step (or after the last `*-check` step present):

```yaml
      # The trial hand-off to Stripe (issue #85). Pure, credential-free, and the
      # bug it guards is invisible until a real manager subscribes in the last
      # two days of their trial: Stripe rejects a Checkout Session whose
      # trial_end is nearer than 48 hours, so they get an error, not a payment
      # page.
      - name: Billing check
        run: pnpm billing-check
```

- [ ] **Step 4: Run it and watch it fail for the right reason**

```bash
pnpm billing-check
```

Expected: it throws `resolveTrialEnd: rule not implemented`. That is the correct failure — the scaffolding is proven to run and reach the unwritten rule.

- [ ] **Step 5: STOP — Federico writes the rule**

Replace the `FEDERICO WRITES THIS` block. Do **not** write it for him; ask, and wait. The three candidate rules and their trade-offs are in the handoff note at the bottom of this plan.

- [ ] **Step 6: Add the rule-dependent assertions**

Once the rule exists, add assertions pinning its *specific* answers — the two boundary cases the loop above only bounds. Write them to match the rule as chosen, for example:

```ts
// ── the chosen rule, pinned ────────────────────────────────────────────────
eq('an expired trial charges today', resolveTrialEnd(isoIn(-3600), NOW), undefined);
eq(
  'one day left is lifted to the 48h floor rather than erroring',
  resolveTrialEnd(isoIn(24 * 60 * 60), NOW),
  NOW_SECONDS + STRIPE_MIN_TRIAL_SECONDS,
);
```

If Federico chooses "charge immediately below the floor" instead, the second becomes `undefined`. Pin whichever he chose — the point is that the rule is now recorded in a file that CI runs, not only in a conversation.

- [ ] **Step 7: Run the check and verify it passes**

```bash
pnpm billing-check
```

Expected: `ALL PASS`, exit 0.

- [ ] **Step 8: Typecheck and lint**

```bash
pnpm turbo lint typecheck --filter=@capo/web
```

Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/billing-trial.ts scripts/billing-check.mts package.json .github/workflows/ci.yml
git commit -m "feat(billing): carry the remaining trial into Stripe, behind the 48h floor (#85)"
```

---

### Task 2: Hand the trial, the customer and the company id to Checkout

**Files:**
- Modify: `apps/web/app/(app)/subscricao/actions.ts:9-29` (`startCheckout`)

**Interfaces:**
- Consumes: `resolveTrialEnd` from Task 1.
- Produces: Checkout Sessions carrying `subscription_data.metadata.company_id`, which Task 3's fallback reads.

- [ ] **Step 1: Replace the body of `startCheckout`**

```ts
export async function startCheckout(): Promise<void> {
  const { db, companyId, locale } = await requireAuth();
  const priceId = process.env.STRIPE_PRICE_ID;
  // Config error, not a user error — stays English, nobody should ever see it.
  if (!priceId) throw new Error('STRIPE_PRICE_ID not set');

  const { data: claims } = await db.auth.getClaims();
  const email = claims?.claims?.email;

  // One read for both: the trial we are carrying over, and whether this company
  // already has a Stripe customer from an earlier subscription.
  const { data: company } = await db
    .from('companies')
    .select('trial_ends_at, stripe_customer_id')
    .eq('id', companyId)
    .maybeSingle();

  const trialEnd = resolveTrialEnd(company?.trial_ends_at ?? null, new Date());
  const customerId = company?.stripe_customer_id ?? null;

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: companyId,
    // Stripe rejects `customer` and `customer_email` together. Reusing the
    // existing customer keeps one company = one Stripe customer across a
    // cancel-and-resubscribe; without it the second checkout mints a new
    // customer and every later event for the old one silently matches no row.
    ...(customerId
      ? { customer: customerId }
      : { customer_email: typeof email === 'string' ? email : undefined }),
    subscription_data: {
      // client_reference_id rides the Checkout Session only — it is absent from
      // every customer.subscription.* event. This is how those events identify
      // the company when the customer-id link is missing (see the webhook).
      metadata: { company_id: companyId },
      ...(trialEnd ? { trial_end: trialEnd } : {}),
    },
    success_url: `${siteUrl()}/subscricao?sucesso=1`,
    cancel_url: `${siteUrl()}/subscricao`,
  });
  if (!session.url) throw new Error(getCatalog(locale).billing.checkoutFailed);
  redirect(session.url);
}
```

- [ ] **Step 2: Add the import**

At the top of the same file, beside the existing `@/lib/billing` import:

```ts
import { resolveTrialEnd } from '@/lib/billing-trial';
```

- [ ] **Step 3: Typecheck**

```bash
pnpm turbo lint typecheck --filter=@capo/web
```

Expected: clean. In particular `trial_end` must typecheck as `number` — if it complains, `resolveTrialEnd` is returning `number | undefined` into a spread, which the `...(trialEnd ? ... : {})` guard already narrows.

- [ ] **Step 4: Verify against the sandbox, end to end**

This is the only way to prove the Stripe call is well-formed; there is no test framework here.

```bash
stripe config --list
```

Confirm `display_name = 'Moussemango sandbox'` before doing anything else — never point a `trigger` or `listen` at live.

Then, with sandbox keys in `apps/web/.env.local`:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Put the printed `whsec_…` in `.env.local` as `STRIPE_WEBHOOK_SECRET`, run the app, and complete a checkout as a `trialing` company using card `4242 4242 4242 4242`.

Assert, in the Stripe sandbox dashboard:
- the subscription's status is **`trialing`**, not `active`
- its trial end date matches the company's `trial_ends_at`
- the subscription's **Metadata** shows `company_id`

Assert, in Supabase: `companies.subscription_status` is `'active'` (Capo maps Stripe's `trialing` to `active` — this is the intended mapping, not a bug), and `stripe_customer_id` is populated.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(app)/subscricao/actions.ts"
git commit -m "feat(billing): reuse the Stripe customer and stamp the company id on the subscription (#85)"
```

---

### Task 3: Make a zero-row webhook update loud, and recoverable

**Files:**
- Modify: `apps/web/app/api/stripe/webhook/route.ts:53-87`

**Interfaces:**
- Consumes: `subscription_data.metadata.company_id`, written by Task 2.
- Produces: log events `billing.company_not_found`, `billing.subscription_orphan`, `billing.subscription_recovered`.

**The bug being fixed:** a Supabase `.update()` whose filter matches nothing is **not an error** — it is a fully successful statement that touched no rows. Both branches today check only `error`, so an event for an unknown company logs `billing.subscription_updated` as though it had worked. Nobody ever finds out.

- [ ] **Step 1: Replace the `checkout.session.completed` case**

```ts
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const companyId = session.client_reference_id;
      if (companyId) {
        // .select('id') so a filter that matched nothing is visible. Without it
        // a zero-row update is indistinguishable from a successful one.
        const { data: updated, error } = await db
          .from('companies')
          .update({
            stripe_customer_id: typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null),
            stripe_subscription_id:
              typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null),
            subscription_status: 'active',
          })
          .eq('id', companyId)
          .select('id');
        if (error) {
          console.error('billing: failed to apply checkout.session.completed:', error.message);
        } else if (!updated?.length) {
          logEvent('billing.company_not_found', { companyId });
        } else {
          logEvent('billing.checkout_completed', { companyId });
        }
      }
      break;
    }
```

- [ ] **Step 2: Replace the `customer.subscription.*` case**

```ts
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
      const status = mapStripeStatus(subscription.status);
      const patch = { subscription_status: status, stripe_subscription_id: subscription.id };

      const { data: matched, error } = await db
        .from('companies')
        .update(patch)
        .eq('stripe_customer_id', customerId)
        .select('id');
      if (error) {
        console.error(`billing: failed to apply ${event.type}:`, error.message);
        break;
      }
      if (matched?.length) {
        logEvent('billing.subscription_updated', { customerId, stripeStatus: subscription.status, mappedStatus: status });
        break;
      }

      // No company carries this customer id. That is the state a fresh webhook
      // is most likely to be in — checkout.session.completed missed or failed —
      // so recover through the company id we stamped on the subscription at
      // checkout rather than dropping the event.
      const companyId = subscription.metadata?.company_id;
      if (!companyId) {
        logEvent('billing.subscription_orphan', {
          customerId,
          subscriptionId: subscription.id,
          reason: 'no_company_metadata',
        });
        break;
      }

      const { data: recovered, error: recoveryError } = await db
        .from('companies')
        .update({ ...patch, stripe_customer_id: customerId })
        .eq('id', companyId)
        .select('id');
      if (recoveryError) {
        // stripe_customer_id is unique — 23505 here means another company row
        // already claims this customer, which is a real data problem worth
        // seeing rather than a transient failure.
        logEvent('billing.subscription_orphan', {
          customerId,
          subscriptionId: subscription.id,
          companyId,
          reason: recoveryError.code ?? 'recovery_failed',
        });
        break;
      }
      if (!recovered?.length) {
        logEvent('billing.subscription_orphan', {
          customerId,
          subscriptionId: subscription.id,
          companyId,
          reason: 'company_missing',
        });
        break;
      }
      logEvent('billing.subscription_recovered', {
        customerId,
        subscriptionId: subscription.id,
        companyId,
        mappedStatus: status,
      });
      break;
    }
```

- [ ] **Step 3: Typecheck**

```bash
pnpm turbo lint typecheck --filter=@capo/web
```

Expected: clean. `subscription.metadata` is `Stripe.Metadata` (`{ [name: string]: string }`), so `subscription.metadata?.company_id` is `string | undefined` and needs no cast.

- [ ] **Step 4: Verify the orphan path against the sandbox**

Without this step the recovery branch is untested code that only ever runs on the day something is already wrong.

With `stripe listen` still forwarding to the local app:

```bash
stripe trigger customer.subscription.updated
```

`trigger` builds a throwaway customer no company row holds, and its subscription carries no `company_id` metadata. Assert the app logs `billing.subscription_orphan` with `reason: "no_company_metadata"` and still answers `200` — a webhook that 500s gets retried by Stripe for three days.

Then, to exercise the recovery branch: in the Stripe sandbox dashboard, open the subscription created in Task 2, clear the company's `stripe_customer_id` in Supabase, and edit the subscription (e.g. cancel it). Assert the app logs `billing.subscription_recovered` and that `stripe_customer_id` is written back.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/stripe/webhook/route.ts
git commit -m "fix(billing): a webhook update that matches no company is no longer a silent success (#85)"
```

---

### Task 4: Record what changed

**Files:**
- Modify: `AGENTS.md` (structural invariants list)
- Modify: `docs/human-todo.md` (§1)

- [ ] **Step 1: Add a billing invariant to `AGENTS.md`**

Add to the "Structural invariants (do not regress)" list, after the confirm-posture bullet:

```markdown
- **Billing runs on the LIVE Stripe account, and the webhook URL is the `www`
  host** (issue #85). `https://www.construcapo.com/api/stripe/webhook`, endpoint
  `we_1U4JwCLIxn6JugmnMEnNNhDA`, three events. The apex `construcapo.com` answers
  `308`, and Stripe **treats any 3xx reply to a delivery as a failure** — an apex
  endpoint fails 100% of deliveries silently, and since the webhook is the only
  writer of `subscription_status` (0011 revoked the tenant's UPDATE and re-granted
  `(name)` only), that is a paying customer locked out. Four things follow:
  - **The 14-day trial lives in Capo's database, and is handed to Stripe at
    checkout.** `resolveTrialEnd` (`apps/web/lib/billing-trial.ts`) is pure and
    lives outside `actions.ts` because that file is `'use server'`, where every
    export must be an async function compiled into an HTTP endpoint. Stripe
    rejects a Checkout Session whose `trial_end` is nearer than 48 hours, which
    is the whole reason the function exists; `pnpm billing-check` asserts that no
    input can ever produce one inside that floor.
  - **A zero-row update is not an error.** Both webhook updates carry
    `.select('id')` and log `billing.company_not_found` /
    `billing.subscription_orphan` when nothing matched. Same posture as
    `loadCompanySnapshot` and `recordUsage`: swallowed, but greppable. Grep those
    events before concluding that quiet billing means quiet traffic.
  - **`subscription_data.metadata.company_id` is the second identity.**
    `client_reference_id` rides the Checkout Session only and is absent from
    every `customer.subscription.*` event, so the metadata is what lets an
    unmatched subscription event recover instead of being dropped.
  - **The live price carries `tax_behavior: 'unspecified'` and that is now
    frozen** — it is immutable once a price has been used. Adding IVA later means
    a NEW price object, leaving existing subscribers alone; it is never an edit
    to `price_1U4J91LIxn6JugmnvZc5XN12`.
```

- [ ] **Step 2: Update `docs/human-todo.md` §1**

Rewrite the heading and append, keeping the existing 2026-07-17 entries as history:

```markdown
## 1. Stripe billing — ✅ LIVE (2026-08-14)
```

Then append after item 3:

```markdown
4. ✅ Moved from the sandbox to the live account (issue #85, 2026-08-14).
   Live account `acct_1TtrERLIxn6Jugmn`; price `price_1U4J91LIxn6JugmnvZc5XN12`
   (€45/month EUR); webhook `we_1U4JwCLIxn6JugmnMEnNNhDA` at
   `https://www.construcapo.com/api/stripe/webhook` — the **www** host, because
   the apex 308-redirects and Stripe counts a 3xx as a failed delivery. Portal
   configuration `bpc_1U4K5ALIxn6JugmnJTbCA060`: cancel at period end, no
   proration, no plan switching. `NEXT_PUBLIC_SITE_URL` added to Vercel
   production alongside the three Stripe values.

⚠ **Still outstanding:** disable (do not delete) the sandbox webhook
   `we_1TuAmhLaGmAMnE9xaKoeAC2P`, which still points at `capo-v1.vercel.app`.
   Left enabled deliberately during the cutover as the rollback path.

⚠ **Known, not fixed:** a company force-set to `active` by migration `0011`
   with no `stripe_customer_id` — both of Federico's own companies — shows
   "Gerir subscrição" on `/subscricao`, and tapping it throws
   `billing.noSubscription`. Pre-dates #85. The fix is for the page to key the
   button on `stripe_customer_id` rather than on `subscription_status`.
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md docs/human-todo.md
git commit -m "docs(billing): record the live Stripe cutover and its invariants (#85)"
```

---

### Task 5: Full gate and PR

- [ ] **Step 1: Run the complete merge gate**

```bash
pnpm turbo lint typecheck build
```

Expected: clean. Serialise this against any other worktree — Next 16 holds one build lock per workspace root.

- [ ] **Step 2: Run every credential-free check**

```bash
pnpm scheduler-check && pnpm guard-check && pnpm whatsapp-check && pnpm push-check && pnpm cache-check && pnpm cost-check && pnpm billing-check
```

Expected: `ALL PASS` from each, exit 0.

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "feat(billing): carry the trial into Stripe, and stop losing webhook events silently (#85)" --body "..."
```

Body must state: what a manager sees differently (subscribing early no longer costs them their remaining free days), the 48-hour Stripe floor and why the guard exists, that a zero-row update used to log success, and that the Stripe-side configuration (webhook, portal, live keys) was done by hand and is recorded in `docs/human-todo.md` §1.

---

## Handoff note — the rule Federico writes (Task 1, Step 5)

Ask him this, and wait. Do not choose for him.

A manager taps **Assinar** with **one day** of free trial left. Stripe will not accept a trial ending sooner than 48 hours from now, so one of three things has to happen:

| Rule | Code | Trade-off |
|---|---|---|
| **Charge today** | `if (secondsLeft < STRIPE_MIN_TRIAL_SECONDS) return undefined;` then `return endsAtSeconds;` | Correct to the euro. Takes away a day they were promised, at the exact moment they are choosing to pay. |
| **Lift to the 48h floor** | `if (secondsLeft < STRIPE_MIN_TRIAL_SECONDS) return nowSeconds + STRIPE_MIN_TRIAL_SECONDS;` then `return endsAtSeconds;` | Never errors, never short-changes. Costs at most one extra free day, and *gives* free days to someone whose trial already expired. |
| **Lift only if they had days left** | expired → `undefined`; `0 < secondsLeft < floor` → `nowSeconds + STRIPE_MIN_TRIAL_SECONDS`; else → `endsAtSeconds` | Neither penalises an early subscriber nor rewards an expired one. Three branches instead of two. |

Whichever he picks, Step 6 pins it in `scripts/billing-check.mts` so it is recorded in a file CI runs.
