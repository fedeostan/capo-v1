import { getDb } from '@capo/db/client';
import { runWelcomeSweep } from '@/app/notifications/welcome-sweep';
import { logEvent } from '@/lib/log';

// The one line every request path calls to say "somebody here may just have
// become messageable" (issue #45 follow-up).
//
// ── WHY IT ANSWERS A QUESTION RATHER THAN TAKING AN ARGUMENT ────────────────
// It takes a COMPANY id and nothing else. No worker id, no "who was added",
// because none of the call sites reliably knows: a manager saying "põe o Zé,
// 912 345 678, e ele já disse que sim" in chat produces a tool call whose
// result the route never inspects, and an approved card is a payload the route
// deliberately does not decode. The sweep re-derives the whole answer from the
// database, so the caller's only job is to name the tenant.
//
// That is also what makes it correct in the cases a hook would get wrong: a
// consent recorded three weeks after the number, a worker added by one door
// and consented through another, a fifth door nobody has built yet.
//
// ── EVERY FAILURE IS SWALLOWED, AND THAT IS THE POINT ───────────────────────
// This runs inside after(), once the manager's response is already on its way.
// A throw there is an unhandled rejection that reaches nobody, and there is
// nothing worth reaching them about: the */15 sweep will pick up whoever this
// call missed, at 09:00 at the latest. Same posture, and the same reasoning, as
// the immediate dispatchPushes call in _tasks/actions.ts — which is caught for
// the same getDb() reason: SUPABASE_SERVICE_ROLE_KEY missing on a preview
// deploy must cost a log line, never a manager's action.
//
// ⚠ SERVICE ROLE, DELIBERATELY, ON A TENANT REQUEST PATH. The welcome writes
// notification_log, which tenants hold no grant on at all, and reads across
// profiles and workers the way a cron does. This is a system job that a request
// happens to start, exactly like dispatchPushes; it is not the tenant's own
// client doing tenant work. The company id it is handed comes from the caller's
// already-authenticated session, and runWelcomeSweep intersects it with
// billableCompanies regardless, so a wrong id reaches nobody.

/**
 * Returns a promise that NEVER rejects, so a call site is always the single
 * line `after(() => welcomeAnyoneNew(companyId, 'chat'))`. Awaited by after()
 * rather than fired and forgotten: a detached promise on a serverless function
 * is killed the instant the response flushes, which would make the trigger work
 * on a warm local dev server and silently never run in production.
 */
export async function welcomeAnyoneNew(companyId: string, source: string): Promise<void> {
  try {
    const outcome = await runWelcomeSweep(getDb(), { companyId, window: 'immediate' });
    // Only the interesting outcomes. 'ran' with nobody welcomed is the steady
    // state — it happens on most manager turns, and logging it would bury
    // everything else.
    if (outcome.status === 'ran') {
      if (outcome.welcomed > 0) {
        logEvent('welcome.triggered', { companyId, source, welcomed: outcome.welcomed });
      }
      return;
    }
    logEvent('welcome.trigger_skipped', { companyId, source, reason: outcome.status });
  } catch (err) {
    logEvent('welcome.trigger_failed', {
      companyId,
      source,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
