import type Stripe from 'stripe';
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@capo/db/client';
import { getStripe } from '@/lib/billing';
import { logEvent } from '@/lib/log';

// System path: Stripe→server webhook, no user session — the structural gate
// is the signature (STRIPE_WEBHOOK_SECRET), same shape as the WhatsApp
// webhook's HMAC. Uses getDb() (service role) since it writes billing state
// across tenants by definition.

function mapStripeStatus(status: Stripe.Subscription.Status): 'active' | 'past_due' | 'canceled' {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'canceled':
    case 'unpaid':
      return 'canceled';
    default:
      // incomplete / incomplete_expired / paused have no explicit mapping in
      // the plan — treat as past_due (a payment/setup issue, not a hard
      // cancel) rather than silently leaving the prior status in place.
      return 'past_due';
  }
}

export async function POST(request: NextRequest) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    return new NextResponse('stripe not configured', { status: 503 });
  }

  const raw = await request.text();
  const signature = request.headers.get('stripe-signature');
  if (!signature) return new NextResponse('missing signature', { status: 400 });

  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, webhookSecret);
  } catch (err) {
    console.error('stripe webhook signature verification failed:', err);
    return new NextResponse('invalid signature', { status: 400 });
  }

  const db = getDb();
  logEvent('billing.webhook_event', { type: event.type });

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const companyId = session.client_reference_id;
      if (companyId) {
        const { error } = await db
          .from('companies')
          .update({
            stripe_customer_id: typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null),
            stripe_subscription_id:
              typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null),
            subscription_status: 'active',
          })
          .eq('id', companyId);
        if (error) console.error('billing: failed to apply checkout.session.completed:', error.message);
        logEvent('billing.checkout_completed', { companyId });
      }
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
      const status = mapStripeStatus(subscription.status);
      const { error } = await db
        .from('companies')
        .update({ subscription_status: status, stripe_subscription_id: subscription.id })
        .eq('stripe_customer_id', customerId);
      if (error) console.error(`billing: failed to apply ${event.type}:`, error.message);
      logEvent('billing.subscription_updated', { customerId, stripeStatus: subscription.status, mappedStatus: status });
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
