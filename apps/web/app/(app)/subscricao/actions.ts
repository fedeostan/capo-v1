'use server';

import { redirect } from 'next/navigation';
import { requireAuth } from '@capo/db/session';
import { getCatalog } from '@capo/i18n/catalog';
import { getStripe } from '@/lib/billing';
import { resolveTrialEnd } from '@/lib/billing-trial';
import { siteUrl } from '@/lib/site-url';

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
    // stored customer keeps one company = one Stripe customer across a
    // cancel-and-resubscribe; without it the second checkout mints a second
    // customer, the webhook overwrites stripe_customer_id with it, and every
    // later event for the first one silently matches no row.
    ...(customerId
      ? { customer: customerId }
      : { customer_email: typeof email === 'string' ? email : undefined }),
    subscription_data: {
      // client_reference_id rides the Checkout Session only — it is absent from
      // every customer.subscription.* event. This is how those events identify
      // the company when the customer-id link is missing; the webhook's
      // recovery path reads it.
      metadata: { company_id: companyId },
      // Absent means "no trial, charge today" — see resolveTrialEnd for why a
      // trial inside Stripe's 48-hour floor must not be sent at all.
      ...(trialEnd === undefined ? {} : { trial_end: trialEnd }),
    },
    success_url: `${siteUrl()}/subscricao?sucesso=1`,
    cancel_url: `${siteUrl()}/subscricao`,
  });
  if (!session.url) throw new Error(getCatalog(locale).billing.checkoutFailed);
  redirect(session.url);
}

export async function openPortal(): Promise<void> {
  const { db, companyId, locale } = await requireAuth();
  const { data: company } = await db.from('companies').select('stripe_customer_id').eq('id', companyId).single();
  if (!company?.stripe_customer_id) throw new Error(getCatalog(locale).billing.noSubscription);

  const stripe = getStripe();
  const portal = await stripe.billingPortal.sessions.create({
    customer: company.stripe_customer_id,
    return_url: `${siteUrl()}/subscricao`,
  });
  redirect(portal.url);
}
