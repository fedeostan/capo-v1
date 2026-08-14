// The 14-day trial lives in Capo's own database (`companies.trial_ends_at`),
// not in Stripe. When a manager subscribes early we hand the remaining days to
// Stripe as `subscription_data.trial_end`, so they are not charged for days
// they were already given.
//
// Pure and dependency-free on purpose: no Db, no Stripe client, no Date.now().
// `now` is a parameter so `scripts/billing-check.mts` can assert every branch
// with no credentials, no network and no clock.
//
// It deliberately does NOT live in `subscricao/actions.ts`: that file is
// `'use server'`, where every export must be an async function compiled into a
// callable HTTP endpoint. A synchronous helper there is a build error, and an
// async one would publish this rule as a public endpoint.

/**
 * Stripe rejects a Checkout Session whose `trial_end` is nearer than this.
 * Source: stripe@18.5.0 `types/Checkout/SessionsResource.d.ts` — "Has to be at
 * least 48 hours in the future."
 */
export const STRIPE_MIN_TRIAL_SECONDS = 48 * 60 * 60;

/**
 * Headroom above the floor before we are willing to carry a trial across.
 *
 * The floor is evaluated by Stripe when the request LANDS, not when we compute
 * it: network time, a retry inside stripe-node, and the seconds the manager
 * spends between tapping and the request leaving all eat into it. A trial
 * ending at exactly 48:00:00 would be rejected for arriving at 47:59:58, and
 * the manager would see an error instead of a payment page — which is the one
 * outcome this whole module exists to prevent.
 */
export const TRIAL_CARRY_MARGIN_SECONDS = 5 * 60;

/**
 * The Unix-seconds timestamp to pass to Stripe as `subscription_data.trial_end`,
 * or `undefined` meaning "send no trial, charge today".
 *
 * The rule (Federico's call, 2026-08-14): carry the remaining trial across when
 * there is comfortably more than Stripe's 48-hour floor left, and otherwise
 * charge today. A trial with under two days left is worth less than the
 * confusion of a subscription that starts billing on a date nobody chose.
 */
export function resolveTrialEnd(trialEndsAt: string | null, now: Date): number | undefined {
  // No company row — the caller reads with maybeSingle() and a missing row must
  // never break a checkout.
  if (!trialEndsAt) return undefined;

  const endsAtMs = Date.parse(trialEndsAt);
  // An unparseable timestamp falls back to charging today, which is exactly the
  // behaviour that existed before this function did.
  if (Number.isNaN(endsAtMs)) return undefined;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const endsAtSeconds = Math.floor(endsAtMs / 1000);

  // Covers an already-expired trial too: its remaining seconds are negative.
  if (endsAtSeconds - nowSeconds < STRIPE_MIN_TRIAL_SECONDS + TRIAL_CARRY_MARGIN_SECONDS) {
    return undefined;
  }
  return endsAtSeconds;
}
