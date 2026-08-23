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
//   * a tap target under 44px, invisible until somebody wearing gloves misses.
//
// It reads packages/ui/src/tokens.css itself rather than duplicating the
// values, for the same reason cost-check.mts reads the live migration: a copy
// of the thing under test passes forever after the original changes.
//
// Run with `pnpm design-check`. Exit 0 = green, 1 = at least one failure.

import { readdirSync, readFileSync, statSync } from 'node:fs';
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

// tokens.css must never contain @utility: Tailwind silently discards the
// WHOLE imported file, with no error anywhere. Proven by spike 2026-08-23.
check(
  'tokens.css contains no @utility rule',
  !/@utility\b/.test(css),
  '@utility in an imported file makes Tailwind drop the entire file silently',
);

/** Every `--name: value;` inside the block opened by `selector {`. */
function block(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) return {};
  const open = css.indexOf('{', at);
  let depth = 0;
  let i = open;
  for (; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const out: Record<string, string> = {};
  for (const m of css.slice(open + 1, i).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const LIGHT = block(':root');
const DARK = block(':root.dark');

check('light theme block parsed', Object.keys(LIGHT).length > 10, `${Object.keys(LIGHT).length} tokens`);
check('dark theme block parsed', Object.keys(DARK).length > 10, `${Object.keys(DARK).length} tokens`);

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
];

for (const [themeName, theme] of [['light', LIGHT], ['dark', DARK]] as const) {
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

// --brand-vivid is the ONE colour that is legal as a fill and illegal behind
// text. Stating it as its own assertion means a future edit that "tidies" it
// into --brand's role fails loudly instead of reintroducing a 3.56:1 button.
for (const [themeName, theme] of [['light', LIGHT], ['dark', DARK]] as const) {
  const ratio = theme['--brand-vivid'] && theme['--on-brand']
    ? contrast(theme['--brand-vivid'], theme['--on-brand'])
    : null;
  check(
    `${themeName}: --brand-vivid is NOT safe behind --on-brand text`,
    ratio !== null && ratio < 4.5,
    ratio === null ? 'tokens missing' : `${ratio.toFixed(2)}:1 — if this ever passes, use --brand instead`,
  );
}

console.log(lines.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
