import Stripe from 'stripe';
import type { AuthContext } from '@capo/db/session';

// Env-gated: no STRIPE_SECRET_KEY → billing is entirely disabled and every
// write path stays open (the pilot company, and any deploy before Stripe
// keys exist, is never affected). Read lazily inside functions, never at
// module scope — this file is imported from statically-analyzed route code.
export type BillingState =
  | { enabled: false }
  | { enabled: true; status: string; trialEndsAt: string; daysLeft: number; blocked: boolean };

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
  return new Stripe(key);
}

// getBillingState only needs db+companyId — a plain AuthContext subset —
// so the WhatsApp route (which has no userId, just a service-role db +
// companyId resolved from the sender's phone) can reuse it for logging
// without holding a full AuthContext.
export async function getBillingState({ db, companyId }: Pick<AuthContext, 'db' | 'companyId'>): Promise<BillingState> {
  if (!process.env.STRIPE_SECRET_KEY) return { enabled: false };

  const { data: company } = await db.from('companies').select('subscription_status, trial_ends_at').eq('id', companyId).maybeSingle();
  if (!company) return { enabled: false };

  const daysLeft = Math.ceil((new Date(company.trial_ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const status = company.subscription_status;
  const blocked = (status === 'trialing' && daysLeft < 0) || status === 'past_due' || status === 'canceled';

  return { enabled: true, status, trialEndsAt: company.trial_ends_at, daysLeft, blocked };
}

export class BillingBlockedError extends Error {}

// Gate for write paths (chat, proposal resolution, task actions). No-op when
// billing is disabled or the company isn't blocked; otherwise throws so the
// caller can surface a friendly PT message (402 JSON for API routes, a plain
// thrown error for server actions — task-actions.tsx already catches and
// displays it).
export async function assertNotBlocked(ctx: Pick<AuthContext, 'db' | 'companyId'>): Promise<void> {
  const state = await getBillingState(ctx);
  if (state.enabled && state.blocked) {
    throw new BillingBlockedError('A tua subscrição expirou. Vai a Subscrição para reativar — o WhatsApp continua a funcionar.');
  }
}
