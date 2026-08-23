// Design system contract — the deterministic half of the design QA gate.
// Needs NO credentials and no network, so it runs in CI on every PR. Sibling
// of scheduler-check.mts, push-check.mts and cost-check.mts.
//
// It guards defects that are ALL silent in production:
//   * a colour pair below its WCAG floor — which is exactly how the primary
//     button shipped at 3.56:1 and stayed there for the life of the product;
//   * --brand-vivid used behind text, where it is 3.56:1 and not 5.18:1;
//   * a screen reverting to raw palette classes, which is how fifteen
//     spellings of one button happened in the first place;
//   * a tap target under 44px — NOT CHECKED, deliberately. Expressing "this
//     element is tappable and shorter than 44px" as a regex over class strings
//     is not something this file can do honestly: `min-h-11` is a size utility
//     and `off-scale-spacing` excludes h/w on purpose, so `h-8` on a new icon
//     button passes here. The 44px floor lives in the Button/IconButton size
//     maps and in review. A rule this file claims but does not run is worse
//     than one it never claimed.
//
// It reads packages/ui/src/tokens.css itself rather than duplicating the
// values, for the same reason cost-check.mts reads the live migration: a copy
// of the thing under test passes forever after the original changes.
//
// Run with `pnpm design-check`. Exit 0 = green, 1 = at least one failure.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
const lines: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Reading the token file ─────────────────────────────────────────────────

const TOKENS_PATH = 'packages/ui/src/tokens.css';

let css = '';
try {
  css = readFileSync(TOKENS_PATH, 'utf8');
} catch {
  check(`${TOKENS_PATH} exists`, false, 'file not found');
  console.log(lines.join('\n'));
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}

check(`${TOKENS_PATH} exists`, true);

// The raw file contains the word inside its own header comment — the one
// that WARNS about this trap — so test the file with comments stripped.
// Rewording that comment to satisfy a regex would cost the file its most
// important sentence.
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

// tokens.css must never contain @utility: Tailwind silently discards the
// WHOLE imported file, with no error anywhere. Proven by spike 2026-08-23.
check(
  'tokens.css contains no @utility rule',
  !/@utility\b/.test(cssWithoutComments),
  '@utility in an imported file makes Tailwind drop the entire file silently',
);

/** Every `--name: value;` inside the block opened by `selector {`.
 *
 *  Reads `cssWithoutComments`, not `css` — a brace or a `--name:` sequence
 *  inside a comment would otherwise be counted as real tokens. No comment
 *  contains either today, which is exactly why this was one comment away from
 *  a phantom token before this file started reading the stripped source. */
