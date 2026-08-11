import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import type { Db } from '@capo/db/client';
import { WhatsAppSendError } from '@capo/core/channels/whatsapp';

// Shared wiring for the two SCHEDULED routes: the 07:00 briefing
// (api/cron/reminders) and the late-afternoon check-in (api/cron/checkin).
//
// Sibling of lib/whatsapp.ts, which does the same job for the two routes that
// talk to Meta. The split is deliberate: these two routes have almost no BODY
// in common — different audiences, templates, kinds and skip rules — but they
// must not drift on the parts that are load-bearing for correctness, namely the
// auth shape and the claim/idempotency protocol. Sharing those and nothing else
// is what keeps a `mode` parameter out of a single 250-line handler.
//
// Env is read lazily, inside functions — never at module scope. A module-scope
// read breaks `next build` in CI, where these secrets are absent.

/**
 * The structural gate on every scheduled route. Returns a response to send, or
 * null when the caller is authorised.
 *
 * Vercel injects `Authorization: Bearer $CRON_SECRET` automatically on its own
 * scheduled invocations. Any other trigger has to set the header itself.
 */
export function authorizeCron(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return new NextResponse('cron not configured', { status: 503 });
  if (!bearerValid(request.headers.get('authorization'), secret)) {
    return new NextResponse('unauthorized', { status: 401 });
  }
  return null;
}

function bearerValid(header: string | null, secret: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const b = Buffer.from(secret, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface NotificationClaim {
  id: string;
}

/**
 * Claim a target for today, or report that someone already did.
 *
 * The insert goes in BEFORE the Graph API call, which is what turns
 * notification_log's unique constraint into an idempotency lock: a retry, a
 * double-scheduled cron, or a manual re-run cannot message the same person
 * twice. Returns null when the claim was already taken.
 *
 * Note the trade-off this makes deliberately: a FAILED send also holds the
 * claim, so a transient error costs that person their message for the day
 * rather than risking a duplicate. The failure is visible in the operator's
 * Briefing log; to force a retry, delete the row and re-invoke the route.
 *
 * `kind` is a field on the row rather than a module constant because it is the
 * ONLY thing separating the two daily sends under that unique constraint —
 * ('daily_briefing' vs 'task_checkin'). Collapsing them to one kind gives a
 * second run that claims nothing, skips everyone, and reports success.
 */
export async function claimNotification(
  db: Db,
  row: {
    kind: string;
    company_id: string;
    audience: 'worker' | 'manager';
    worker_id?: string;
    profile_id?: string;
    notification_date: string;
    task_ids: string[];
  },
): Promise<NotificationClaim | null> {
  const { data, error } = await db
    .from('notification_log')
    .insert({ ...row, channel: 'whatsapp', status: 'pending' })
    .select('id')
    .single();
  // 23505 = unique_violation: already claimed today. Not an error.
  if (error) {
    if (error.code === '23505') return null;
    throw new Error(`notification_log claim failed: ${error.message}`);
  }
  return data;
}

export async function resolveNotification(
  db: Db,
  claimId: string,
  status: 'sent' | 'failed' | 'skipped',
  extra: { provider_message_id?: string | null; error?: string | null } = {},
): Promise<void> {
  const { error } = await db.from('notification_log').update({ status, ...extra }).eq('id', claimId);
  if (error) console.error(`notification_log: could not resolve claim ${claimId}: ${error.message}`);
}

export function describeSendError(err: unknown): string {
  if (err instanceof WhatsAppSendError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export interface LisbonClock {
  hour: number;
  today: string;
}

/**
 * The clock lives in SQL. One clock, one definition of "today" (AGENTS.md).
 *
 * Vercel Cron fires in UTC and Lisbon is UTC+0 in winter, UTC+1 in summer, so
 * each scheduled route registers TWO daily UTC schedules an hour apart and
 * exactly one of them passes its hour gate, year round. Asking Postgres is what
 * saves every route from having to know about WET/WEST.
 *
 * Returns null when the clock is unreadable — the caller answers 500 rather
 * than guessing, because a guessed hour either sends at the wrong time or
 * sends nothing at all, and both are silent.
 */
export async function readLisbonClock(db: Db, routeName: string): Promise<LisbonClock | null> {
  const { data: hour, error: hourError } = await db.rpc('lisbon_hour');
  if (hourError || hour === null) {
    console.error(`${routeName}: lisbon_hour failed:`, hourError?.message);
    return null;
  }
  const { data: today, error: todayError } = await db.rpc('lisbon_today');
  if (todayError || !today) {
    console.error(`${routeName}: lisbon_today failed:`, todayError?.message);
    return null;
  }
  return { hour, today };
}

export interface BillableCompany {
  id: string;
  name: string;
  language: string;
}

/**
 * The companies a scheduled send may cost money on.
 *
 * Outbound template sends are paid, so unlike the inbound webhook — which is
 * deliberately ungated during the pilot — every scheduled route skips companies
 * that are no longer paying. Throws rather than returning empty: an empty list
 * and a failed read look identical downstream, and one of them means "message
 * nobody today" while the other means "the database is broken".
 */
export async function billableCompanies(db: Db): Promise<BillableCompany[]> {
  const { data, error } = await db
    .from('companies')
    .select('id, name, language')
    .in('subscription_status', ['trialing', 'active']);
  if (error) throw new Error(`company read failed: ${error.message}`);
  return data ?? [];
}
