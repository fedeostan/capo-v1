import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getApiAuth } from '@capo/db/session';
import { getDb } from '@capo/db/client';
import { isValidPushEndpoint } from '@capo/core/channels/push-rules';
import { logEvent } from '@/lib/log';

// Registering and unregistering one phone.
//
// A route rather than server actions because the SERVICE WORKER has to call
// it: `pushsubscriptionchange` fires in a worker context that cannot invoke a
// server action. Two ways to register would be two things that can drift, so
// the /perfil card uses this same route.
//
// Deliberately NOT behind assertNotBlocked, like markAllRead: a lapsed
// subscription blocks changing site data, and it must never trap someone into
// alerts they cannot switch off.
//
// isValidPushEndpoint (the SSRF guard on what this route will later POST to)
// lives in @capo/core/channels/push-rules — pure, dependency-free, and
// asserted by `pnpm push-check` — rather than here. See that file for why.

const subscribeSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2000)
    .refine(isValidPushEndpoint, {
      message: 'endpoint must be https to a real hostname',
    }),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2000)
    .refine(isValidPushEndpoint, {
      message: 'endpoint must be https to a real hostname',
    }),
});

export async function POST(req: Request) {
  const ctx = await getApiAuth();
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const parsed = subscribeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 });
  const { endpoint, keys } = parsed.data;

  const row = {
    company_id: ctx.companyId,
    profile_id: ctx.userId,
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    user_agent: req.headers.get('user-agent')?.slice(0, 500) ?? null,
  };

  // Try as the tenant first. This is the overwhelmingly common path — a phone
  // registering for the first time — and it needs no elevated privilege at all.
  // The insert goes on the USER client, so RLS and the column-scoped INSERT
  // grant apply to the row being created.
  const { error } = await ctx.db.from('push_subscriptions').insert(row);

  // 23505 = unique_violation on `endpoint`: this browser install is already
  // registered, to a profile we may not be able to see. That is the shared-
  // handset case, where the previous manager's session expired without signing
  // out, leaving a row this manager can neither see nor delete. Presenting the
  // endpoint IS the capability: it is a high-entropy URL that only that
  // device's browser knows. An attacker who obtains an endpoint can silently
  // unsubscribe the previous owner — but cannot read their alerts by doing so.
  // The reclaim inserts the ATTACKER's own p256dh/auth keys, so a later push is
  // sealed to a key pair the victim's browser never held and its service
  // worker cannot decrypt; delivery is by endpoint, not by key, so the
  // attacker's own devices never receive it either. The realistic outcome is
  // silence for the victim, not disclosure to the attacker. This is accepted
  // because Web Push offers no device-ownership proof — the endpoint is the
  // only credential that exists. Better to have an endpoint go silent than
  // require a device you cannot prove owning to never register again.
  if (error?.code === '23505') {
    // Reclaim the endpoint on the service role. Row-level security
    // structurally cannot let one profile delete another's row, so some
    // escalation is genuinely required for a legitimate reclaim.
    const { error: reclaimError } = await getDb()
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint);
    if (reclaimError) {
      return NextResponse.json({ error: 'could not register' }, { status: 500 });
    }

    logEvent('push.endpoint_reclaimed', { companyId: ctx.companyId });

    // Retry the insert on the user client. If this still fails, the previous
    // owner lost their registration and is worse off with nothing recorded,
    // so log it distinctly.
    const { error: retryError } = await ctx.db.from('push_subscriptions').insert(row);
    if (retryError) {
      logEvent('push.reclaim_orphaned', { companyId: ctx.companyId, error: retryError.message });
      return NextResponse.json({ error: 'could not register' }, { status: 500 });
    }

    logEvent('push.registered', { companyId: ctx.companyId });
    return NextResponse.json({ ok: true });
  }

  if (error) {
    logEvent('push.register_failed', { companyId: ctx.companyId, error: error.message });
    return NextResponse.json({ error: 'could not register' }, { status: 500 });
  }

  logEvent('push.registered', { companyId: ctx.companyId });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const ctx = await getApiAuth();
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const parsed = unsubscribeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 });

  // User client: RLS scopes this to the caller's own registrations, so the
  // worst a hostile request can do is unsubscribe one of its own phones.
  const { error } = await ctx.db
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', parsed.data.endpoint);
  if (error) {
    logEvent('push.unregister_failed', { companyId: ctx.companyId, error: error.message });
    return NextResponse.json({ error: 'could not unregister' }, { status: 500 });
  }

  logEvent('push.unregistered', { companyId: ctx.companyId });
  return NextResponse.json({ ok: true });
}
