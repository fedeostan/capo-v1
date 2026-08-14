// The confirmation posture (profiles.confirm_posture, migration 0031) — the
// per-manager dial deciding whether a mutating instruction is carried out
// immediately or turned into an approval card first.
//
// WHY IT LIVES IN @capo/db AND NOT IN @capo/core, where it is enforced.
// Two very different pieces of software need this union: the code that RESOLVES
// a manager's identity (this package's session.ts on the web, the WhatsApp
// route's profile lookup) and the code that ENFORCES the posture
// (packages/core/src/capabilities/guard.ts). The dependency direction is
// i18n ← db ← core, so core can import from here and db can never import from
// core. Putting the union in core would force db to duplicate it — which is the
// exact shape of bug this file exists to avoid, since the two copies would be
// free to drift and the drift would present as a manager silently getting the
// wrong posture. Same reasoning that puts `Locale` in @capo/i18n rather than in
// whichever package happens to render a sentence.
//
// This module deliberately imports nothing at all.

export const CONFIRM_POSTURES = ['always_ask', 'trust_quote'] as const;

export type ConfirmPosture = (typeof CONFIRM_POSTURES)[number];

/**
 * The safe end of the dial, and the column default in 0031.
 *
 * Every fallback in this file resolves HERE rather than to `trust_quote`. An
 * unreadable, missing or unrecognised value must never be the reason a write
 * lands without the manager seeing it: the cost of guessing wrong in this
 * direction is one extra tap, and in the other direction it is an unconfirmed
 * change to a live job.
 */
export const DEFAULT_CONFIRM_POSTURE: ConfirmPosture = 'always_ask';

/** Strict parse for form input: null when the value is not one of the two. */
export function asConfirmPosture(value: unknown): ConfirmPosture | null {
  return typeof value === 'string' && (CONFIRM_POSTURES as readonly string[]).includes(value)
    ? (value as ConfirmPosture)
    : null;
}

/**
 * Read a stored value, failing closed.
 *
 * `undefined` is a real case and not defensive padding: both callers now read
 * the profile row with `select('*')` precisely so that a bundle deployed BEFORE
 * migration 0031 lands degrades to "always ask" instead of 42703-ing the whole
 * request (AGENTS.md's view/column deploy-ordering rule). Naming an unmigrated
 * column in a `select` list is how you turn a settings feature into an outage.
 */
export function coerceConfirmPosture(value: unknown): ConfirmPosture {
  return asConfirmPosture(value) ?? DEFAULT_CONFIRM_POSTURE;
}
