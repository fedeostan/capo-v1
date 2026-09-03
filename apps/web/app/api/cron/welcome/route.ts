import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@capo/db/client';
import { logEvent } from '../../../../lib/log';
import { authorizeCron } from '../../../../lib/cron';
import { runWelcomeSweep } from '../../../notifications/welcome-sweep';

// ── THE WELCOME SWEEP (issue #45) ───────────────────────────────────────────
//
// "We need a welcome to Capo as soon as a number is added to the system."
//
// The route is now a thin shell: authorise, run, translate the outcome into a
// status code. Everything it used to do — the deploy gate, the clock, the
// quiet-hours window, the claim, the two envelopes, the thread note — moved
// into apps/web/app/notifications/welcome-sweep.ts, unchanged, so the
// IMMEDIATE trigger added beside it runs exactly the same code. Two copies of
// a proactive send would eventually disagree, and the symptom of that would be
// a person welcomed twice, in two different wordings, from two different hours.
//
// Read welcome-sweep.ts for why this is a sweep at all rather than a hook on
// the moment a number is typed, and welcome-window.ts for why the immediate
// gate is wider than this one.
//
// SYSTEM path: no user session, service-role client, acts across tenants. Its
// structural gate is the CRON_SECRET bearer token, which Vercel injects on its
// own scheduled invocations.

export const dynamic = 'force-dynamic';

// One Graph API round-trip per person, across every company, in one invocation
// — the same shape as the two daily sends, and the same ceiling.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const denied = authorizeCron(request);
  if (denied) {
    // Logged for the reason /api/cron/push logs it: an auth misconfiguration —
    // a rotated CRON_SECRET, a typo in Vercel's env — otherwise looks
    // byte-identical to a healthy idle sweep. Both write nothing and raise
    // nothing, which is the exact shape of failure that let the check-in ship
    // and never send a single message.
    logEvent('welcome.cron_denied', { status: denied.status });
    return denied;
  }

  // dry_run renders everything and sends nothing, writes nothing. It also
  // bypasses the hour gate, so the output can be inspected at any time of day.
  const dryRun = request.nextUrl.searchParams.get('dry_run') === '1';

  const outcome = await runWelcomeSweep(getDb(), { window: 'cron', dryRun });

  switch (outcome.status) {
    case 'ledger_not_ready':
      return new NextResponse('welcome ledger not ready', { status: 503 });
    case 'clock_unavailable':
      return new NextResponse('clock unavailable', { status: 500 });
    case 'not_configured':
      return new NextResponse('whatsapp not configured', { status: 503 });
    case 'company_read_failed':
      return new NextResponse('company read failed', { status: 500 });
    case 'outside_window':
      return NextResponse.json({
        skipped: 'outside the send window',
        lisbonHour: outcome.lisbonHour,
        sendHour: outcome.sendHour,
        windowEnd: outcome.windowEnd,
      });
    default: {
      // The one line that makes "the sweep stopped running" falsifiable,
      // exactly as `dashboard.push_swept` does for the push backstop. Every
      // other log line in this feature is conditional on somebody being
      // welcomed, and most days nobody is — so without this, a healthy idle
      // sweep and a route that has not been invoked for a week look identical.
      if (!dryRun) logEvent('welcome.swept', { companies: outcome.companies.length });
      return NextResponse.json({
        dryRun,
        date: outcome.date,
        lisbonHour: outcome.lisbonHour,
        companies: outcome.companies,
      });
    }
  }
}

// ── KNOWN AND NOT FIXED ─────────────────────────────────────────────────────
//
// A crew member added and consented between midnight and 07:00 gets their first
// 07:00 briefing BEFORE their welcome, because the briefing's window opens an
// hour earlier than even the immediate trigger's. They are introduced to Capo
// by a list of tasks and then told who Capo is. Fixing it properly means the
// briefing consulting the welcome ledger, which would put a second reader on
// this feature's lock and couple the morning send to something that has nothing
// to do with it. The window it applies to is small (added, consented AND swept,
// all inside seven overnight hours) and the failure is cosmetic.
