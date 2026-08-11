import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getApiAuth } from '@capo/db/session';
import { getDb } from '@capo/db/client';
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

// Validate that an endpoint URL is safe for our server to POST to later.
// This prevents server-side request forgery: an authenticated tenant could
// otherwise register a URL like http://localhost:9200/ or a cloud metadata
// service address and make Capo's server issue requests to internal hosts.
// Only HTTPS endpoints with real DNS names are valid — a legitimate push
// service always has both. Do not add an allowlist of known push-service
// hostnames; they change and add frequently, and a stale allowlist would
// silently break users' real registrations, which is worse than the attack
// we are preventing here.
function isValidPushEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Scheme must be exactly https.
    if (parsed.protocol !== 'https:') return false;

    const hostname = parsed.hostname;
    if (!hostname) return false;

    // Reject localhost.
    if (hostname === 'localhost') return false;

    // Reject .local and .internal domains.
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;

    // Reject IPv4 and IPv6 literals. IPv6 in a URL is bracket-wrapped,
    // e.g. https://[::1]/x. A bare IPv4 shows up as a dotted quad.
    // Both are invalid for a legitimate push service endpoint.
    if (hostname.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;

    return true;
  } catch {
    return false;
  }
}

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
  // unsubscribe the previous owner and cause that physical device to receive
  // their own tenant's alerts instead. This is accepted because Web Push
  // offers no device-ownership proof — the endpoint is the only credential
  // that exists. Better to have an endpoint swapped than require a device you
  // cannot prove owning to never register again.
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
