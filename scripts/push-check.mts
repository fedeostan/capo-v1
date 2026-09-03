// Web Push rules check — the deterministic half of the QA gate for PRD 7.
// Needs NO credentials, no network and no push service, so it runs in CI on
// every PR. Sibling of scheduler-check.mts and whatsapp-check.mts.
//
// It guards two specific bugs, both of which are silent in production:
//   * a 410 classified as retryable, which keeps a dead registration alive
//     and retried forever;
//   * an all-'gone' round classified as a retry, which hangs the row in the
//     queue and re-runs on every sweep for the rest of its life.
//
// Run with `pnpm push-check`. Exit 0 = green, 1 = at least one failure.

import {
  buildPushPayload,
  classifyPushStatus,
  decideRowState,
  isValidPushEndpoint,
  pushTargetUrl,
  PUSH_MAX_ATTEMPTS,
  PUSH_QUOTE_MAX_CHARS,
  truncateForPush,
} from '@capo/core/channels/push-rules';

let failures = 0;
const lines: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `got ${String(actual)}, want ${String(expected)}`);
}

// ── classifyPushStatus ─────────────────────────────────────────────────────
eq('201 is ok', classifyPushStatus(201), 'ok');
eq('200 is ok', classifyPushStatus(200), 'ok');
eq('404 is gone', classifyPushStatus(404), 'gone');
eq('410 is gone', classifyPushStatus(410), 'gone');
eq('429 is retry', classifyPushStatus(429), 'retry');
eq('500 is retry', classifyPushStatus(500), 'retry');
eq('503 is retry', classifyPushStatus(503), 'retry');
eq('0 (network error) is retry', classifyPushStatus(0), 'retry');
// 400 means we built a bad request; retrying cannot fix it, but deleting a
// live registration is the worse mistake, so it is capped by PUSH_MAX_ATTEMPTS
// rather than treated as gone.
eq('400 is retry, not gone', classifyPushStatus(400), 'retry');

// ── decideRowState ─────────────────────────────────────────────────────────
eq('no registrations at all stamps', decideRowState([]), 'stamp');
eq('one ok stamps', decideRowState(['ok']), 'stamp');
eq('ok alongside a failure still stamps', decideRowState(['ok', 'retry']), 'stamp');
eq('ok alongside a dead phone still stamps', decideRowState(['ok', 'gone']), 'stamp');
eq('every registration gone stamps (nothing left to chase)', decideRowState(['gone', 'gone']), 'stamp');
eq('single gone stamps', decideRowState(['gone']), 'stamp');
eq('a transient failure retries', decideRowState(['retry']), 'retry');
eq('gone + retry retries (one live phone still unreached)', decideRowState(['gone', 'retry']), 'retry');

// ── pushTargetUrl ──────────────────────────────────────────────────────────
eq('a resolved task deep-links to it', pushTargetUrl('abc'), '/tarefas/abc');
eq('an unresolved subject falls back to the inbox', pushTargetUrl(null), '/notificacoes');

// ── buildPushPayload ───────────────────────────────────────────────────────
const payload = buildPushPayload({
  notificationId: 'n1',
  appName: 'Capo',
  headline: '"Pintura sala" está a aguardar o teu controlo.',
  taskId: 't1',
});
check('a renderable row produces a payload', payload !== null);
eq('title is the app name', payload?.title, 'Capo');
eq('body is the inbox headline', payload?.body, '"Pintura sala" está a aguardar o teu controlo.');
eq('url deep-links to the task', payload?.url, '/tarefas/t1');
eq('tag is the notification id, so a redelivery replaces', payload?.tag, 'n1');

eq(
  'an unrenderable kind is skipped, not sent bare',
  buildPushPayload({ notificationId: 'n2', appName: 'Capo', headline: null, taskId: 't1' }),
  null,
);
eq(
  'a whitespace-only headline is skipped too',
  buildPushPayload({ notificationId: 'n3', appName: 'Capo', headline: '   ', taskId: 't1' }),
  null,
);

