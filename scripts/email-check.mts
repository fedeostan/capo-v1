// Email check — the account emails Capo now sends itself (W1). Needs NO
// credentials, no network and no Supabase project, so it runs in CI on every
// PR. Sibling of billing-check.mts, push-check.mts and guard-check.mts.
//
// It guards the two ways this can break, both of which are silent:
//
//   1. THE LINK. The whole point of W1 is that the address in the email is the
//      one /auth/confirm can verify. If a renderer ever mangles it — an escape
//      that eats the `&`, a template hole, a text part built from a different
//      string — the person cannot get into their account, and nothing in a
//      build or a typecheck notices. The Supabase templates this replaced had
//      exactly that bug for months.
//
//   2. THE LANGUAGES. These emails used to stack all three languages because a
//      Go template could not know its reader. The app can, so it renders the
//      reader's first and the other two as one line each. The failure mode of
//      that improvement is dropping somebody's language entirely, which only
//      the person who cannot read the email finds out about.
//
//   3. THE REDIRECT AFTER VERIFICATION. Every one of these links ends at
//      /auth/confirm, which decides where to send the now-authenticated
//      session from a `next` query parameter that rides the same link an
//      attacker can reuse or rewrite. `safeNextPath` (apps/web/lib/safe-next.ts)
//      is what stands between that value and an open redirect to a different
//      host; it is pinned directly here.
//
// Run with `pnpm email-check`. Exit 0 = green, 1 = at least one failure.

import { getCatalog } from '../packages/i18n/src/catalogs.ts';
import { LOCALES, type Locale } from '../packages/i18n/src/locale.ts';
import { renderConfirmEmail } from '../apps/web/lib/emails/confirm.ts';
import { renderResetEmail } from '../apps/web/lib/emails/reset.ts';
import { escapeHtml } from '../apps/web/lib/emails/shell.ts';
import { safeNextPath } from '../apps/web/lib/safe-next.ts';

let failures = 0;
const lines: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

// The two real link shapes, exactly as lib/auth-email.ts builds them. Pinned
// here as literals rather than imported: a check that computed the expected
// value with the same code as the thing it checks asserts nothing. The token
// is a 56-character hex string in real life (verified against the live
// project); its content is irrelevant to rendering, its punctuation is not.
const TOKEN = 'a'.repeat(56);
const SITE = 'https://www.construcapo.com';
const CONFIRM_LINK = `${SITE}/auth/confirm?token_hash=${TOKEN}&type=signup&next=%2Fonboarding`;
const MAGIC_LINK = `${SITE}/auth/confirm?token_hash=${TOKEN}&type=magiclink&next=%2Fonboarding`;
const RESET_LINK = `${SITE}/auth/confirm?token_hash=${TOKEN}&type=recovery&next=%2Fnova-password`;

const RENDERERS = [
  { name: 'confirm (signup)', render: renderConfirmEmail, link: CONFIRM_LINK, key: 'confirm' },
  { name: 'confirm (resend)', render: renderConfirmEmail, link: MAGIC_LINK, key: 'confirm' },
  { name: 'reset', render: renderResetEmail, link: RESET_LINK, key: 'reset' },
] as const;

console.log('Email check\n');

