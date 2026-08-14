// Billing check — the deterministic half of issue #85. Needs NO credentials,
// no network and no Stripe account, so it runs in CI on every PR. Sibling of
// push-check.mts, guard-check.mts and cost-check.mts.
//
// It guards one bug, which is silent until a real manager hits it: Stripe
// rejects an ENTIRE Checkout Session whose subscription_data.trial_end is
// nearer than 48 hours, so a manager subscribing in the last days of their
// trial taps Assinar and gets an error instead of a payment page. Nothing in
// the type system prevents it — trial_end is just a number.
//
// The loop at the bottom is the assertion that matters most: it holds for
// every rule anyone might later choose, so it survives a change of product
// mind that the pinned cases below it would not.
//
// Run with `pnpm billing-check`. Exit 0 = green, 1 = at least one failure.

import {
  resolveTrialEnd,
  STRIPE_MIN_TRIAL_SECONDS,
  TRIAL_CARRY_MARGIN_SECONDS,
} from '../apps/web/lib/billing-trial.ts';

let failures = 0;
const lines: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `got ${String(actual)}, want ${String(expected)}`);
}

// A fixed clock. Never Date.now() — a check whose result depends on when it
// runs is not a check.
const NOW = new Date('2026-08-14T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

const HOUR = 60 * 60;
const isoIn = (seconds: number) => new Date(NOW.getTime() + seconds * 1000).toISOString();
const secondsAt = (seconds: number) => NOW_SECONDS + seconds;

// ── constants ──────────────────────────────────────────────────────────────
eq("Stripe's floor is 48 hours", STRIPE_MIN_TRIAL_SECONDS, 172800);
eq('the carry margin is 5 minutes', TRIAL_CARRY_MARGIN_SECONDS, 300);

// ── the branches that hold whatever the rule is ────────────────────────────
eq('no company row carries no trial', resolveTrialEnd(null, NOW), undefined);
eq('an unparseable timestamp carries no trial', resolveTrialEnd('not-a-date', NOW), undefined);
eq('an empty string carries no trial', resolveTrialEnd('', NOW), undefined);

// ── the chosen rule, pinned (Federico, 2026-08-14) ─────────────────────────
// Comfortably above the floor: hand the real trial end to Stripe untouched.
eq(
  'a fresh 14-day trial is passed through untouched',
  resolveTrialEnd(isoIn(14 * 24 * HOUR), NOW),
  secondsAt(14 * 24 * HOUR),
);
eq(
  'twelve days left is passed through untouched',
  resolveTrialEnd(isoIn(12 * 24 * HOUR), NOW),
  secondsAt(12 * 24 * HOUR),
);
eq(
  'three days left is passed through untouched',
  resolveTrialEnd(isoIn(3 * 24 * HOUR), NOW),
  secondsAt(3 * 24 * HOUR),
);

// Below the floor (plus its margin): charge today rather than error.
eq('one day left charges today', resolveTrialEnd(isoIn(24 * HOUR), NOW), undefined);
eq('47 hours left charges today', resolveTrialEnd(isoIn(47 * HOUR), NOW), undefined);
eq('an expired trial charges today', resolveTrialEnd(isoIn(-1 * HOUR), NOW), undefined);
eq('a trial that expired a week ago charges today', resolveTrialEnd(isoIn(-7 * 24 * HOUR), NOW), undefined);

// The margin is the whole point of TRIAL_CARRY_MARGIN_SECONDS: a trial ending
// at EXACTLY the floor would be rejected by Stripe for arriving a second late,
// so it must charge today rather than be carried.
eq(
  'exactly 48 hours charges today — it would land inside the floor',
  resolveTrialEnd(isoIn(48 * HOUR), NOW),
  undefined,
);
eq(
  'floor plus four minutes still charges today',
  resolveTrialEnd(isoIn(48 * HOUR + 4 * 60), NOW),
  undefined,
);
eq(
  'floor plus six minutes is carried',
  resolveTrialEnd(isoIn(48 * HOUR + 6 * 60), NOW),
  secondsAt(48 * HOUR + 6 * 60),
);

// ── the invariant that outlives the rule ───────────────────────────────────
// Whatever anyone later decides, nothing may ever be returned inside Stripe's
// floor. This is the assertion that would have caught the bug this module
// exists to prevent, and it does not depend on the rule above.
for (const hoursLeft of [-336, -72, -1, 0, 1, 24, 47, 47.9, 48, 48.1, 49, 72, 336, 8760]) {
  const at = isoIn(Math.round(hoursLeft * HOUR));
  const result = resolveTrialEnd(at, NOW);
  check(
    `${hoursLeft}h left never yields a trial_end inside Stripe's floor`,
    result === undefined || result >= NOW_SECONDS + STRIPE_MIN_TRIAL_SECONDS,
    `got ${String(result)}`,
  );
}

// A carried value must also never be LATER than the trial the manager was
// actually promised — that would be free days nobody agreed to give away.
for (const hoursLeft of [49, 72, 336, 8760]) {
  const at = isoIn(hoursLeft * HOUR);
  const result = resolveTrialEnd(at, NOW);
  check(
    `${hoursLeft}h left is never extended beyond the promised trial end`,
    result === undefined || result <= Math.floor(Date.parse(at) / 1000),
    `got ${String(result)}`,
  );
}

console.log(lines.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
