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
