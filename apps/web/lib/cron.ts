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
 * each scheduled route registers SEVERAL daily UTC schedules an hour apart and
 * `withinSendWindow` below decides which of them may send, year round. Asking
 * Postgres is what saves every route from having to know about WET/WEST.
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

/**
 * How many Lisbon hours wide a send's acceptance window is, counted INCLUSIVE
 * of its target hour. 2 means "the target hour, or the hour after it".
 *
 * One constant for both scheduled routes, in the shared seam rather than in
 * either route, because this is the single number that decides whether the
 * crew hears from Capo at all on a day the platform is late. The two routes
 * are allowed to disagree about almost everything; they are not allowed to
 * disagree about this.
 */
export const SEND_WINDOW_HOURS = 2;

/**
 * The last Lisbon hour a send targeted at `sendHour` is still allowed out.
 *
 * CLAMPED AT 23, deliberately never wrapped past midnight. A wrapping window
 * would let a "bom dia, aqui está o teu dia" briefing go out after midnight,
 * on the wrong day — and worse than merely looking odd, `notification_date`
 * comes from lisbon_today(), so a run on the far side of midnight looks like a
 * fresh unclaimed day to the idempotency lock and messages everybody a second
 * time. Neither send hour in the product is anywhere near midnight; if one
 * ever is, losing the tail of its window is the cheap failure and wrapping
 * into the next day is the expensive one.
 */
export function sendWindowEnd(sendHour: number, windowHours = SEND_WINDOW_HOURS): number {
  return Math.min(sendHour + windowHours - 1, 23);
}

/**
 * Is `hour` — Europe/Lisbon, straight from lisbon_hour() — inside the window
 * in which a send targeted at `sendHour` may still go out? The one gate both
 * scheduled routes ask before they message anybody.
 *
 * ── Why this is a WINDOW and not an equality check ─────────────────────────
 * Capo owns no alarm clock. It asks Vercel to knock on the door, and Vercel's
 * cron dispatch on this project is reproducibly late: 45, 45, 33 and 49
 * minutes on 9, 10, 11 and 13 August 2026. The gate used to be
 * `hour !== SEND_HOUR`, which passes only while the drift stays under 60
 * minutes. On 13 August it was 49. Eleven minutes of margin, on a number that
 * has been growing rather than shrinking.
 *
 * Past that hour the failure is TOTAL and SILENT: the route answers 200 with
 * {skipped}, writes no notification_log row, raises no error, and the entire
 * crew simply hears nothing — indistinguishable from a healthy day. That is
 * why this had to be widened before it happened rather than after.
 *
 * ── Why widening is safe ───────────────────────────────────────────────────
 * notification_log's `unique nulls not distinct (kind, audience, worker_id,
 * profile_id, notification_date)` is still the idempotency lock, and is
 * untouched by this change. A second invocation inside the same window claims
 * nothing — claimNotification returns null on 23505 — and is therefore a no-op
 * BY CONSTRUCTION, not because this function is careful. That is precisely
 * what makes the window widenable at all: the hour gate was never the thing
 * stopping a double send, so relaxing it cannot cause one.
 *
 * ── Why not just accept any hour ───────────────────────────────────────────
 * Because the gate's real job is the other direction. A "bom dia" briefing
 * landing at 21:00 is worse than no briefing, and a "did you finish today?"
 * arriving at breakfast reads as the system having lost track of the day. Two
 * hours keeps the briefing recognisably morning and the check-in recognisably
 * late-afternoon while surviving up to two hours of drift instead of one.
 *
 * ── The UTC schedules that feed it ─────────────────────────────────────────
 * apps/web/vercel.json is JSON and cannot carry a comment, so its reasoning
 * lives here.
 *
 * It used to name the exact UTC hours each route needed — the UNION over both
 * DST offsets, three entries per route, computed by hand from a fixed
 * SEND_HOUR. That stopped being possible the moment the send hour became DATA
 * (issue #51, part B1): a manager may aim a send at any hour in
 * MIN_SEND_HOUR..MAX_SEND_HOUR, and vercel.json is a static file baked into the
 * deployment, so it cannot know what anybody chose.
 *
 * So both hour-gated routes are now an HOURLY HEARTBEAT:
 *
 *   /api/cron/reminders — `0 * * * *`
 *   /api/cron/checkin   — `0 * * * *`
 *
 * and the schedule itself lives in company_schedules, resolved per company in
 * apps/web/lib/schedule.ts. Three properties fall out of that, and
 * `pnpm scheduler-check` asserts all three from vercel.json itself:
 *
 *   * Every hour is covered in BOTH seasons, for EVERY legal target hour, by
 *     construction — the season-by-season hand-computed table cannot go stale
 *     because there is nothing left in it to get wrong.
 *   * In every window there are TWO entries that pass this gate: the one on
 *     the target hour and the one an hour later. The first lands on the target
 *     hour and claims everything; the second claims nothing (23505).
 *   * Every entry is still at :00. `0 * * * *` satisfies the rule by
 *     construction — a half-hourly heartbeat would put half its ticks thirty
 *     minutes into the hour, which is exactly the headroom arithmetic that made
 *     the check-in ship and then never send a single message (AGENTS.md).
 *
 * Why hourly and not every 10 or 15 minutes: this gate's resolution is one
 * Lisbon HOUR, so a finer tick cannot make a send land more precisely, while
 * multiplying platform invocations 4–6×. What protects against drift is the
 * WINDOW, not the tick rate. The full argument, including why the tick rate
 * cannot change the number of PAID sends at all, is in apps/web/lib/schedule.ts.
 *
 * /api/cron/push is not in this scheme and must stay out of it: it is meant to
 * run all day and has no hour gate at all. /api/cron/welcome has an hour gate
 * but an eleven-hour window, which is why a minute-based schedule is safe there.
 */
export function withinSendWindow(
  hour: number,
  sendHour: number,
  windowHours = SEND_WINDOW_HOURS,
): boolean {
  return hour >= sendHour && hour <= sendWindowEnd(sendHour, windowHours);
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