// ── truncateForPush (0049) ─────────────────────────────────────────────────
// The lock screen is the one surface with a single body slot, so a waived
// claim's reason is quoted INSIDE the sentence there rather than beneath it.
// That makes this function the only thing standing between a crew member's own
// words and a push payload, and it runs on text somebody else chose.
//
// Two failure directions. Too long and the alert is cut by whichever phone the
// manager happens to hold, in a different place each time — the worst kind of
// truncation, because nobody can tell how much is missing. Too clever and we
// start rewriting what a person wrote, which the manager then reads as a quote
// with that person's name on it.
check('nothing to quote is null, not empty quotes', truncateForPush(null) === null);
check('undefined is null', truncateForPush(undefined) === null);
check('an empty string is null', truncateForPush('') === null);
check('whitespace only is null', truncateForPush('   \n  ') === null);
check('a short reason survives whole', truncateForPush('não há luz') === 'não há luz');
check(
  'surrounding whitespace is trimmed, the words are not touched',
  truncateForPush('  não há luz  ') === 'não há luz',
);
check(
  'newlines collapse to single spaces (a push body has no line breaks)',
  truncateForPush('não há luz\n\ne o telemóvel morreu') === 'não há luz e o telemóvel morreu',
);
{
  // A reason exactly at the budget is NOT truncated: the boundary is inclusive,
  // so the commonest long-but-legal sentence keeps its last word.
  const exact = 'a'.repeat(PUSH_QUOTE_MAX_CHARS);
  check('a reason exactly at the cap is untouched', truncateForPush(exact) === exact);
}
{
  const over = 'a'.repeat(PUSH_QUOTE_MAX_CHARS + 40);
  const out = truncateForPush(over) ?? '';
  check('an over-long reason is cut', out.length <= PUSH_QUOTE_MAX_CHARS, `${out.length} chars`);
  check('and ends in an ellipsis the manager can see', out.endsWith('…'));
}
{
  // Generated rather than hand-listed: EVERY length must respect the cap, and
  // the word-boundary backtrack must never produce something longer than the
  // hard cut it started from.
  let overrun = 0;
  for (let n = 1; n <= PUSH_QUOTE_MAX_CHARS * 2; n += 1) {
    const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do '.repeat(10).slice(0, n);
    const out = truncateForPush(words);
    if (out !== null && out.length > PUSH_QUOTE_MAX_CHARS) overrun += 1;
  }
  check('no input length can exceed the cap', overrun === 0, `${overrun} overruns`);
}
{
  // A long sentence is cut on a word, not mid-word, when there is a space late
  // enough to be worth using.
  const out = truncateForPush(`${'palavra '.repeat(20)}fim`) ?? '';
  check('a long sentence is cut on a word boundary', !out.replace('…', '').endsWith('palavr'));
  check('and still fits', out.length <= PUSH_QUOTE_MAX_CHARS);
}
{
  // One enormous unbroken token has no usable space, so it is cut hard rather
  // than returned whole. The alternative — giving up on truncating — is the
  // overrun this function exists to prevent.
  const out = truncateForPush('x'.repeat(300)) ?? '';
  check('a single unbroken token is still cut', out.length <= PUSH_QUOTE_MAX_CHARS);
}
check('the quote budget is 90 characters', PUSH_QUOTE_MAX_CHARS === 90);

// ── isValidPushEndpoint ────────────────────────────────────────────────────
// The SSRF guard on what apps/web/app/api/push/route.ts will later POST to.
// It shipped two live bypasses during review — first accepting
// "https://localhost./x", then "https://localhost../x" — before a third
// attempt got it right, and neither was caught by anything until now.
// Generate the hostile cases rather than hand-listing them, so a fourth
// regression on any of these hosts, at any number of trailing dots, cannot
// slip through unnoticed.
const HOSTILE_HOSTS = ['localhost', 'foo.internal', 'foo.local', '127.0.0.1', '169.254.169.254'];
const TRAILING_DOTS = [0, 1, 2, 3, 5];
for (const host of HOSTILE_HOSTS) {
  for (const dots of TRAILING_DOTS) {
    const url = `https://${host}${'.'.repeat(dots)}/x`;
    check(`isValidPushEndpoint rejects ${url}`, isValidPushEndpoint(url) === false);
  }
}

const REAL_PUSH_SERVICES = [
  'https://fcm.googleapis.com/fcm/send/abc123',
  'https://updates.push.services.mozilla.com/wpush/v2/abc123',
  'https://web.push.apple.com/QAbc123',
];
for (const url of REAL_PUSH_SERVICES) {
  check(`isValidPushEndpoint accepts real push service ${url}`, isValidPushEndpoint(url) === true);
}

check('isValidPushEndpoint rejects http scheme', isValidPushEndpoint('http://fcm.googleapis.com/x') === false);
check(
  'isValidPushEndpoint rejects a userinfo-smuggled loopback',
  isValidPushEndpoint('https://evil@127.0.0.1/x') === false,
);
check(
  'isValidPushEndpoint rejects a decimal-encoded loopback IP',
  isValidPushEndpoint('https://2130706433/x') === false,
);
check(
  'isValidPushEndpoint rejects an IPv6 loopback literal',
  isValidPushEndpoint('https://[::1]/x') === false,
);
check('isValidPushEndpoint rejects a non-URL string', isValidPushEndpoint('not-a-url') === false);

// ── constants ──────────────────────────────────────────────────────────────
eq('attempt cap is 3', PUSH_MAX_ATTEMPTS, 3);

console.log(lines.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