for (const { name, render, link, key } of RENDERERS) {
  for (const locale of LOCALES) {
    const label = `${name} / ${locale}`;
    const { subject, html, text } = render({ locale, link });
    const t = getCatalog(locale).auth.emails;

    // ── the link ───────────────────────────────────────────────────────────
    // In HTML the `&` between query parameters MUST be escaped, or the client
    // is free to interpret `&type` and `&next` as entities and hand the person
    // a truncated address.
    check(`${label}: html carries the escaped link`, html.includes(escapeHtml(link)));
    check(
      `${label}: html never carries a raw unescaped query separator`,
      !html.includes(`token_hash=${TOKEN}&type=`),
      'a bare & in an href is the truncation bug',
    );
    check(`${label}: the text twin carries the same link, unescaped`, text.includes(link));
    check(
      `${label}: html links to it twice (button and copy-paste fallback)`,
      html.split(escapeHtml(link)).length - 1 >= 2,
      'the fallback address is what a broken button costs',
    );

    // ── no template holes ──────────────────────────────────────────────────
    // These were Go templates until W1. A `{{ .TokenHash }}` surviving a port
    // renders as literal text in somebody's inbox and links nowhere.
    for (const [part, body] of [
      ['html', html],
      ['text', text],
      ['subject', subject],
    ] as const) {
      check(`${label}: ${part} has no leftover template hole`, !body.includes('{{'));
    }

    // ── all three languages, reader first ──────────────────────────────────
    check(`${label}: subject is this locale's`, subject === t[key].subject);
    for (const part of ['heading', 'body', 'button', 'fallback', 'footer'] as const) {
      check(`${label}: html renders the reader's ${part} in full`, html.includes(escapeHtml(t[key][part])));
    }

    const others: Locale[] = LOCALES.filter((l) => l !== locale);
    check(`${label}: exactly two other languages`, others.length === 2);
    for (const other of others) {
      const o = getCatalog(other).auth.emails;
      check(
        `${label}: names ${other} in the divider`,
        html.includes(escapeHtml(o.languageLabel)) && text.includes(o.languageLabel),
      );
      check(
        `${label}: carries ${other}'s one-line version`,
        html.includes(escapeHtml(o[key].otherLine)) && text.includes(o[key].otherLine),
      );
      // The other languages get ONE line each. If a full body for another
      // locale appears, the reader-first design has quietly reverted to the
      // stacked Supabase template it replaced.
      check(
        `${label}: does not render ${other}'s full body`,
        !html.includes(escapeHtml(o[key].body)) || o[key].body === t[key].body,
        'reader-first became all-three-stacked again',
      );
    }

    // ── shape ──────────────────────────────────────────────────────────────
    check(`${label}: subject is not empty`, subject.trim().length > 0);
    check(`${label}: html is a complete document`, html.startsWith('<!doctype html>') && html.trimEnd().endsWith('</html>'));
    check(`${label}: text part carries no markup`, !text.includes('<td') && !text.includes('<html'));
  }
}

// The three links must be distinguishable: a renderer that ignored its `link`
// argument and hardcoded one would pass every assertion above for one shape.
check(
  'the three link shapes are distinct',
  new Set([CONFIRM_LINK, MAGIC_LINK, RESET_LINK]).size === 3,
);
check(
  'a confirm render carries the link it was given, not a fixed one',
  !renderConfirmEmail({ locale: 'pt-PT', link: CONFIRM_LINK }).text.includes(RESET_LINK),
);

// ── the open-redirect guard on `next` (/auth/confirm) ───────────────────────
// The redirect at the end of /auth/confirm used to be plain string
// concatenation onto `origin`, which let a `next` of `@evil.com/` resolve to
// a different host entirely. `safeNextPath` is the pure half of the fix; this
// pins it directly, the same way the link shapes above are pinned as
// literals rather than derived from the code under test.
const NEXT_FALLBACK = '/';
check('safeNextPath: an ordinary destination passes through', safeNextPath('/onboarding', NEXT_FALLBACK) === '/onboarding');
check(
  'safeNextPath: a destination carrying its own query string passes through',
  safeNextPath('/nova-password?x=1', NEXT_FALLBACK) === '/nova-password?x=1',
);
check('safeNextPath: the userinfo@host trick is refused', safeNextPath('@evil.com/', NEXT_FALLBACK) === NEXT_FALLBACK);
check('safeNextPath: protocol-relative is refused', safeNextPath('//evil.com', NEXT_FALLBACK) === NEXT_FALLBACK);
check('safeNextPath: an absolute URL is refused', safeNextPath('https://evil.com', NEXT_FALLBACK) === NEXT_FALLBACK);
check(
  'safeNextPath: the backslash variant of protocol-relative is refused',
  safeNextPath('/\\evil.com', NEXT_FALLBACK) === NEXT_FALLBACK,
);
check('safeNextPath: a javascript: scheme is refused', safeNextPath('javascript:alert(1)', NEXT_FALLBACK) === NEXT_FALLBACK);
check('safeNextPath: a null next value falls back', safeNextPath(null, NEXT_FALLBACK) === NEXT_FALLBACK);

for (const line of lines) console.log(`  ${line}`);
console.log(`\nchecked ${lines.length} assertions`);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('green');
