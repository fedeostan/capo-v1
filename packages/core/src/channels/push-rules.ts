// Pure decisions for Web Push. No I/O, no env, no catalog, no Node APIs — so
// `pnpm push-check` can assert every branch in CI without credentials, the
// same arrangement capabilities/reschedule.ts has with scheduler-check.
//
// The transport lives in apps/web/lib/push.ts because `web-push` is a
// Node-only dependency and this package is the bundle the agent ships in.
// Copy lives in @capo/i18n and is passed in already rendered: core must never
// import the catalog (AGENTS.md), so `headline` arrives as a plain string.

/** What a push service's answer means for the registration we sent to. */
export type PushOutcome =
  /** Delivered (or accepted for delivery). */
  | 'ok'
  /** 404/410: this registration is dead. Delete it — never retry. */
  | 'gone'
  /** Anything else. The sweep may try again. */
  | 'retry';

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** The notification row id. Replaces rather than stacks on redelivery. */
  tag: string;
}

/** Three failures and the dispatcher abandons a row. The inbox and the shell
 *  strip still carry it, so the manager is un-buzzed, never uninformed. */
export const PUSH_MAX_ATTEMPTS = 3;

/**
 * 404 and 410 are the single most useful thing a push service tells you: the
 * subscription is gone (app deleted, browser data cleared, phone wiped) and
 * nothing will ever be delivered to it again. Believing it the first time is
 * what stops the table filling with addresses we retry forever.
 *
 * Everything else — 429 rate limit, 5xx, a network error mapped to 0 — is
 * transient by assumption. Wrong assumption costs at most PUSH_MAX_ATTEMPTS
 * pointless requests; the reverse mistake deletes a live registration.
 */
export function classifyPushStatus(status: number): PushOutcome {
  if (status === 404 || status === 410) return 'gone';
  if (status >= 200 && status < 300) return 'ok';
  return 'retry';
}

/**
 * Whether the notification row is finished with.
 *
 * The 'gone'-only case is the one that is easy to get wrong and hangs the
 * queue: if every registration answered 'gone' they have all just been
 * deleted, so the recipient now has NO devices and retrying is chasing
 * nothing. Treating that as a retry leaves the row circling until it hits
 * PUSH_MAX_ATTEMPTS, on every sweep, forever after every event.
 *
 * An empty array means the recipient had no registrations at all — stamp, or
 * the sweep chases every manager who never opted in.
 */
export function decideRowState(outcomes: PushOutcome[]): 'stamp' | 'retry' {
  if (outcomes.length === 0) return 'stamp';
  if (outcomes.includes('ok')) return 'stamp';
  if (outcomes.every(o => o === 'gone')) return 'stamp';
  return 'retry';
}

/**
 * Where the tap lands. A review's notification points at the TASK, because
 * that is where the approve/reject controls render — the same resolution
 * loadInbox does. A subject that no longer resolves falls back to the inbox
 * rather than a 404: a dead end reads as a bug.
 */
export function pushTargetUrl(taskId: string | null): string {
  return taskId ? `/tarefas/${taskId}` : '/notificacoes';
}

/**
 * Returns null when there is no sentence to show.
 *
 * The inbox can degrade to a bare task title for a `kind` it does not know —
 * on screen, surrounded by app chrome, that reads as terse. A lock-screen
 * alert with no sentence is just noise under the app's name, so a row whose
 * kind the catalog cannot render is skipped instead. That happens when a row
 * written by a newer deploy reaches an older bundle mid-rollout.
 */
export function buildPushPayload(input: {
  notificationId: string;
  appName: string;
  headline: string | null;
  taskId: string | null;
}): PushPayload | null {
  const body = input.headline?.trim();
  if (!body) return null;
  return {
    title: input.appName,
    body,
    url: pushTargetUrl(input.taskId),
    tag: input.notificationId,
  };
}

/**
 * Whether a push endpoint URL is safe for OUR server to POST to later.
 *
 * This is the guard against server-side request forgery: an authenticated
 * tenant could otherwise register a URL like http://localhost:9200/ or a
 * cloud metadata service address (169.254.169.254) and make Capo's server
 * issue a request to an internal host on their behalf when the dispatcher
 * later sends to it. Only HTTPS endpoints with real DNS names are valid — a
 * legitimate push service always has both. Do not add an allowlist of known
 * push-service hostnames; they change and add frequently, and a stale
 * allowlist would silently break users' real registrations, which is worse
 * than the attack being prevented here.
 *
 * Lives here rather than in apps/web/app/api/push/route.ts, its only caller,
 * because it is pure and dependency-free — exactly what `pnpm push-check`
 * exists for. That matters concretely: this predicate shipped two live
 * bypasses during review (first accepting "https://localhost./x", then
 * "https://localhost../x") before a third attempt got it right, and nothing
 * was asserting it at the time. See scripts/push-check.mts for the generated
 * coverage that now exists specifically because of that history.
 */
export function isValidPushEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Scheme must be exactly https.
    if (parsed.protocol !== 'https:') return false;

    const hostname = parsed.hostname;
    if (!hostname) return false;

    // A trailing dot is valid FQDN syntax and resolves identically to the
    // same name without one, so "localhost." (or "localhost..") would
    // otherwise walk straight past an exact-match check below. Earlier
    // drafts of this function tried to STRIP trailing dots before comparing
    // — first one, then "all trailing dots" — and each version shipped a
    // bypass: normalising is exactly the kind of logic that is easy to get
    // subtly wrong and hard to notice you got wrong, because the hostname
    // LOOKS handled either way. Rejecting outright needs no such reasoning: a
    // real push service endpoint never has a trailing dot, so any hostname
    // that does is refused, full stop, before anything below runs.
    if (hostname.endsWith('.')) return false;

    const host = hostname.toLowerCase();

    // Reject localhost.
    if (host === 'localhost') return false;

    // Reject .local and .internal domains.
    if (host.endsWith('.local') || host.endsWith('.internal')) return false;

    // Reject IPv4 and IPv6 literals. IPv6 in a URL is bracket-wrapped, e.g.
    // https://[::1]/x. A bare IPv4 shows up as a dotted quad — and the URL
    // parser itself folds other IPv4 spellings (decimal, e.g.
    // "2130706433", or a trailing-dotted "127.0.0.1.") into that same
    // dotted-quad form before this function ever sees them, so this one
    // check also covers those.
    if (host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;

    return true;
  } catch {
    return false;
  }
}
