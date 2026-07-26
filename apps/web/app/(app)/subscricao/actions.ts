'use server';

import { redirect } from 'next/navigation';
import { requireAuth } from '@capo/db/session';
import { getCatalog } from '@capo/i18n/catalog';
import { getStripe } from '@/lib/billing';
import { siteUrl } from '@/lib/site-url';

export async function startCheckout(): Promise<void> {
  const { db, companyId, locale } = await requireAuth();
  const priceId = process.env.STRIPE_PRICE_ID;
  // Config error, not a user error — stays English, nobody should ever see it.
  if (!priceId) throw new Error('STRIPE_PRICE_ID not set');

  const { data: claims } = await db.auth.getClaims();
  const email = claims?.claims?.email;

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: companyId,
    customer_email: typeof email === 'string' ? email : undefined,
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
