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

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});

const unsubscribeSchema = z.object({ endpoint: z.string().url().max(2000) });

export async function POST(req: Request) {
  const ctx = await getApiAuth();
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const parsed = subscribeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 });
  const { endpoint, keys } = parsed.data;

  // Reclaim the endpoint on the service role FIRST. One endpoint is one
  // browser install, and `endpoint` is globally unique — so a shared handset
  // whose previous manager's session expired without signing out would leave a
  // row this manager can neither see nor delete, and the insert below would
  // die on the unique constraint with that phone unable to register ever
  // again. Presenting the endpoint IS the capability: it is a high-entropy URL
  // that only that device's browser knows.
  const { error: reclaimError } = await getDb()
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', endpoint);
  if (reclaimError) {
    return NextResponse.json({ error: 'could not register' }, { status: 500 });
  }

  // The insert itself goes on the USER client, so RLS and the column-scoped
  // INSERT grant apply to the row being created.
  const { error } = await ctx.db.from('push_subscriptions').insert({
    company_id: ctx.companyId,
    profile_id: ctx.userId,
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    user_agent: req.headers.get('user-agent')?.slice(0, 500) ?? null,
  });
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
