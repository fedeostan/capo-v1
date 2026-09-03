import { NextResponse, type NextRequest } from 'next/server';
import { authorizeCron } from '@/lib/cron';
import { logEvent } from '@/lib/log';
import { drainAssignmentNotices } from '@/app/notifications/task-assigned';

// The safety net behind "a new task reaches the crew member now" (issue W7).
//
// ── WHY THIS EXISTS WHEN FIVE CALL SITES ALREADY DRAIN ─────────────────────
// Exactly the relationship /api/cron/push has with its immediate producers.
// The five in-request calls are the OPTIMISATION — they make the message
// arrive in seconds. This sweep is the MECHANISM: if one of them is removed,
// or a sixth write path is added by somebody who has never read this file, the
// cost is LATENESS rather than SILENCE. A queue drained only by the people who
// remembered to drain it is a queue with a hole in it.
//
// It also owns two cases no in-request call can:
//   * An assignment made outside working hours. Those notices are deliberately
//     left queued rather than consumed, and this is what looks at them again.
//   * The coalescing deferral. A manager assigning five tasks one at a time
//     gets ONE message for the last four, sent from here.
//
// ── NO HOUR GATE ON THE ROUTE ──────────────────────────────────────────────
// Deliberately, and this is the /api/cron/push shape rather than the two daily
// sends'. The quiet-hours rule belongs to the DRAIN, which applies it per
// notice against the Lisbon clock (lib/task-assigned-window.ts) — gating the
// route as well would state the same rule twice, and two statements of a rule
// drift. Since there is no hour gate, AGENTS.md's ":00, never :30" rule does
// not bind here either: it exists for routes whose window is one hour wide and
// whose miss is total.
//
// SYSTEM path: no user session, service-role client inside the drain, acts
// across tenants. Its structural gate is the CRON_SECRET bearer token, which
// Vercel injects on its own scheduled invocations.

export const dynamic = 'force-dynamic';

// Serial Graph API round trips, one per crew member, across every company —
// the same shape and the same ceiling as the other sweeps.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const denied = authorizeCron(request);
  if (denied) {
    // Logged for the reason /api/cron/welcome logs it: an auth
    // misconfiguration — a rotated CRON_SECRET, a typo in Vercel's env —
    // otherwise looks byte-identical to a healthy idle sweep. Both write
    // nothing and raise nothing.
    logEvent('task_assigned.cron_denied', { status: denied.status });
    return denied;
  }

  await drainAssignmentNotices();

  // The one line that makes "the sweep stopped running" falsifiable. Every
  // other log line in this feature is conditional on somebody being assigned
  // something, and on most invocations nobody is — so without this, a healthy
  // idle sweep and a route that has not been invoked for a week look identical.
  logEvent('task_assigned.swept', {});
  return NextResponse.json({ ok: true });
}