function block(selector: string): Record<string, string> {
  const at = cssWithoutComments.indexOf(`${selector} {`);
  if (at === -1) return {};
  const open = cssWithoutComments.indexOf('{', at);
  let depth = 0;
  let i = open;
  for (; i < cssWithoutComments.length; i += 1) {
    if (cssWithoutComments[i] === '{') depth += 1;
    else if (cssWithoutComments[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const out: Record<string, string> = {};
  for (const m of cssWithoutComments.slice(open + 1, i).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const LIGHT = block(':root');
const DARK = block(':root.dark');
// :root.system sits inside `@media (prefers-color-scheme: dark)` — a
// hand-duplicated copy of :root.dark, because the media query cannot share a
// declaration block with a class selector. block() finds it by the same
// `selector {` search regardless of the enclosing @media, since it only
// tracks brace depth from that point.
const SYSTEM = block(':root.system');

check('light theme block parsed', Object.keys(LIGHT).length > 10, `${Object.keys(LIGHT).length} tokens`);
check('dark theme block parsed', Object.keys(DARK).length > 10, `${Object.keys(DARK).length} tokens`);
check('system theme block parsed', Object.keys(SYSTEM).length > 10, `${Object.keys(SYSTEM).length} tokens`);

// ── Contrast ───────────────────────────────────────────────────────────────

const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance(hex: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => channel(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number | null {
  const a = luminance(fg);
  const b = luminance(bg);
  if (a === null || b === null) return null;
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** [foreground token, background token, floor, what it is] — the whole
 *  contract, one row per claim the design makes. A row here is a promise. */
const PAIRS: [string, string, number, string][] = [
  ['--fg', '--surface', 4.5, 'body text on a card'],
  ['--fg', '--bg', 4.5, 'body text on the page'],
  ['--fg-muted', '--surface', 4.5, 'secondary text on a card'],
  ['--fg-muted', '--bg', 4.5, 'secondary text on the page'],
  ['--fg-faint', '--surface', 4.5, 'timestamps and hints'],
  ['--on-brand', '--brand', 4.5, 'the primary button label'],
  ['--brand', '--surface', 4.5, 'brand text on a card'],
  ['--danger', '--surface', 4.5, 'error text'],
  ['--warn', '--surface', 4.5, 'at-risk text'],
  ['--success', '--surface', 4.5, 'done text'],
  ['--info', '--surface', 4.5, 'informational text'],
  ['--review', '--surface', 4.5, 'pending-review text'],
  // WCAG 1.4.11: the outline of a control is the only signal it is a control.
  ['--border-control', '--surface', 3, 'the edge of an input'],
  ['--border-control', '--surface-sunken', 3, 'the edge of a filled input'],
  // Large non-text fills only.
  ['--brand-vivid', '--bg', 3, 'a non-text brand fill'],
  // The `-solid` tokens are pinned to the same value in both themes (Task 2):
  // a status banner is a fixed signal colour, not a themed surface. These
  // check the SOLID variants, not `--danger`/`--info` directly — asserting
  // the wrong pair here is exactly how the dark-mode failure reappears.
  ['--on-solid', '--danger-solid', 4.5, 'text on a danger banner'],
  ['--on-solid', '--warn-solid', 4.5, 'text on an at-risk banner'],
  ['--on-solid', '--success-solid', 4.5, 'text on a success banner'],
  ['--on-solid', '--info-solid', 4.5, 'text on an info banner'],
  ['--on-solid', '--review-solid', 4.5, 'text on a review banner'],
  ['--on-solid', '--brand-solid', 4.5, 'text on a brand banner'],
];

for (const [themeName, theme] of [['light', LIGHT], ['dark', DARK], ['system', SYSTEM]] as const) {
  for (const [fg, bg, floor, what] of PAIRS) {
    const fgv = theme[fg];
    const bgv = theme[bg];
    if (!fgv || !bgv) {
      check(`${themeName}: ${fg} on ${bg} (${what})`, false, `missing ${!fgv ? fg : bg}`);
      continue;
    }
    const ratio = contrast(fgv, bgv);
    if (ratio === null) {
      check(`${themeName}: ${fg} on ${bg} (${what})`, false, `not a 6-digit hex: ${fgv} / ${bgv}`);
      continue;
    }
    check(
      `${themeName}: ${fg} on ${bg} (${what})`,
      ratio >= floor,
      `${ratio.toFixed(2)}:1, need ${floor}:1`,
    );
  }
}

// :root.system is a hand-duplicated copy of :root.dark — the media query cannot
// share a declaration block with a class selector. Duplication is only safe if
// something asserts the copies agree, or the two drift the first time one is
// edited and only "Sistema" users see it.
{
  const darkKeys = Object.keys(DARK).sort();
  const systemKeys = Object.keys(SYSTEM).sort();
  check(
    ':root.system declares exactly the same tokens as :root.dark',
    darkKeys.join(',') === systemKeys.join(','),
    `dark has ${darkKeys.length}, system has ${systemKeys.length}`,
  );
  for (const key of darkKeys) {
    if (SYSTEM[key] === undefined) continue; // already reported by the key check
    check(
      `:root.system ${key} matches :root.dark`,
      SYSTEM[key] === DARK[key],
      `system ${SYSTEM[key]} vs dark ${DARK[key]}`,
    );
  }
}

// --brand-vivid is the ONE colour that is legal as a fill and illegal behind
// text. Stating it as its own assertion means a future edit that "tidies" it
// into --brand's role fails loudly instead of reintroducing a 3.56:1 button.
//
// LIGHT ONLY, deliberately. The bug this guards against is WHITE on #ea580c
// (3.56:1), which is what shipped. In dark mode --on-brand is near-black, and
// near-black on #ea580c is 4.91:1 — legitimately readable — so the assertion
// would be false there. A guard that is false in a theme is a guard that gets
// "fixed" by bending a brand colour, which is the opposite of its purpose.
{
  const ratio = LIGHT['--brand-vivid'] && LIGHT['--on-brand']
    ? contrast(LIGHT['--brand-vivid'], LIGHT['--on-brand'])
    : null;
  check(
    'light: --brand-vivid is NOT safe behind --on-brand text',
    ratio !== null && ratio < 4.5,
    ratio === null ? 'tokens missing' : `${ratio.toFixed(2)}:1 — if this ever passes, use --brand instead`,
  );
}

// ── Usage rules ────────────────────────────────────────────────────────────
//
// The rules above protect the tokens. These protect their USE. Without them a
// screen can quietly go back to `border-zinc-500/30` and the contrast checks
// stay green while the product drifts — which is precisely how fifteen
// spellings of one button happened.

const SCAN_ROOTS = ['apps/web/app', 'apps/operator/app', 'packages/ui/src'];

const RULES: { id: string; re: RegExp; why: string }[] = [
  {
    id: 'raw-palette',
    re: /\b(?:text|bg|border|ring|fill|stroke|from|to|via|decoration|outline|divide|placeholder|shadow|accent|caret)-(?:zinc|gray|neutral|slate|stone|orange|red|amber|emerald|green|violet|blue|sky|yellow|rose|pink|purple|indigo|cyan|teal|lime|fuchsia|black|white)(?:-\d{2,3})?(?:\/\d{1,3})?\b/,
    why: 'raw palette colour — use a role token (bg-surface, text-fg-muted, border-control…)',
  },
  {
    id: 'arbitrary-text-size',
    re: /\btext-\[\d+px\]/,
    why: 'arbitrary text size — use the scale (text-body, text-caption, text-micro…)',
  },
  {
    id: 'off-scale-spacing',
    re: /\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-(?:0\.5|1\.5|2\.5|3\.5|5|7|9|10|11|14)\b/,
    why: 'spacing step outside 1/2/3/4/6/8/12/16 (4/8/12/16/24/32/48/64px)',
  },
  {
    id: 'arbitrary-colour',
    re: /\b(?:text|bg|border|ring|fill|stroke|from|to|via|outline|decoration|shadow|accent|caret)-\[(?:#|rgb|hsl|oklch|color-mix)/i,
    why: 'hard-coded colour — use a role token, this is the exact spelling of the 3.56:1 button',
  },
];

/** Files not yet converted to the design system.
 *
 *  This list may ONLY ever shrink. Each screen-conversion task deletes its own
 *  entries; when it is empty the sweep is finished and this constant goes away
 *  with it.
 *
 *  A stale entry is a FAILURE, not a shrug — see the check below. An allowlist
 *  nobody prunes is how a temporary exception becomes permanent, and the whole
 *  point of this ledger is that it is the remaining work, written down. */
const UNCONVERTED: string[] = [
  'apps/operator/app/companies/page.tsx',
  'apps/operator/app/conversations/[companyId]/page.tsx',
  'apps/operator/app/conversations/page.tsx',
  'apps/operator/app/cost/page.tsx',
  'apps/operator/app/dispatch/page.tsx',
  'apps/operator/app/layout.tsx',
  'apps/operator/app/page.tsx',
  'apps/operator/app/signups/page.tsx',
  'apps/operator/app/tasks/page.tsx',
  'apps/web/app/(app)/_tasks/completion-sheet.tsx',
  'apps/web/app/(app)/_tasks/materials-editor.tsx',
  'apps/web/app/(app)/_tasks/review-actions.tsx',
  'apps/web/app/(app)/_tasks/task-actions.tsx',
  'apps/web/app/(app)/language-drift.tsx',
  'apps/web/app/(app)/layout.tsx',
  'apps/web/app/(app)/materiais/page.tsx',
  'apps/web/app/(app)/notificacoes/mark-all-read.tsx',
  'apps/web/app/(app)/notificacoes/page.tsx',
  'apps/web/app/(app)/obras/[id]/page.tsx',
  'apps/web/app/(app)/perfil/automacoes/page.tsx',
  'apps/web/app/(app)/perfil/memoria/page.tsx',
  'apps/web/app/(app)/perfil/page.tsx',
  'apps/web/app/(app)/perfil/profile-forms.tsx',
  'apps/web/app/(app)/perfil/push-card.tsx',
  'apps/web/app/(app)/perfil/sign-out-button.tsx',
  'apps/web/app/(app)/perfil/theme-pills.tsx',
  'apps/web/app/(app)/perfil/translation-progress.tsx',
  'apps/web/app/(app)/subscricao/page.tsx',
  'apps/web/app/(app)/tarefas/[id]/ajuda/loading.tsx',
  'apps/web/app/(app)/tarefas/[id]/ajuda/page.tsx',
  'apps/web/app/(app)/tarefas/[id]/assignee-picker.tsx',
  'apps/web/app/(app)/tarefas/[id]/collaborators-picker.tsx',
  'apps/web/app/(app)/tarefas/filter-chips.tsx',
  'apps/web/app/(app)/tarefas/filter-controls.tsx',
  'apps/web/app/(app)/tarefas/page.tsx',
  'apps/web/app/(public)/confirmar-email/page.tsx',
  'apps/web/app/(public)/instalar/install-guide.tsx',
  'apps/web/app/(public)/instalar/page.tsx',
  'apps/web/app/(public)/landing/page.tsx',
  'apps/web/app/(public)/language-switch.tsx',
  'apps/web/app/(public)/login/page.tsx',
  'apps/web/app/(public)/nova-password/page.tsx',
  'apps/web/app/(public)/offline/page.tsx',
  'apps/web/app/(public)/onboarding/page.tsx',
  'apps/web/app/(public)/password-field.tsx',
  'apps/web/app/(public)/recuperar/page.tsx',
  'apps/web/app/(public)/registar/page.tsx',
  'apps/web/app/(public)/whatsapp/handshake.tsx',
  'apps/web/app/(public)/whatsapp/page.tsx',
  'apps/web/app/bottom-nav.tsx',
  'apps/web/app/chat.tsx',
  'apps/web/app/mic-button.tsx',
  'apps/web/app/pull-to-refresh.tsx',
  'packages/ui/src/dashboard-ui.tsx',
  'packages/ui/src/markdown.tsx',
  'packages/ui/src/task-detail.tsx',
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.turbo') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

const unconverted = new Set(UNCONVERTED);
const stillDirty = new Set<string>();
let scanned = 0;

for (const root of SCAN_ROOTS) {
  for (const file of sourceFiles(root)) {
    scanned += 1;
    const body = readFileSync(file, 'utf8');
    const broken = RULES.filter(r => r.re.test(body));
    if (broken.length > 0) stillDirty.add(file);
    if (unconverted.has(file)) continue;
    for (const rule of broken) {
      check(`${file}: ${rule.id}`, false, rule.why);
    }
  }
}

check('scanned the source tree', scanned > 0, `${scanned} files`);

// A ledger entry that no longer violates anything is stale, and a stale
// allowlist is how a temporary exception becomes permanent. Failing here is
// what forces the list to empty out as the sweep proceeds.
for (const file of UNCONVERTED) {
  check(
    `ledger entry still needed: ${file}`,
    stillDirty.has(file),
    existsSync(file)
      ? 'this file is clean now — delete it from UNCONVERTED'
      : 'this file no longer exists — delete it from UNCONVERTED',
  );
}

check(
  'the unconverted ledger only ever shrinks',
  stillDirty.size <= UNCONVERTED.length,
  `${stillDirty.size} dirty vs ${UNCONVERTED.length} listed`,
);

console.log(lines.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
