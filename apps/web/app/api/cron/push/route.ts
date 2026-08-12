import { NextResponse, type NextRequest } from 'next/server';
import { authorizeCron } from '@/lib/cron';
import { dispatchPushes } from '@/app/notifications/push';
import { logEvent } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// The push backstop, every 10 minutes.
//
// It exists because the immediate path can be forgotten. #22 (worker
// completions over WhatsApp) and #23 (reschedule cards) are built on separate
// branches and each adds a producer; if push depended on those authors
// remembering to call the dispatcher, it would quietly not work for the very
// case the feature exists for. With this, the worst case is a ten-minute
// delay rather than silence.
//
// NO lisbon_hour() GATE, unlike the two daily send routes. Those gate on the
// hour because they must fire once, at a specific local time; this one is
// meant to run all day, so an hour gate would be the same class of bug that
// made the check-in ship and then never send a single message. The AGENTS.md
// ":00 never :30" rule is likewise about hour-gated crons and does not apply
// here — cron drift costs this route lateness on a backstop, never silence.
export async function GET(request: NextRequest) {
  const denied = authorizeCron(request);
  if (denied) {
    // Without this, an auth misconfiguration (a rotated CRON_SECRET, a typo
    // in Vercel's env) looks byte-identical in the logs to a healthy idle
    // sweep — both write nothing and raise nothing. AGENTS.md already states
    // this rule for the two sibling send routes: "a rejection writes no row
    // and raises no error", which is exactly the shape of failure that let
    // the check-in ship and never send a single message.
    logEvent('push.cron_denied', { status: denied.status });
    return denied;
  }

  await dispatchPushes({
    // Amendment from Task 5's review: the immediate path (see after() in
    // _tasks/actions.ts) has no claim protocol on push_attempts — it is a
    // read-modify-write, not a compare-and-set — so if both triggers pick up
    // the same unstamped row, both send it and one update can clobber the
    // other. Skipping anything younger than two minutes NARROWS that race —
    // it leaves a fresh row to the immediate call that is (almost certainly)
    // already handling it — but does not close it: the immediate path itself
    // has no age filter, so two concurrent requestReview() calls in the same
    // company can each read the pending set before the other's row exists,
    // and then each dispatch will pick up the OTHER call's fresh row too,
    // with the same clobber risk as above. That second race is undocumented
    // anywhere else, so this comment is its only durable home. The immediate
    // path itself must NEVER pass this option — it exists to catch
    // everything, including a row created this instant.
    olderThanSeconds: 120,
    // Amendment from Task 5's review: explicit rather than the dispatcher's
    // 200 default. dispatchPushes sends serially — one Web Push call per
    // device, awaited in turn — so the wall-clock cost of a run scales with
    // rows × devices-per-recipient. 100 rows leaves headroom under the 60s
    // maxDuration above even when several recipients have multiple devices
    // registered; a run that got truncated by the platform would leave rows
    // unstamped, which only costs a duplicate buzz on the next sweep ten
    // minutes later — but staying under the ceiling is cheaper than relying
    // on that fallback every time.
    limit: 100,
  });
  // The one line that makes "the backstop stopped running" falsifiable — see
  // the Risks section of the design doc. dispatchPushes itself writes no log
  // when there is nothing pending or push is unconfigured, both normal quiet
  // states, so this line is what proves the sweep reached the end of a run
  // at all, on every invocation, healthy or idle alike.
  logEvent('dashboard.push_swept', {});
  return NextResponse.json({ ok: true });
}
