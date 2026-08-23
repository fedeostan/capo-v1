# Design System — Foundation & Component Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared token layer, the thirteen components, and the automated design contract that all 51 screens will later be converted onto — without changing how any existing screen looks except its typeface.

**Architecture:** One CSS file (`packages/ui/src/tokens.css`) declares every colour, size, spacing, radius, shadow and timing as a CSS custom property, and maps them to Tailwind utilities through `@theme inline`. Both apps import it, which ends the duplicated `:root` blocks. Ten components live in `@capo/ui` and need no browser JavaScript; three live in `apps/web` because they must react. A credential-free script, `pnpm design-check`, parses the token file, calculates every colour pair's WCAG contrast ratio, and denies raw palette classes outside an explicit shrinking ledger.

**Tech Stack:** Tailwind CSS 4.3.2 (`@theme inline`, `@custom-variant`), Next.js 16.2.10 App Router, React 19.2.4, TypeScript 5 (`strict`), `tsx` for the check script. **No new dependencies.**

**Spec:** [`docs/superpowers/specs/2026-08-23-design-system-design.md`](../specs/2026-08-23-design-system-design.md)

**Scope:** This plan implements spec **steps 0 and 1 only** — the foundation and the component library. Spec steps 2–8 (converting the 51 screens) get their own plan, written once these component APIs exist as code rather than as predictions. The commitment to the full sweep is unchanged; only the planning is staged.

## Global Constraints

- **No new npm dependencies.** Not one.
- **`packages/ui` stays `'use client'`-free.** Its file header declares this. The three interactive components go in `apps/web/app/_ui/` instead.
- **No `@utility` rule in `tokens.css`.** Proven by spike 2026-08-23: Tailwind silently discards the *entire imported file* — no error, no warning, every token gone. `@utility` works only in an app's own `globals.css`. This design needs none.
- **Text-colour tokens are `--fg`, `--fg-muted`, `--fg-faint`** — never `--text*`. Tailwind v4 owns `--text-*` as its font-size namespace; `--text-muted` would collide with the colour utility of the same name.
- **There is no `--duration-*` theme namespace.** Use `--default-transition-duration: 180ms` in `@theme` (a bare `transition-colors` then runs at 180ms), and `duration-(--duration-fast)` where another value is needed. Both measured working.
- **No custom tap-target utility.** `min-h-11 min-w-11` already means 44px.
- **`--background` aliases `--surface` (white), never `--bg`.** All 15 existing `bg-background` uses are on surfaces — sheets, inputs, the tab bar, the chat composer. Aliasing to the page colour would silently repaint every input field off-white.
- **Never put `--font-sans` / `--font-mono` in `tokens.css`.** `apps/operator` does not load Geist; a shared mapping to a variable it lacks would blank its font. Each app maps its own.
- **Every commit must leave `pnpm turbo lint typecheck build` green**, plus `pnpm design-check` from Task 1 onward.
- **Run the build gate serially.** Only one `next build` may run per workspace root at a time; a parallel worktree build deadlocks. And never `tail` a turbo failure — read the whole output.
- **Minimum sizes:** tappable ≥ 44px, primary actions 48px, no human-readable text below 13px.
- **Contrast floors:** 4.5:1 normal text, 3:1 large text and control borders.

## Invariants that must survive (from spec §6)

Any task touching these files must preserve, verbatim:

| File | Must survive |
|---|---|
| `apps/web/app/globals.css` | `html, body { overflow: hidden; overscroll-behavior: none }` and the `@custom-variant dark` **block** form |
| `apps/web/app/(app)/layout.tsx` | the two banners staying **siblings** of the `overflow-hidden` column |
| `apps/web/app/bottom-nav.tsx` | `pb-[env(safe-area-inset-bottom)]` |
| `apps/web/app/layout.tsx` | `pt-[env(safe-area-inset-top)]`, single-value `viewport.themeColor` |
| `packages/ui/src/dashboard-ui.tsx` | `ScreenShell` owning no scroller |

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `packages/ui/src/tokens.css` | Every design value, once. Imported by both apps. |
| `packages/ui/src/button.tsx` | `Button`, `ButtonLink`, `IconButton` + their variant/size maps |
| `packages/ui/src/card.tsx` | `Card` — the level-1 container |
| `packages/ui/src/list-row.tsx` | `ListRow` — tappable row with leading/trailing slots |
| `packages/ui/src/field.tsx` | `Field`, `Input`, `Select`, `Textarea` — label/hint/error wiring |
| `packages/ui/src/badge.tsx` | `Badge` + its tone map |
| `packages/ui/src/banner.tsx` | `Banner` — the full-width shell strips |
| `packages/ui/src/empty-state.tsx` | `EmptyState` |
| `packages/ui/src/skeleton.tsx` | `Skeleton` |
| `packages/ui/src/app-bar.tsx` | `AppBar` — sticky translucent header |
| `apps/web/app/_ui/sheet.tsx` | `Sheet` — focus trap, Escape, scroll lock, animation |
| `apps/web/app/_ui/segmented-control.tsx` | `SegmentedControl` — replaces four pill implementations |
| `apps/web/app/_ui/tab-bar.tsx` | `TabBar` — two-signal active state |
| `apps/web/app/_design/page.tsx` | Component gallery, dev-only |
| `apps/web/app/_design/screens/page.tsx` | Real screens on fake data, dev-only |
| `apps/web/app/_design/fixtures.ts` | The static sample data |
| `scripts/design-check.mts` | The machine-checked design contract |

**Modified**

| File | Change |
|---|---|
| `apps/web/app/globals.css` | import tokens; delete the Arial line; `body` uses `--bg` |
| `apps/operator/app/globals.css` | import tokens; delete its duplicate `:root` and `@theme inline` |
| `packages/ui/package.json` | export the new modules |
| `package.json` | add the `design-check` script |
| `.github/workflows/ci.yml` | add the `design-check` step |
| `AGENTS.md` | document the design system's invariants |

**Untouched by this plan:** every screen, every server action, every route handler, `packages/core`, `packages/db`, `packages/i18n`, every migration.

---

### Task 1: The design contract, failing

Write the check before the thing it checks. In this repo the "test framework" is a plain assertion script — `check(name, ok, detail)` accumulating into `failures`, then `process.exit`. Match `scripts/push-check.mts` exactly.

**Files:**
- Create: `scripts/design-check.mts`
- Modify: `package.json` (scripts), `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing
- Produces: `pnpm design-check` — exit 0 green, 1 red. Task 2 makes it pass. Task 4 extends it.

- [ ] **Step 1: Write the check script**

Create `scripts/design-check.mts`:

```ts
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
```

- [ ] **Step 2: Add the script to package.json**

In the root `package.json`, add after `"cost-check"`:

```json
    "design-check": "tsx scripts/design-check.mts",
```

- [ ] **Step 3: Run it and verify it FAILS**

Run: `pnpm design-check`

Expected: `FAIL  packages/ui/src/tokens.css exists — file not found`, then `1 FAILURE(S)`, exit code 1.

Confirm the exit code:

```bash
pnpm design-check; echo "exit=$?"
```

Expected: `exit=1`.

- [ ] **Step 4: Wire it into CI**

In `.github/workflows/ci.yml`, after the **`Memory consolidation check`** step — verified to be the last one in the file — add:

```yaml
      # The design contract: every colour pair's WCAG contrast ratio, computed
      # from packages/ui/src/tokens.css itself, plus the ban on raw palette
      # classes outside the shrinking ledger. Credential-free, so it runs on
      # every PR. It exists because the primary button shipped at 3.56:1 and
      # nothing anywhere could notice.
      - name: Design system contract
        run: pnpm design-check
```

- [ ] **Step 5: Commit**

```bash
git add scripts/design-check.mts package.json .github/workflows/ci.yml
git commit -m "test(design): design contract script, red until tokens.css exists

Computes every colour pair's WCAG ratio from the token file itself rather
than from a copy, for the same reason cost-check reads the live migration.
Currently fails: tokens.css does not exist yet."
```

---

### Task 2: The token layer, making the contract pass

**Files:**
- Create: `packages/ui/src/tokens.css`

**Interfaces:**
- Consumes: `pnpm design-check` from Task 1
- Produces: CSS custom properties `--bg --surface --surface-sunken --surface-hover --fg --fg-muted --fg-faint --hairline --border-control --brand --brand-hover --brand-vivid --brand-quiet --on-brand --focus --danger --warn --success --info --review` (+ `-quiet` variants), `--duration-fast|base|slow`, and the aliases `--background --foreground`. Tailwind utilities: `bg-* text-* border-*` for each colour; `text-display|title|heading|body|callout|caption|micro`; `rounded-chip|control|card|sheet`; `shadow-float|sheet`; `ease-out|ease-spring`.

- [ ] **Step 1: Write the token file**

Create `packages/ui/src/tokens.css`:

```css
/* The single source of every design decision in Capo, imported by BOTH apps.
   Before this file, apps/web and apps/operator each declared their own
   --background/--foreground, which is two copies of one rule and therefore an
   eventual disagreement.

   THREE RULES, all proven by spike on 2026-08-23, and all of which fail
   SILENTLY if broken:

   1. NO @utility in this file, ever. Tailwind discards the ENTIRE imported
      file when it finds one — no error, no warning, every token below simply
      gone. @utility only works in an app's own globals.css. Nothing here
      needs one: `min-h-11 min-w-11` is already 44px.

   2. Text colours are --fg*, never --text*. Tailwind v4 owns --text-* as its
      FONT-SIZE namespace, so --text-muted would generate a font-size utility
      called `text-muted` and collide with the colour of the same name.

   3. No --font-sans/--font-mono here. apps/operator does not load Geist, so a
      shared mapping to a variable it lacks would blank its typeface. Each app
      maps its own fonts in its own globals.css.

   Contrast ratios below are asserted by `pnpm design-check`, which parses this
   file. Changing a hex without running it is how the 3.56:1 primary button
   survived for the life of the product. */

:root {
  /* ── Surfaces ─────────────────────────────────────────────────────────
     The page is warm off-white and cards are pure white, which is what makes
     a card read as an object rather than a region. Warm rather than cool
     because the brand is orange; cool grey beside orange looks dirty. */
  --bg: #fafaf9;
  --surface: #ffffff;
  --surface-sunken: #f5f5f4;
  --surface-hover: rgb(28 25 23 / 0.04);

  /* ── Ink ──────────────────────────────────────────────────────────────
     --fg-muted is 7.63:1, not the 4.83:1 it replaced. Secondary text is the
     first thing to disappear on a phone in sunlight, which is most of the
     time Capo is actually read. */
  --fg: #1c1917;        /* 17.49:1 on --surface */
  --fg-muted: #57534e;  /*  7.63:1 */
  --fg-faint: #78716c;  /*  4.80:1 */

  /* ── Lines ────────────────────────────────────────────────────────────
     Two borders with different jobs. --hairline is decoration between rows,
     so no contrast rule applies. --border-control is the outline of an input
     and is the ONLY signal that a box is typeable, which is why WCAG 1.4.11
     demands 3:1 of it — and why the old zinc-500/30 (~1.8:1) failed. */
  --hairline: #e7e5e4;
  --border-control: #78716c;  /* 4.80:1 on --surface */

  /* ── Brand ────────────────────────────────────────────────────────────
     --brand is one step darker than the historic #ea580c so that white text
     on it clears 4.5:1 (5.18 vs 3.56). --brand-vivid keeps the original for
     LARGE NON-TEXT fills only, where the requirement is 3:1 and the brighter
     orange is the one people recognise. design-check asserts vivid stays
     unsafe behind text, so nobody can quietly promote it back. */
  --brand: #c2410c;
  --brand-hover: #9a3412;
  --brand-vivid: #ea580c;
  --brand-quiet: rgb(194 65 12 / 0.10);
  --on-brand: #ffffff;
  --focus: #c2410c;

  /* ── Status ───────────────────────────────────────────────────────────
     --review is violet deliberately: a completion claim awaiting the manager
     is a decision to make, not a problem to fix. --danger owns "wrong". */
  --danger: #b91c1c;   --danger-quiet: rgb(185 28 28 / 0.10);
  --warn: #b45309;     --warn-quiet: rgb(180 83 9 / 0.10);
  --success: #15803d;  --success-quiet: rgb(21 128 61 / 0.10);
  --info: #1d4ed8;     --info-quiet: rgb(29 78 216 / 0.10);
  --review: #6d28d9;   --review-quiet: rgb(109 40 217 / 0.10);

  /* ── Motion ───────────────────────────────────────────────────────────
     Read with `duration-(--duration-fast)`. There is NO --duration-*
     theme namespace in Tailwind 4.3.2, so `duration-fast` is not a utility
     and would fail silently; the @theme block below sets the DEFAULT instead,
     so a bare `transition-colors` is already 180ms. */
  --duration-fast: 120ms;
  --duration-base: 180ms;
  --duration-slow: 260ms;

  /* ── Compatibility aliases ────────────────────────────────────────────
     Every existing `bg-background` in the codebase is on a SURFACE — a bottom
     sheet, an input, the tab bar, the chat composer — and never on the page.
     So --background aliases --surface, NOT --bg. Aliasing it to the page
     colour would silently repaint all fifteen of them off-white, input fields
     included, in a commit that claimed to change nothing. */
  --background: var(--surface);
  --foreground: var(--fg);

  /* Inherited, so it reaches what Tailwind cannot paint: native form
     controls, scrollbars, the UA canvas. */
  color-scheme: light;
}

/* (0,2,0) so it beats :root above. Mutually exclusive by class with the
   .system block below, so their relative order does not matter. There is
   deliberately no bare `:root:not(.light)` fallback — an unstamped root must
   resolve to LIGHT, because light is the default and not the fallback. */
:root.dark {
  --bg: #0c0a09;
  --surface: #1c1917;
  --surface-sunken: #121110;
  --surface-hover: rgb(250 250 249 / 0.06);

  --fg: #fafaf9;        /* 16.74:1 on --surface */
  --fg-muted: #a8a29e;  /*  6.93:1 */
  --fg-faint: #8c8781;  /*  4.91:1 */

  --hairline: #292524;
  --border-control: #78716c;  /* 3.65:1 on --surface */

  /* --on-brand INVERTS here. White on orange-400 is 2.26:1 — worse than the
     bug this whole design exists to fix. Near-black on it is 7.73:1. */
  --brand: #fb923c;
  --brand-hover: #fdba74;
  --brand-vivid: #ea580c;
  --brand-quiet: rgb(251 146 60 / 0.15);
  --on-brand: #1c1917;
  --focus: #fb923c;

  --danger: #f87171;   --danger-quiet: rgb(248 113 113 / 0.15);
  --warn: #fbbf24;     --warn-quiet: rgb(251 191 36 / 0.15);
  --success: #4ade80;  --success-quiet: rgb(74 222 128 / 0.15);
  --info: #60a5fa;     --info-quiet: rgb(96 165 250 / 0.15);
  --review: #a78bfa;   --review-quiet: rgb(167 139 250 / 0.15);

  color-scheme: dark;
}

/* Only `.system` consults the OS. apps/operator never stamps a theme class at
   all, so both this and :root.dark are inert there and it stays light. */
@media (prefers-color-scheme: dark) {
  :root.system {
    --bg: #0c0a09;
    --surface: #1c1917;
    --surface-sunken: #121110;
    --surface-hover: rgb(250 250 249 / 0.06);

    --fg: #fafaf9;
    --fg-muted: #a8a29e;
    --fg-faint: #8c8781;

    --hairline: #292524;
    --border-control: #78716c;

    --brand: #fb923c;
    --brand-hover: #fdba74;
    --brand-vivid: #ea580c;
    --brand-quiet: rgb(251 146 60 / 0.15);
    --on-brand: #1c1917;
    --focus: #fb923c;

    --danger: #f87171;   --danger-quiet: rgb(248 113 113 / 0.15);
    --warn: #fbbf24;     --warn-quiet: rgb(251 191 36 / 0.15);
    --success: #4ade80;  --success-quiet: rgb(74 222 128 / 0.15);
    --info: #60a5fa;     --info-quiet: rgb(96 165 250 / 0.15);
    --review: #a78bfa;   --review-quiet: rgb(167 139 250 / 0.15);

    color-scheme: dark;
  }
}

/* `inline` is what makes each utility resolve var(--x) AT USE TIME, so it
   follows the theme class rather than freezing the light value. */
@theme inline {
  /* Colours → bg-*, text-*, border-*, ring-* */
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-surface-sunken: var(--surface-sunken);
  --color-surface-hover: var(--surface-hover);
  --color-fg: var(--fg);
  --color-fg-muted: var(--fg-muted);
  --color-fg-faint: var(--fg-faint);
  --color-hairline: var(--hairline);
  --color-control: var(--border-control);
  --color-brand: var(--brand);
  --color-brand-hover: var(--brand-hover);
  --color-brand-vivid: var(--brand-vivid);
  --color-brand-quiet: var(--brand-quiet);
  --color-on-brand: var(--on-brand);
  --color-focus: var(--focus);
  --color-danger: var(--danger);
  --color-danger-quiet: var(--danger-quiet);
  --color-warn: var(--warn);
  --color-warn-quiet: var(--warn-quiet);
  --color-success: var(--success);
  --color-success-quiet: var(--success-quiet);
  --color-info: var(--info);
  --color-info-quiet: var(--info-quiet);
  --color-review: var(--review);
  --color-review-quiet: var(--review-quiet);
  --color-background: var(--background);
  --color-foreground: var(--foreground);

  /* Type → text-display … text-micro. The floor is 13px: nothing a human
     reads is smaller. --text-micro is 11px and is for BADGES only, which are
     read as shapes rather than as sentences. */
  --text-display: 2rem;        --text-display--line-height: 2.25rem;
  --text-title: 1.375rem;      --text-title--line-height: 1.75rem;
  --text-heading: 1.0625rem;   --text-heading--line-height: 1.5rem;
  --text-body: 1rem;           --text-body--line-height: 1.5rem;
  --text-callout: 0.9375rem;   --text-callout--line-height: 1.25rem;
  --text-caption: 0.8125rem;   --text-caption--line-height: 1.125rem;
  --text-micro: 0.6875rem;     --text-micro--line-height: 0.875rem;

  /* Radius → rounded-chip … rounded-sheet. Nested radius = outer minus
     padding, so a button inside a card looks concentric, not accidental. */
  --radius-chip: 0.5rem;
  --radius-control: 0.75rem;
  --radius-card: 1rem;
  --radius-sheet: 1.25rem;

  /* Depth → shadow-float, shadow-sheet. Level 1 (cards) is a hairline and NO
     shadow: structure first, shadow only when something genuinely floats.
     Both are near-invisible on a dark background, which is why dark mode
     communicates depth by lifting --surface instead. */
  --shadow-float: 0 1px 2px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.04);
  --shadow-sheet: 0 8px 24px rgb(0 0 0 / 0.12), 0 2px 6px rgb(0 0 0 / 0.06);

  /* Motion. Overriding --ease-out replaces Tailwind's built-in `ease-out`
     everywhere, which is intended — one curve for the whole product.
     --default-transition-duration is a real Tailwind key: setting it means a
     bare `transition-colors` already runs at 180ms with no duration class. */
  --ease-out: cubic-bezier(0.2, 0, 0, 1);
  --ease-spring: cubic-bezier(0.34, 1.3, 0.64, 1);
  --default-transition-duration: 180ms;
  --default-transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
}

/* Reduce Motion is an accessibility setting many older users turn on without
   knowing they did. Collapsing the durations here means no component has to
   know it exists. Not 0s: a 0.01ms transition still FIRES its transitionend
   event, so JavaScript waiting on one does not hang. */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 2: Run the contract and verify it PASSES**

Run: `pnpm design-check`

Expected: every line `PASS`, ending `ALL PASS`, exit 0. Specifically confirm these appear and pass:

```
PASS  light: --on-brand on --brand (the primary button label) — 5.18:1, need 4.5:1
PASS  light: --border-control on --surface (the edge of an input) — 4.80:1, need 3:1
PASS  dark: --on-brand on --brand (the primary button label) — 7.73:1, need 4.5:1
PASS  light: --brand-vivid is NOT safe behind --on-brand text — 3.56:1
PASS  tokens.css contains no @utility rule
```

- [ ] **Step 3: Prove the check can actually fail**

This matters: a check that cannot go red is decoration. Temporarily set `--brand: #ea580c;` in the `:root` block, run `pnpm design-check`, and confirm:

```
FAIL  light: --on-brand on --brand (the primary button label) — 3.56:1, need 4.5:1
```

Then **restore `--brand: #c2410c;`** and re-run until `ALL PASS`.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/tokens.css
git commit -m "feat(design): the token layer — one file, both apps

Roles rather than shades, so dark mode is one block instead of 51 screens
of patches. Every ratio asserted by pnpm design-check, which parses this
file rather than a copy of it.

Three silent traps recorded in the header: no @utility (Tailwind discards
the whole imported file), --fg not --text (Tailwind owns the --text-*
namespace for font sizes), and no --font-sans (operator has no Geist).

--background aliases --surface, not --bg: all fifteen existing
bg-background uses are on sheets, inputs and the tab bar, never the page."
```

---

### Task 3: Wire both apps, and delete Arial

The moment the whole product stops looking like 2005. One line does most of it.

**Files:**
- Modify: `apps/web/app/globals.css`, `apps/operator/app/globals.css`

**Interfaces:**
- Consumes: `packages/ui/src/tokens.css` from Task 2
- Produces: every token available as a Tailwind utility in both apps; `body` painted with `--bg`

- [ ] **Step 1: Rewrite `apps/web/app/globals.css`**

Replace the whole file with this. The `@custom-variant dark` block and the `html, body` overflow rules are copied **verbatim** — they are load-bearing and their comments explain why.

```css
@import "tailwindcss";

/* The design system's single source of truth, shared with apps/operator.
   Must come before anything that consumes a token. */
@import "../../../packages/ui/src/tokens.css";

/* Tailwind v4 auto-detects sources only inside this app — workspace packages
   must be declared or their classes vanish from the built CSS. This is a
   DIRECTORY glob, so new component files inside it need no edit here; a
   component placed outside it would silently lose every style. */
@source "../../../packages/ui/src";

/* Three appearance states, stamped onto <html> by the root layout from the
   capo_theme cookie: `light` (the default), `dark`, and `system`. Only
   `system` consults the OS — see lib/theme.ts for the other half of this.

   Tailwind v4's built-in `dark:` is a MEDIA QUERY, so it would keep following
   the OS while the variables below followed the cookie. Redefining it here is
   what keeps the ~16 existing `dark:` utilities in step.

   The block form is load-bearing. The selector form —
   `@custom-variant dark (&:where(.dark, .dark *), @media (…))` — emits its
   entries as SIBLINGS, so the media branch fires unconditionally and an
   explicit `.light` root would still pick up dark utilities. Only the block
   form can nest the selector INSIDE the media query. Every branch needs its
   own @slot; a branch missing one silently drops the declarations. */
@custom-variant dark {
  &:where(.dark, .dark *) {
    @slot;
  }
  @media (prefers-color-scheme: dark) {
    &:where(.system, .system *) {
      @slot;
    }
  }
}

/* Fonts are mapped per app, never in tokens.css: apps/operator does not load
   Geist, so a shared mapping to a variable it lacks would blank its type. */
@theme inline {
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

/* The page is --bg (warm off-white) while cards are --surface (white). That
   difference is what makes a card read as an object rather than a region.
   font-family is DELETED here: it used to say `Arial, Helvetica, sans-serif`,
   which is a direct declaration on body and therefore beat the inherited
   --font-geist-sans, so every word in the product rendered in a 1982 typeface
   while Geist was loaded and thrown away. */
body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
}

/* This is an app shell, not a document. Without these two lines the whole UI
   drags on a touch gesture — header and tab bar included — because the tab bar
   is a static flex child of <body>, not a fixed element. Two separate leaks:
   a route with no inner scroller overflows the h-dvh body and scrolls the
   *document*, and even a route that scrolls internally rubber-bands at the
   root. overflow:hidden removes the document scroll port; overscroll-behavior
   kills the rubber-band (and, as a bonus, Chrome's native pull-to-refresh, so
   ours is the only one). Every scroller inside must opt back in with
   `overscroll-contain`. */
html,
body {
  overflow: hidden;
  overscroll-behavior: none;
}
```

- [ ] **Step 2: Rewrite `apps/operator/app/globals.css`**

```css
@import "tailwindcss";

/* Shared with apps/web. Before this import, operator declared its own
   --background/--foreground — two copies of one rule, and therefore an
   eventual disagreement. */
@import "../../../packages/ui/src/tokens.css";

/* Tailwind v4 auto-detects sources only inside this app — workspace packages
   must be declared or their classes vanish from the built CSS. */
@source "../../../packages/ui/src";

/* Operator is pinned to LIGHT — an internal tool with no preference to store,
   so it gets no cookie, no toggle, and no dynamic rendering. It never stamps
   a theme class, so tokens.css's :root.dark and :root.system blocks are inert
   here and the light values apply.

   This redefinition is not cosmetic. Tailwind v4's built-in `dark:` is a media
   query, and packages/ui is compiled into this app, so without it any `dark:`
   utility in the shared components would fire on an OS-dark machine while the
   background below stayed white. The class is never applied, so the variant
   never matches. */
@custom-variant dark (&:where(.dark, .dark *));

body {
  background: var(--bg);
  color: var(--fg);
}
```

- [ ] **Step 3: Verify the typeface actually changed**

Start the dev server and measure the rendered font rather than trusting the import:

```bash
pnpm --filter web dev
```

Then in the browser at `http://localhost:3000/landing`, in the developer console:

```js
getComputedStyle(document.body).fontFamily
```

Expected: a string beginning with the Geist family (e.g. `"Geist", ...`), **not** `Arial`.

And confirm the page/card split took effect:

```js
JSON.stringify({
  page: getComputedStyle(document.body).backgroundColor,
  bgVar: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  surfaceVar: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
})
```

Expected: `page` is `rgb(250, 250, 249)`, `bgVar` is `#fafaf9`, `surfaceVar` is `#ffffff`.

- [ ] **Step 4: Verify nothing broke**

Run the full gate, serially, and read all of the output:

```bash
pnpm turbo lint typecheck build
```

Expected: green for `web`, `operator`, `@capo/ui`, `@capo/core`, `@capo/db`, `@capo/i18n`.

Then:

```bash
pnpm design-check
```

Expected: `ALL PASS`.

- [ ] **Step 5: Screenshot the before/after for the record**

Capture `/landing` and `/login` at 375px wide, light and dark. These are the only two visual references that exist before the screens are converted, and they are what proves step 0 did what it claimed.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/globals.css apps/operator/app/globals.css
git commit -m "feat(design): both apps import the tokens, and Arial is gone

body { font-family: Arial } was a direct declaration and therefore beat the
inherited --font-geist-sans, so every word in Capo rendered in a 1982
typeface while Geist was loaded and discarded. Deleting that one line is
the single largest visual change in this project.

body now paints --bg (warm off-white) while cards paint --surface (white),
which is what makes a card read as an object rather than a region.

operator loses its duplicate :root and @theme inline. The @custom-variant
dark block form and the html/body overflow rules are carried across
verbatim — both are load-bearing and both fail silently."
```

---

### Task 4: The denylist rules and the shrinking ledger

The contrast rules from Task 1 protect the tokens. These protect the *usage* — and they are what stop the fifteen-button-spellings problem coming back.

**Files:**
- Modify: `scripts/design-check.mts`

**Interfaces:**
- Consumes: `check()` and the file from Task 1
- Produces: the `UNCONVERTED` ledger, which every later screen-conversion task removes entries from

- [ ] **Step 1: Append the denylist section to `scripts/design-check.mts`**

Insert immediately **before** the final three lines (`console.log(lines.join(...))` onward):

```ts
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
    re: /\b(?:text|bg|border|ring|from|to|via|decoration|outline|divide|placeholder)-(?:zinc|gray|neutral|slate|stone|orange|red|amber|emerald|green|violet|blue|sky|yellow|black|white)(?:-\d{2,3})?(?:\/\d{1,3})?\b/,
    why: 'raw palette colour — use a role token (bg-surface, text-fg-muted, border-control…)',
  },
  {
    id: 'arbitrary-text-size',
    re: /\btext-\[\d+px\]/,
    why: 'arbitrary text size — use the scale (text-body, text-caption, text-micro…)',
  },
  {
    id: 'off-scale-spacing',
    re: /\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|gap|gap-x|gap-y|space-x|space-y)-(?:0\.5|1\.5|2\.5|3\.5|5|7|9|10|11|14)\b/,
    why: 'spacing step outside 1/2/3/4/6/8/12/16 (4/8/12/16/24/32/48/64px)',
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
    'this file is clean now — delete it from UNCONVERTED',
  );
}

check(
  'the unconverted ledger only ever shrinks',
  stillDirty.size <= UNCONVERTED.length,
  `${stillDirty.size} dirty vs ${UNCONVERTED.length} listed`,
);
```

- [ ] **Step 2: Run it and verify it passes**

Run: `pnpm design-check`

Expected: `ALL PASS`. Every currently-dirty file is in the ledger, and every ledger entry is currently dirty, so both directions balance.

- [ ] **Step 3: Prove both directions of the ledger can fail**

First, prove a *new* violation is caught. Temporarily add `className="text-zinc-500"` to any file **not** in the ledger — `apps/web/app/layout.tsx` works — and run `pnpm design-check`.

Expected: `FAIL  apps/web/app/layout.tsx: raw-palette`. Then revert.

Second, prove a *stale entry* is caught. Temporarily add `'apps/web/app/layout.tsx'` to `UNCONVERTED` and run.

Expected: `FAIL  ledger entry still needed: apps/web/app/layout.tsx — this file is clean now`. Then revert and re-run until `ALL PASS`.

- [ ] **Step 4: Commit**

```bash
git add scripts/design-check.mts
git commit -m "test(design): deny raw palette classes outside a shrinking ledger

The contrast rules protect the tokens; these protect their use. Without
them a screen can quietly return to border-zinc-500/30 while every contrast
check stays green — which is how fifteen spellings of one button happened.

UNCONVERTED lists the 56 files not yet swept. It may only shrink, and a
STALE entry fails too: an allowlist nobody prunes is how a temporary
exception becomes permanent, and this ledger is meant to be the remaining
work written down."
```

---

### Task 5: Button, ButtonLink, IconButton

The component that absorbs fifteen hand-written class strings, and the one carrying the highest-value rule in the design.

**Files:**
- Create: `packages/ui/src/button.tsx`
- Modify: `packages/ui/package.json` (exports)

**Interfaces:**
- Consumes: the tokens from Task 2
- Produces:
  - `type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'destructive'`
  - `type ButtonSize = 'sm' | 'md' | 'lg'`
  - `Button(props: ButtonProps)` where `ButtonProps = Omit<ComponentProps<'button'>, 'className'> & { variant?: ButtonVariant; size?: ButtonSize; loading?: boolean; fullWidth?: boolean; icon?: ReactNode }`
  - `ButtonLink(props)` — same visual props over `ComponentProps<'a'>`, plus required `href: string`
  - `IconButton(props)` — `ComponentProps<'button'> & { label: string; icon: ReactNode; variant?: ButtonVariant; size?: ButtonSize }`; **`label` is required**
  - `buttonClasses(variant, size, fullWidth)` — the shared surface `Button` and `ButtonLink` are both built from, exported so a future variant is composed rather than re-spelled

- [ ] **Step 1: Write the component**

Create `packages/ui/src/button.tsx`:

```tsx
// The button, in four levels. Before this file there were fifteen distinct
// hand-written class strings for the primary button alone, differing in
// padding, text size and which pseudo-states they bothered with.
//
// `className` is deliberately OMITTED from every props type. A component that
// accepts arbitrary classes is a component that will be overridden into a
// sixteenth variant within a month, and `tsc` refusing the prop is the only
// thing that reliably prevents it. If a caller genuinely needs something new,
// it belongs here as a variant.
//
// No 'use client': every state below — press, hover, focus, disabled — is
// pure CSS, so this renders on the server and ships no JavaScript.
import type { ComponentProps, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * THE RULE: at most one `primary` per screen.
 *
 * Not a style guide — the reason the hierarchy works at all. Three solid
 * orange buttons force the manager to read all three to find the one he wants.
 * One solid button means he does not read at all, he just taps. Everything
 * else on the screen being quiet is what buys that.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-on-brand hover:bg-brand-hover',
  secondary: 'bg-surface text-fg border border-control hover:bg-surface-hover',
  tertiary: 'bg-transparent text-fg hover:bg-surface-hover',
  // Outlined at rest, on purpose. A solid red button is for the FINAL confirm
  // inside a sheet, never for the resting state of a screen — a destructive
  // action should not be the loudest thing a tired person sees.
  destructive: 'bg-surface text-danger border border-danger hover:bg-danger-quiet',
};

// 44px is the floor (Apple HIG / Material), 48px the primary-action size.
// A man in work gloves is the design target, not a mouse pointer.
const SIZE: Record<ButtonSize, string> = {
  sm: 'min-h-11 px-3 gap-2 text-callout',
  md: 'min-h-12 px-4 gap-2 text-body',
  lg: 'min-h-14 px-6 gap-2 text-body',
};

const BASE = [
  // `relative` is the spinner's positioning context — it is absolutely
  // positioned so the label can stay in the tree and hold the width.
  'relative inline-flex items-center justify-center rounded-control font-semibold',
  'select-none no-underline',
  // 120ms, fast start and gentle stop. `transition` alone would already be
  // 180ms from --default-transition-duration; the press wants to be quicker.
  'transition-[background-color,transform,box-shadow] duration-(--duration-fast) ease-out',
  'active:scale-[0.97]',
  // focus-visible, never focus: this must appear for keyboard users and never
  // flash on a touch tap. Before this component, one file in the entire app
  // had a focus style at all.
  'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
  'disabled:pointer-events-none disabled:opacity-50',
].join(' ');

export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  fullWidth = false,
): string {
  return `${BASE} ${VARIANT[variant]} ${SIZE[size]} ${fullWidth ? 'w-full' : ''}`;
}

/** A spinner that occupies the label's place without resizing the button. */
function Spinner() {
  return (
    <span
      aria-hidden
      className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

export type ButtonProps = Omit<ComponentProps<'button'>, 'className'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  icon?: ReactNode;
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  icon,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses(variant, size, fullWidth)}
    >
      {/* The label stays in the tree while loading, hidden and zero-opacity,
          so the button keeps its exact rendered width. Swapping the label out
          for a spinner makes the button shrink and the layout jump under the
          thumb that just tapped it — on a form where Guardar is the last
          control, that moves the page while the manager is still looking. */}
      <span className={`inline-flex items-center gap-2 ${loading ? 'invisible' : ''}`}>
        {icon}
        {children}
      </span>
      {loading && <span className="absolute inline-flex"><Spinner /></span>}
    </button>
  );
}

export type ButtonLinkProps = Omit<ComponentProps<'a'>, 'className'> & {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  icon?: ReactNode;
};

/** The same surface over an anchor. Deliberately a plain <a> rather than
 *  next/link: @capo/ui is shared with apps/operator and must not depend on a
 *  router. Callers inside apps/web wrap it or pass a next/link `href` — a
 *  same-origin href in this app is handled by the App Router regardless. */
export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  icon,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <a {...rest} className={buttonClasses(variant, size, fullWidth)}>
      {icon}
      {children}
    </a>
  );
}

export type IconButtonProps = Omit<ComponentProps<'button'>, 'className' | 'children'> & {
  /** Spoken by a screen reader. REQUIRED, and that is a design decision
   *  enforced by the compiler: an unlabelled icon button is invisible to a
   *  blind user, and making the label a required prop turns a code review
   *  somebody has to remember into a build failure they cannot miss. */
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function IconButton({ label, icon, variant = 'tertiary', size = 'md', ...rest }: IconButtonProps) {
  const square = size === 'sm' ? 'h-11 w-11' : size === 'lg' ? 'h-14 w-14' : 'h-12 w-12';
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={`${BASE} ${VARIANT[variant]} ${square} shrink-0 p-0`}
    >
      {icon}
    </button>
  );
}
```

- [ ] **Step 2: Export the module**

In `packages/ui/package.json`, add to `exports`:

```json
    "./button": "./src/button.tsx",
```

- [ ] **Step 3: Verify it compiles and obeys the contract**

```bash
pnpm --filter @capo/ui typecheck
```

Expected: no errors.

```bash
pnpm design-check
```

Expected: `ALL PASS`. `button.tsx` is **not** in `UNCONVERTED`, so any raw palette class in it fails the build — that is the point.

- [ ] **Step 4: Prove the required label is enforced**

Temporarily add this to `button.tsx` and confirm `tsc` refuses it:

```tsx
const broken = <IconButton icon={null} />;
```

Run: `pnpm --filter @capo/ui typecheck`
Expected: `error TS2741: Property 'label' is missing`.

Then **delete the line** and re-run until clean.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/button.tsx packages/ui/package.json
git commit -m "feat(ui): Button, ButtonLink, IconButton

Four levels with meanings attached: at most one primary per screen, which
is what makes a screen fast to read. Destructive is outlined at rest —
solid red belongs on a final confirm, not on the loudest thing a tired
person sees.

className is omitted from every props type on purpose. A component that
accepts arbitrary classes becomes a sixteenth variant within a month, and
tsc refusing the prop is the only thing that reliably stops it.

IconButton.label is REQUIRED: an unlabelled icon button is invisible to a
blind user, and a required prop turns a review somebody has to remember
into a build failure they cannot miss.

Loading keeps the label in the tree, invisible, so the button holds its
width and the layout does not jump under the thumb that just tapped it.

No 'use client' — every state is CSS, so this ships no JavaScript."
```

---

### Task 6: Card and ListRow

**Files:**
- Create: `packages/ui/src/card.tsx`, `packages/ui/src/list-row.tsx`
- Modify: `packages/ui/package.json`

**Interfaces:**
- Consumes: tokens from Task 2
- Produces:
  - `Card(props: { padding?: 'none' | 'sm' | 'md'; as?: 'div' | 'section' | 'article'; children: ReactNode })`
  - `ListRow(props: { leading?: ReactNode; title: ReactNode; meta?: ReactNode; trailing?: ReactNode; href?: string; onClick?: () => void; danger?: boolean })`

- [ ] **Step 1: Write `packages/ui/src/card.tsx`**

```tsx
// Level 1 of the three depth levels: a hairline border and NO shadow.
// Structure first; a shadow is for something that genuinely floats above
// something else (shadow-float on a sticky header, shadow-sheet on a sheet).
// Before this file the card was spelled five different ways.
import type { ReactNode } from 'react';

const PADDING = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
} as const;

export function Card({
  padding = 'md',
  as: Tag = 'div',
  children,
}: {
  padding?: keyof typeof PADDING;
  as?: 'div' | 'section' | 'article';
  children: ReactNode;
}) {
  return (
    <Tag className={`rounded-card border border-hairline bg-surface ${PADDING[padding]}`}>
      {children}
    </Tag>
  );
}
```

- [ ] **Step 2: Write `packages/ui/src/list-row.tsx`**

```tsx
// The row that every list screen currently builds by hand. 56px minimum, and
// the WHOLE row is the target — not the title inside it, which is how a row
// ends up needing three attempts to hit on a moving van.
import type { ReactNode } from 'react';

function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-4 w-4 shrink-0 text-fg-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

export function ListRow({
  leading,
  title,
  meta,
  trailing,
  href,
  danger = false,
}: {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  /** When present the row renders as a link and gains a chevron. */
  href?: string;
  danger?: boolean;
}) {
  const inner = (
    <>
      {leading && <span className="shrink-0">{leading}</span>}
      {/* min-w-0 is what lets a long task title truncate instead of forcing
          the row wider than the screen — a flex child defaults to min-width
          auto, which refuses to shrink below its content. */}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={`truncate text-body font-medium ${danger ? 'text-danger' : 'text-fg'}`}>
          {title}
        </span>
        {meta && <span className="truncate text-caption text-fg-muted">{meta}</span>}
      </span>
      {trailing}
      {href && <Chevron />}
    </>
  );

  const classes = [
    'flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left no-underline',
    'transition-colors ease-out hover:bg-surface-hover',
    'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
  ].join(' ');

  if (href) {
    return (
      <a href={href} className={classes}>
        {inner}
      </a>
    );
  }
  return <div className={classes}>{inner}</div>;
}
```

- [ ] **Step 3: Export both**

In `packages/ui/package.json` `exports`:

```json
    "./card": "./src/card.tsx",
    "./list-row": "./src/list-row.tsx",
```

- [ ] **Step 4: Verify**

```bash
pnpm --filter @capo/ui typecheck && pnpm design-check
```

Expected: no type errors, `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/card.tsx packages/ui/src/list-row.tsx packages/ui/package.json
git commit -m "feat(ui): Card and ListRow

Card is depth level 1 — hairline, no shadow. Structure first; a shadow is
for something that genuinely floats. It replaces five spellings of the same
container.

ListRow makes the WHOLE row the target at 56px, not the title inside it,
which is how a row ends up needing three attempts to hit in a moving van.
min-w-0 on the text column is what lets a long title truncate rather than
forcing the row wider than the phone."
```

---

### Task 7: Field, Input, Select, Textarea

28 inputs and 22 labels are currently wired by hand, inconsistently. This is where the 1.8:1 border failure gets fixed.

**Files:**
- Create: `packages/ui/src/field.tsx`
- Modify: `packages/ui/package.json`

**Interfaces:**
- Consumes: tokens from Task 2
- Produces:
  - `Field(props: { id: string; label: string; hint?: string; error?: string; required?: boolean; children: (a: FieldA11y) => ReactNode })`
  - `type FieldA11y = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true; required?: boolean }`
  - `Input(props: Omit<ComponentProps<'input'>, 'className'>)`
  - `Select(props: Omit<ComponentProps<'select'>, 'className'>)`
  - `Textarea(props: Omit<ComponentProps<'textarea'>, 'className'>)`

- [ ] **Step 1: Write `packages/ui/src/field.tsx`**

```tsx
// Label, hint and error, ALWAYS connected. Today those 28 inputs and 22
// labels are wired by hand and inconsistently, which means some errors are
// never announced to a screen reader and some labels are not tappable.
//
// The render-prop shape is what makes the wiring impossible to forget: the
// control cannot be rendered without receiving the ids it must carry.
import type { ComponentProps, ReactNode } from 'react';

const CONTROL = [
  'w-full min-h-12 rounded-control px-3 py-2 text-body',
  'bg-surface-sunken text-fg',
  // border-control is 4.80:1. Its predecessor, zinc-500/30, was about 1.8:1
  // against WCAG 1.4.11's 3:1 floor — and that border is the ONLY signal that
  // a box is typeable, which is why the rule exists at all. This is visibly
  // more present than what it replaces, and deliberately so.
  'border border-control',
  'transition-[border-color,box-shadow] ease-out',
  'placeholder:text-fg-faint',
  'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
  'disabled:opacity-50',
  // 16px minimum on the control itself: iOS zooms the viewport when focusing
  // an input under 16px, and the app's viewport is locked, so the zoom never
  // comes back out.
  'aria-[invalid=true]:border-danger',
].join(' ');

export type FieldA11y = {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  required?: boolean;
};

export function Field({
  id,
  label,
  hint,
  error,
  required = false,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (a11y: FieldA11y) => ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-callout font-medium text-fg">
        {label}
        {required && (
          <span aria-hidden className="text-danger">
            {' *'}
          </span>
        )}
      </label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        required,
      })}
      {hint && !error && (
        <p id={hintId} className="text-caption text-fg-muted">
          {hint}
        </p>
      )}
      {/* role=alert so a screen reader announces a validation failure the
          moment it appears, rather than only when focus happens to land. */}
      {error && (
        <p id={errorId} role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input(props: Omit<ComponentProps<'input'>, 'className'>) {
  return <input {...props} className={CONTROL} />;
}

export function Textarea(props: Omit<ComponentProps<'textarea'>, 'className'>) {
  return <textarea {...props} className={`${CONTROL} min-h-24 resize-y`} />;
}

/** Native <select> on purpose: it works offline, matches the phone's own
 *  picker, and handles keyboards correctly. A custom one would be a modal,
 *  a focus trap and a scroll lock to maintain for no gain. */
export function Select(props: Omit<ComponentProps<'select'>, 'className'>) {
  return <select {...props} className={`${CONTROL} appearance-none pr-8`} />;
}
```

- [ ] **Step 2: Export**

In `packages/ui/package.json` `exports`:

```json
    "./field": "./src/field.tsx",
```

- [ ] **Step 3: Verify the wiring is not optional**

```bash
pnpm --filter @capo/ui typecheck && pnpm design-check
```

Expected: clean, `ALL PASS`.

Then confirm the render prop forces the connection — temporarily add to `field.tsx`:

```tsx
const broken = <Field id="x" label="X">{() => <input />}</Field>;
```

That compiles (the a11y object is simply unused), which is the honest limit of this design: `tsc` guarantees the ids are *offered*, not that they are *used*. The gallery in Task 13 is what catches an unwired control visually. **Delete the line** after confirming, and note the limitation.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/field.tsx packages/ui/package.json
git commit -m "feat(ui): Field, Input, Select, Textarea

The render-prop shape hands the control the ids it must carry, so the
label/hint/error wiring cannot be silently skipped. Errors get role=alert
so a screen reader announces them when they appear, not when focus happens
to land.

border-control is 4.80:1. Its predecessor, zinc-500/30, was ~1.8:1 against
WCAG 1.4.11's 3:1 floor — and that border is the only signal a box is
typeable. This is visibly heavier than what it replaces, deliberately.

Controls are 16px minimum: iOS zooms the viewport on focus below that, and
this app's viewport is locked, so the zoom never comes back out.

Select stays native — it works offline, matches the phone's own picker and
handles keyboards, none of which a custom one would give us."
```

---

### Task 8: Badge and Banner

**Files:**
- Create: `packages/ui/src/badge.tsx`, `packages/ui/src/banner.tsx`
- Modify: `packages/ui/package.json`

**Interfaces:**
- Consumes: tokens from Task 2
- Produces:
  - `type Tone = 'neutral' | 'info' | 'warn' | 'danger' | 'success' | 'brand' | 'review'`
  - `Badge(props: { tone?: Tone; children: ReactNode; strikethrough?: boolean })`
  - `Banner(props: { tone?: Tone; href?: string; icon?: ReactNode; children: ReactNode })`

- [ ] **Step 1: Write `packages/ui/src/badge.tsx`**

```tsx
// A badge is read as a SHAPE, not a sentence — which is the one place 11px
// type is legitimate, and why --text-micro exists and is uppercase and
// tracked. Everything a human actually reads is 13px or larger.
import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'info' | 'warn' | 'danger' | 'success' | 'brand' | 'review';

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-fg-muted',
  info: 'text-info',
  warn: 'text-warn',
  danger: 'text-danger',
  success: 'text-success',
  brand: 'text-brand',
  // Violet deliberately, not amber or red: a completion claim awaiting the
  // manager is a decision to make, not a problem to fix. danger owns "wrong".
  review: 'text-review',
};

export const TONE_QUIET: Record<Tone, string> = {
  neutral: 'bg-surface-hover',
  info: 'bg-info-quiet',
  warn: 'bg-warn-quiet',
  danger: 'bg-danger-quiet',
  success: 'bg-success-quiet',
  brand: 'bg-brand-quiet',
  review: 'bg-review-quiet',
};

export function Badge({
  tone = 'neutral',
  strikethrough = false,
  children,
}: {
  tone?: Tone;
  strikethrough?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-1 text-micro font-semibold uppercase tracking-wide ${TONE_TEXT[tone]} ${TONE_QUIET[tone]} ${strikethrough ? 'line-through' : ''}`}
    >
      {children}
    </span>
  );
}
```

- [ ] **Step 2: Write `packages/ui/src/banner.tsx`**

```tsx
// The full-width shell strip. Two exist today (billing, notifications) and
// they were written separately.
//
// A caller must keep a Banner a SIBLING of the app's overflow-hidden content
// column, never a child of it — a child gets clipped. That constraint lives
// in apps/web/app/(app)/layout.tsx and is restated here because this is the
// component somebody will reach for when adding a third strip.
import type { ReactNode } from 'react';
import type { Tone } from './badge';

const SOLID: Record<Tone, string> = {
  neutral: 'bg-fg text-bg',
  info: 'bg-info text-white',
  warn: 'bg-warn text-white',
  danger: 'bg-danger text-white',
  success: 'bg-success text-white',
  brand: 'bg-brand text-on-brand',
  review: 'bg-review text-white',
};

export function Banner({
  tone = 'info',
  href,
  icon,
  children,
}: {
  tone?: Tone;
  href?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const classes = `flex shrink-0 items-center justify-center gap-2 px-4 py-2 text-center text-caption font-medium no-underline ${SOLID[tone]}`;
  if (href) {
    return (
      <a href={href} className={classes}>
        {icon}
        {children}
      </a>
    );
  }
  return <div className={classes}>{icon}{children}</div>;
}
```

> **Note for the implementer:** `text-white` here is a raw palette class and `design-check` will fail on it, because `banner.tsx` is not in `UNCONVERTED`. That is the rule working. Fix it by adding a token rather than by weakening the rule — see the next step.

- [ ] **Step 3: Add the missing token instead of weakening the rule**

The solid banners need a fixed light foreground that does not flip in dark mode (a red banner stays red in both themes, so its text must stay white in both).

In `packages/ui/src/tokens.css`, add to **all three** blocks (`:root`, `:root.dark`, and the `.system` media block) — the same value in each, because it is deliberately theme-independent:

```css
  /* Text on a SOLID status fill. Fixed in both themes on purpose: a danger
     banner is red in light and dark alike, so its label must not flip to
     near-black and vanish. */
  --on-solid: #ffffff;
```

And in `@theme inline`:

```css
  --color-on-solid: var(--on-solid);
```

Then replace every `text-white` in `banner.tsx` with `text-on-solid`.

Finally add these rows to `PAIRS` in `scripts/design-check.mts`, so the new token is held to the same standard as the rest:

```ts
  ['--on-solid', '--danger', 4.5, 'text on a danger banner'],
  ['--on-solid', '--info', 4.5, 'text on an info banner'],
```

- [ ] **Step 4: Export and verify**

In `packages/ui/package.json` `exports`:

```json
    "./badge": "./src/badge.tsx",
    "./banner": "./src/banner.tsx",
```

```bash
pnpm --filter @capo/ui typecheck && pnpm design-check
```

Expected: clean and `ALL PASS`.

> If `--on-solid on --info` fails in **dark** mode, that is real: dark `--info` is `#60a5fa` and white on it is about 2.5:1. Fix it by giving solid banners the *light* status colour in both themes — add `--danger-solid`/`--info-solid` pinned to the light values and use those in `SOLID` — rather than by deleting the assertion.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/badge.tsx packages/ui/src/banner.tsx packages/ui/src/tokens.css packages/ui/package.json scripts/design-check.mts
git commit -m "feat(ui): Badge and Banner, plus the --on-solid token

A badge is read as a shape rather than a sentence, which is the one place
11px type is legitimate — hence text-micro, uppercase and tracked. Anything
a human reads as words stays 13px or larger.

Banner needed a foreground that does NOT flip with the theme: a danger
banner is red in both, so its label must not turn near-black and vanish.
design-check caught the raw text-white immediately, which is the rule doing
its job — so the fix was a new token held to the same 4.5:1 standard, never
an exception to the rule."
```

---

### Task 9: EmptyState, Skeleton, AppBar

**Files:**
- Create: `packages/ui/src/empty-state.tsx`, `packages/ui/src/skeleton.tsx`, `packages/ui/src/app-bar.tsx`
- Modify: `packages/ui/package.json`

**Interfaces:**
- Consumes: `Button`/`ButtonLink` from Task 5, tokens from Task 2
- Produces:
  - `EmptyState(props: { icon?: ReactNode; title: string; body?: string; action?: ReactNode })`
  - `Skeleton(props: { variant?: 'text' | 'title' | 'row' | 'card'; count?: number })`
  - `AppBar(props: { title: string; subtitle?: string; backHref?: string; backLabel?: string; action?: ReactNode })`

- [ ] **Step 1: Write `packages/ui/src/empty-state.tsx`**

```tsx
// An empty screen should say what to do next. Today "nothing here" is written
// ad hoc per screen, and usually says only that.
import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      {icon && <span className="text-fg-faint">{icon}</span>}
      <p className="text-heading text-fg">{title}</p>
      {body && <p className="max-w-sm text-callout text-fg-muted">{body}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Write `packages/ui/src/skeleton.tsx`**

```tsx
// Shaped like the content that is coming, not a generic grey bar: a skeleton
// that matches the eventual layout stops the page from jumping when the data
// lands, which is the whole reason to show one.
const SHAPE = {
  text: 'h-4 w-full rounded-chip',
  title: 'h-6 w-1/2 rounded-chip',
  row: 'h-14 w-full rounded-card',
  card: 'h-28 w-full rounded-card',
} as const;

export function Skeleton({
  variant = 'text',
  count = 1,
}: {
  variant?: keyof typeof SHAPE;
  count?: number;
}) {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={`block animate-pulse bg-surface-hover ${SHAPE[variant]}`} />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Write `packages/ui/src/app-bar.tsx`**

```tsx
// Sticky, translucent, blurred — so content is visibly passing underneath it,
// which is a status cue rather than decoration. Blur is permitted in exactly
// two places in this design: here and behind a sheet. Anywhere else it costs
// GPU and battery on a cheap Android phone for no information.
//
// No 'use client': position:sticky and backdrop-filter are pure CSS.
import type { ReactNode } from 'react';

function BackChevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

export function AppBar({
  title,
  subtitle,
  backHref,
  backLabel,
  action,
}: {
  title: string;
  subtitle?: string;
  /** An explicit destination, never router.back(). Browser history can lead
   *  out of the app entirely; a declared destination cannot. It is also what
   *  keeps this component free of JavaScript. */
  backHref?: string;
  backLabel?: string;
  action?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b border-hairline bg-surface/80 px-4 py-3 backdrop-blur-md">
      {backHref && (
        <a
          href={backHref}
          aria-label={backLabel ?? 'Back'}
          className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-fg transition-colors ease-out hover:bg-surface-hover outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <BackChevron />
        </a>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="truncate text-title font-semibold text-fg">{title}</h1>
        {subtitle && <p className="truncate text-caption text-fg-muted">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}
```

- [ ] **Step 4: Export all three and verify**

In `packages/ui/package.json` `exports`:

```json
    "./empty-state": "./src/empty-state.tsx",
    "./skeleton": "./src/skeleton.tsx",
    "./app-bar": "./src/app-bar.tsx",
```

```bash
pnpm --filter @capo/ui typecheck && pnpm design-check
```

Expected: clean, `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/empty-state.tsx packages/ui/src/skeleton.tsx packages/ui/src/app-bar.tsx packages/ui/package.json
git commit -m "feat(ui): EmptyState, Skeleton, AppBar

AppBar's back button is an explicit href, never router.back(): browser
history can lead out of the app entirely, a declared destination cannot,
and it is what keeps the component free of JavaScript.

Blur is used here and behind a sheet, nowhere else — elsewhere it costs GPU
and battery on a cheap Android phone for no information.

Skeletons are shaped like the content that is coming, so the page does not
jump when the data lands."
```

---

### Task 10: Sheet

The component with real, reproducible bugs today. Five of them.

**Files:**
- Create: `apps/web/app/_ui/sheet.tsx`

**Interfaces:**
- Consumes: tokens from Task 2
- Produces: `Sheet(props: { open: boolean; onClose: () => void; title: string; children: ReactNode })`

- [ ] **Step 1: Write `apps/web/app/_ui/sheet.tsx`**

```tsx
'use client';

// The bottom sheet. The four hand-rolled ones it replaces have, between them,
// none of the following — every one of which is reproducible today:
//
//   1. Escape does not close it.
//   2. Tab walks OUT of it into the page behind, where a screen-reader user is
//      then reading invisible buttons.
//   3. Focus never enters it, so opening it with a keyboard leaves you where
//      you were.
//   4. The page behind scrolls when you flick the sheet.
//   5. It teleports in, which is why it reads as a browser pop-up rather than
//      part of the app.
//
// It lives in apps/web rather than @capo/ui because it genuinely needs to
// react; @capo/ui is 'use client'-free by contract.
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const focusables = useCallback(
    () => Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    [],
  );

  // Remember who opened it, move focus in, and give it back on close. Without
  // the hand-back, closing a sheet drops focus onto <body> and the next Tab
  // starts from the top of the page.
  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    const first = focusables()[0] ?? panel.current;
    first?.focus();
    return () => returnTo.current?.focus();
  }, [open, focusables]);

  // Escape closes, and Tab cycles inside. The trap is a wrap-around rather
  // than a barrier: at the last element Tab goes to the first, and
  // Shift+Tab at the first goes to the last.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, focusables]);

  // Lock the page behind. The shell already sets overflow:hidden on body, so
  // the thing that actually moves is the inner scroller — but locking body as
  // well costs nothing and covers a route that added its own.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-fg/40 backdrop-blur-sm motion-safe:animate-[fade-in_var(--duration-base)_ease-out]"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto overscroll-contain rounded-t-sheet bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-sheet outline-none motion-safe:animate-[slide-up_var(--duration-slow)_var(--ease-spring)]"
      >
        {/* The grab handle. Decorative — the sheet is not drag-dismissible —
            but it is the universal signal for "this came up from the bottom
            and goes back down", which is what makes it read as native. */}
        <span aria-hidden className="mx-auto mb-3 block h-1 w-10 rounded-full bg-hairline" />
        {children}
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 2: Define the two keyframes**

`animate-[…]` needs the keyframes to exist. Add them to `packages/ui/src/tokens.css`, at the very end of the file (plain CSS, outside `@theme`):

```css
/* Used by the sheet. Declared here rather than in a component so the two
   apps cannot drift, and guarded by motion-safe: at the call site so
   Reduce Motion skips them entirely. */
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slide-up {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
```

- [ ] **Step 3: Verify it compiles**

```bash
pnpm --filter web typecheck && pnpm design-check
```

Expected: clean, `ALL PASS`.

- [ ] **Step 4: Verify all five behaviours by hand in the gallery**

This cannot be done until Task 13 builds the gallery. Record it as a gallery acceptance test to run then:

1. Open the sheet, press `Escape` → it closes.
2. Open it, press `Tab` repeatedly → focus cycles inside and never reaches the page behind.
3. Open it with the keyboard → focus lands inside immediately.
4. Open it, scroll the page behind → it does not move.
5. Open it → it slides up rather than appearing.
6. Turn on the OS "Reduce Motion" setting, open it → it appears with no animation.
7. Close it → focus returns to the button that opened it.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/_ui/sheet.tsx packages/ui/src/tokens.css
git commit -m "feat(web): Sheet — Escape, focus trap, scroll lock, animation

The four hand-rolled sheets it replaces have none of these, and every gap
is reproducible today: Escape does nothing, Tab walks out into the page
behind (where a screen-reader user then reads invisible buttons), focus
never enters, the page behind scrolls, and it teleports in.

Focus is handed BACK to whatever opened it. Without that, closing a sheet
drops focus on <body> and the next Tab restarts from the top of the page.

Keyframes live in tokens.css so the two apps cannot drift, and are guarded
by motion-safe: so Reduce Motion skips them."
```

---

### Task 11: SegmentedControl

One component for the four pill implementations — and it must keep working before JavaScript loads.

**Files:**
- Create: `apps/web/app/_ui/segmented-control.tsx`

**Interfaces:**
- Consumes: tokens from Task 2
- Produces: `SegmentedControl(props: { name: string; legend: string; value: string; options: { value: string; label: string }[]; onChange?: (v: string) => void })`

- [ ] **Step 1: Write `apps/web/app/_ui/segmented-control.tsx`**

```tsx
'use client';

// One component for the four separate pill implementations: the /tarefas
// filter chips, the theme pills, the language pills on /perfil, and the
// onboarding language picker.
//
// THE RADIO INPUTS ARE LOAD-BEARING AND MUST NOT BECOME BUTTONS.
// theme-pills.tsx and onboarding/page.tsx are plain <form>s styled with
// peer-checked precisely so that a cold PWA on a slow phone — which is most
// of the time this is actually used — can still select and save before any
// JavaScript has run. onChange only ENHANCES that; it never replaces it.
// Arrow-key navigation between radios in a named group is native browser
// behaviour, so it comes free from this markup.
import type { ChangeEvent } from 'react';

export function SegmentedControl({
  name,
  legend,
  value,
  options,
  onChange,
}: {
  name: string;
  /** Spoken to a screen reader as the question these options answer. */
  legend: string;
  value: string;
  options: { value: string; label: string }[];
  onChange?: (value: string) => void;
}) {
  function handle(e: ChangeEvent<HTMLInputElement>) {
    onChange?.(e.target.value);
  }

  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <div className="flex gap-2 overflow-x-auto">
        {options.map(option => (
          <label
            key={option.value}
            className="min-h-11 shrink-0 cursor-pointer"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              defaultChecked={option.value === value}
              onChange={handle}
              className="peer sr-only"
            />
            <span
              className={[
                'flex min-h-11 items-center rounded-full border px-4 text-callout',
                'border-control text-fg-muted bg-surface',
                'transition-colors ease-out hover:bg-surface-hover',
                // Two signals, not one: the selected pill changes colour AND
                // weight, so it survives a colour-vision deficiency.
                'peer-checked:border-brand peer-checked:bg-brand peer-checked:text-on-brand peer-checked:font-semibold',
                'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus',
              ].join(' ')}
            >
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
```

- [ ] **Step 2: Verify**

```bash
pnpm --filter web typecheck && pnpm design-check
```

Expected: clean, `ALL PASS`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/_ui/segmented-control.tsx
git commit -m "feat(web): SegmentedControl replaces four pill implementations

The radio inputs are load-bearing and must never become buttons:
theme-pills and onboarding are plain forms styled with peer-checked
precisely so a cold PWA on a slow phone can select and save before any
JavaScript runs. onChange only enhances that.

Selection changes colour AND weight — two signals, so it survives a
colour-vision deficiency. Arrow-key navigation comes free from a named
radio group."
```

---

### Task 12: TabBar

**Files:**
- Create: `apps/web/app/_ui/tab-bar.tsx`

**Interfaces:**
- Consumes: tokens from Task 2
- Produces: `TabBar(props: { locale: Locale })` — a drop-in replacement for `BottomNav`, wired in the *next* plan (spec step 2). Built here, used by nothing yet.

- [ ] **Step 1: Write `apps/web/app/_ui/tab-bar.tsx`**

Copy the `TABS` array and its comment from `apps/web/app/bottom-nav.tsx` verbatim, then give every icon a filled counterpart:

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

// Hoje/Amanhã/Atrasadas were never separate places — they were one list with a
// different date filter, so they live behind the chips on /tarefas now. That
// freed the slots for the surfaces that were actually missing: Perfil, and
// Materiais, which is the anticipation list 00_VISION calls the killer feature
// and which nothing in the product surfaced until now. Materiais sits before
// Perfil because it is a daily-use screen and Perfil is a settings screen.
//
// EVERY TAB CARRIES TWO ICONS, and that is an accessibility requirement rather
// than a flourish. The bar it replaces signalled the active tab by COLOUR
// ALONE (orange versus grey). Roughly 1 in 12 men has a colour-vision
// deficiency and construction is a heavily male trade, so that is a real share
// of the actual users — and orange-versus-grey is a hard pair for the common
// type. Colour plus a filled shape works with no colour perception at all.
const TABS = [
  {
    href: '/',
    key: 'chat',
    outline: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
    filled: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="currentColor" />,
  },
  {
    href: '/tarefas',
    key: 'tasks',
    outline: (
      <>
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </>
    ),
    filled: (
      <>
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" fill="currentColor" />
        <path d="M9 11l3 3L22 4" stroke="var(--surface)" />
      </>
    ),
  },
  {
    href: '/obras',
    key: 'jobs',
    outline: <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4" />,
    filled: <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4" fill="currentColor" />,
  },
  {
    href: '/materiais',
    key: 'materials',
    outline: (
      <>
        <path d="M21 8v13H3V8" />
        <rect x="1" y="3" width="22" height="5" rx="1" />
        <path d="M10 12h4" />
      </>
    ),
    filled: (
      <>
        <path d="M21 8v13H3V8" fill="currentColor" />
        <rect x="1" y="3" width="22" height="5" rx="1" fill="currentColor" />
        <path d="M10 12h4" stroke="var(--surface)" />
      </>
    ),
  },
  {
    href: '/perfil',
    key: 'profile',
    outline: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
      </>
    ),
    filled: (
      <>
        <circle cx="12" cy="8" r="4" fill="currentColor" />
        <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" fill="currentColor" />
      </>
    ),
  },
];

// Icons are static; the words are not, so labels resolve per render from
// `locale` rather than being baked into TABS.
export function TabBar({ locale }: { locale: Locale }) {
  const pathname = usePathname();
  const nav = getCatalog(locale).nav;
  return (
    // Translucent + blurred so content is visibly passing underneath, which is
    // a status cue. pb-[env(safe-area-inset-bottom)] is load-bearing: without
    // it the tabs sit under the iPhone home indicator.
    <nav className="grid shrink-0 grid-cols-5 border-t border-hairline bg-surface/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-md">
      {TABS.map(({ href, key, outline, filled }) => {
        const label = nav[key as keyof typeof nav];
        // Prefix match so /obras/[id] keeps its tab lit. '/' has to stay an
        // exact match or it would claim every route.
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-14 flex-col items-center justify-center gap-1 text-caption no-underline transition-colors ease-out outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
              active ? 'font-semibold text-brand' : 'text-fg-muted'
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              className={`h-6 w-6 transition-transform duration-(--duration-fast) ease-out ${
                active ? 'scale-110' : 'scale-100'
              }`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {active ? filled : outline}
            </svg>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 2: Verify**

```bash
pnpm --filter web typecheck && pnpm design-check
```

Expected: clean, `ALL PASS`. Note `bottom-nav.tsx` is still in `UNCONVERTED` and still in use — this file is built but not yet wired, which is what makes this task safe.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/_ui/tab-bar.tsx
git commit -m "feat(web): TabBar with a two-signal active state

The bar it will replace signals the active tab by COLOUR ALONE. Roughly
1 in 12 men has a colour-vision deficiency and construction is a heavily
male trade, so that is a real share of the users — and orange-versus-grey
is a hard pair for the common type. Every tab now carries an outline and a
filled icon, so the active state survives with no colour perception at all.

Labels 11px -> 13px, targets 56px, translucent with a blur so content is
visibly passing under it. Not wired yet: bottom-nav.tsx is still the live
component, which is what makes this commit safe."
```

---

### Task 13: The component gallery

**Files:**
- Create: `apps/web/app/_design/page.tsx`

**Interfaces:**
- Consumes: every component from Tasks 5–12
- Produces: `http://localhost:3000/_design`, dev-only

- [ ] **Step 1: Write `apps/web/app/_design/page.tsx`**

```tsx
import { notFound } from 'next/navigation';
import { Badge, type Tone } from '@capo/ui/badge';
import { Banner } from '@capo/ui/banner';
import { Button, ButtonLink, IconButton } from '@capo/ui/button';
import { Card } from '@capo/ui/card';
import { EmptyState } from '@capo/ui/empty-state';
import { Field, Input, Select, Textarea } from '@capo/ui/field';
import { ListRow } from '@capo/ui/list-row';
import { Skeleton } from '@capo/ui/skeleton';
import { AppBar } from '@capo/ui/app-bar';

// The design system, visible without logging in. Every component in every
// state, so a disabled button or a field with an error can be looked at
// directly instead of hunted for on a screen that happens to contain one.
//
// Dev-only, and the guard is a 404 rather than a redirect: a redirect
// announces that the route exists.
export const dynamic = 'force-dynamic';

const TONES: Tone[] = ['neutral', 'info', 'warn', 'danger', 'success', 'brand', 'review'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-hairline pt-6">
      <h2 className="text-heading font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}

export default function DesignGallery() {
  if (process.env.NODE_ENV === 'production') notFound();

  return (
    <div className="mx-auto flex h-dvh w-full max-w-2xl flex-col overflow-y-auto bg-bg">
      <AppBar title="Design system" subtitle="Every component, every state" />
      <div className="flex flex-col gap-6 p-4">
        <Section title="Buttons — one primary per screen">
          <div className="flex flex-wrap gap-2">
            <Button variant="primary">Guardar</Button>
            <Button variant="secondary">Cancelar</Button>
            <Button variant="tertiary">Editar</Button>
            <Button variant="destructive">Apagar</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm">Small 44px</Button>
            <Button size="md">Medium 48px</Button>
            <Button size="lg">Large 56px</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button loading>Guardar</Button>
            <Button disabled>Guardar</Button>
            <Button fullWidth>Full width</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="#">Ver obra</ButtonLink>
            <IconButton label="Fechar" icon={<span aria-hidden>✕</span>} />
          </div>
        </Section>

        <Section title="Badges">
          <div className="flex flex-wrap gap-2">
            {TONES.map(tone => (
              <Badge key={tone} tone={tone}>
                {tone}
              </Badge>
            ))}
          </div>
        </Section>

        <Section title="Banners">
          <div className="flex flex-col gap-2">
            <Banner tone="danger" href="#">A tua subscrição expirou</Banner>
            <Banner tone="warn">Faltam 3 dias de teste</Banner>
            <Banner tone="info">2 notificações por ler</Banner>
          </div>
        </Section>

        <Section title="Card and rows">
          <Card padding="none">
            <ListRow title="Pintar tecto" meta="Casa de Paco — a ajudar Miguel" href="#" />
            <ListRow title="Assentar azulejo" meta="Atrasada 2 dias" danger href="#" />
            <ListRow
              title="Um título muito comprido que não cabe de maneira nenhuma nesta linha estreita"
              meta="Truncation check"
              trailing={<Badge tone="review">review</Badge>}
              href="#"
            />
          </Card>
        </Section>

        <Section title="Fields">
          <Card>
            <div className="flex flex-col gap-4">
              <Field id="g-name" label="Nome da obra" required>
                {a11y => <Input {...a11y} placeholder="Casa de Paco" />}
              </Field>
              <Field id="g-hint" label="Telefone" hint="Com indicativo do país">
                {a11y => <Input {...a11y} type="tel" placeholder="+351…" />}
              </Field>
              <Field id="g-err" label="Email" error="Esse email já está em uso">
                {a11y => <Input {...a11y} type="email" defaultValue="a@b.pt" />}
              </Field>
              <Field id="g-sel" label="Idioma">
                {a11y => (
                  <Select {...a11y} defaultValue="pt-PT">
                    <option value="pt-PT">Português</option>
                    <option value="es-ES">Español</option>
                    <option value="en-US">English</option>
                  </Select>
                )}
              </Field>
              <Field id="g-txt" label="Notas">
                {a11y => <Textarea {...a11y} rows={3} />}
              </Field>
            </div>
          </Card>
        </Section>

        <Section title="Empty and loading">
          <Card padding="none">
            <EmptyState
              title="Nada para hoje"
              body="Quando criares tarefas com data de hoje, aparecem aqui."
              action={<Button size="sm">Criar tarefa</Button>}
            />
          </Card>
          <Card>
            <Skeleton variant="title" />
            <div className="pt-2">
              <Skeleton variant="text" count={3} />
            </div>
          </Card>
        </Section>

        <Section title="Type scale">
          <p className="text-display text-fg">Display 32</p>
          <p className="text-title text-fg">Title 22</p>
          <p className="text-heading text-fg">Heading 17</p>
          <p className="text-body text-fg">Body 16 — the default</p>
          <p className="text-callout text-fg-muted">Callout 15</p>
          <p className="text-caption text-fg-muted">Caption 13 — the floor</p>
          <p className="text-micro text-fg-faint uppercase">Micro 11 — badges only</p>
        </Section>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add a client island for the Sheet and SegmentedControl**

Those two need state, so the gallery page (a server component) cannot toggle them directly. Create `apps/web/app/_design/interactive.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Button } from '@capo/ui/button';
import { Sheet } from '@/app/_ui/sheet';
import { SegmentedControl } from '@/app/_ui/segmented-control';

export function InteractiveDemos() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState('light');
  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl
        name="gallery-theme"
        legend="Aparência"
        value={theme}
        onChange={setTheme}
        options={[
          { value: 'light', label: 'Claro' },
          { value: 'dark', label: 'Escuro' },
          { value: 'system', label: 'Sistema' },
        ]}
      />
      <p className="text-caption text-fg-muted">Selected: {theme}</p>
      <Button onClick={() => setOpen(true)}>Abrir sheet</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Concluir tarefa">
        <div className="flex flex-col gap-3">
          <p className="text-heading text-fg">Concluir tarefa</p>
          <p className="text-callout text-fg-muted">
            Escape fecha. Tab fica preso aqui dentro. A página atrás não faz scroll.
          </p>
          <Button onClick={() => setOpen(false)}>Confirmar</Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
```

Then import it in the gallery and add a section:

```tsx
import { InteractiveDemos } from './interactive';
```

```tsx
        <Section title="Sheet and SegmentedControl">
          <InteractiveDemos />
        </Section>
```

- [ ] **Step 3: Run the Sheet acceptance tests from Task 10 Step 4**

Start the dev server, open `http://localhost:3000/_design`, and work through all seven checks. Every one must pass.

- [ ] **Step 4: Verify the production guard**

```bash
pnpm --filter web build
```

Expected: builds without error. The route exists in the bundle but returns 404 at runtime in production — the guard is a runtime check, not a build-time exclusion, which is why `force-dynamic` is set.

- [ ] **Step 5: Screenshot the gallery in light and dark, at 375px and desktop**

Four images. These are the reference the screen conversions get checked against.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/_design/
git commit -m "feat(web): /_design — every component, every state, no login

The design system needs to be reviewable without hunting for a screen that
happens to contain a disabled button or a field with an error. Dev-only,
guarded with notFound() rather than a redirect, because a redirect
announces that the route exists.

Includes the long-title row that checks truncation, which is the case that
breaks list layouts and that a healthy live account never produces."
```

---

### Task 14: Real screens on fake data

**Files:**
- Create: `apps/web/app/_design/fixtures.ts`, `apps/web/app/_design/screens/page.tsx`

**Interfaces:**
- Consumes: `DashboardObra` from `@capo/ui/dashboard-ui`, `Tables<'task_board'>` from `@capo/db/types`
- Produces: `http://localhost:3000/_design/screens`, dev-only

- [ ] **Step 1: Read the real row shapes first**

Before writing fixtures, read the actual types so they compile against the real contract:

```bash
grep -n "task_board" packages/db/src/types.ts | head -20
```

Build the fixtures from the `Row` type of `task_board` and `dashboard_obras`. **Do not invent field names** — a fixture that does not match the view is a fixture that will not compile, which is the point of typing it.

- [ ] **Step 2: Write `apps/web/app/_design/fixtures.ts`**

```ts
// Static sample data for /_design/screens.
//
// Three reasons this exists rather than logging into a real account:
//   * it needs no credentials from anybody, ever;
//   * the data is identical on every render, so a before/after screenshot
//     isolates the DESIGN change — with live data rows move, and a layout
//     change is indistinguishable from a data change;
//   * it can hold the hard cases on purpose. A 90-character title, an overdue
//     task, an empty board, a worker with no name: the states that break
//     layouts and that browsing a healthy account never produces.
//
// Typed against the real view Row types, so a fixture that drifts from the
// schema fails `tsc` instead of rendering a screen that cannot exist.
import type { Tables } from '@capo/db/types';

type TaskBoardRow = Tables<'task_board'>;

/** Fill in every column of the real row type, then override what matters.
 *  Written as a helper so each fixture below states only its interesting
 *  fields and the rest stay obviously irrelevant. */
export function taskFixture(overrides: Partial<TaskBoardRow>): TaskBoardRow {
  return {
    ...(BASE_TASK as TaskBoardRow),
    ...overrides,
  };
}
```

> **Implementer note:** `BASE_TASK` must be written out with every column the generated `task_board` Row type declares, using plausible values. Read the type first (Step 1) and fill it in completely — `tsc` will name every missing column, so work through its errors until it compiles. Do not use `as unknown as` to skip this; the whole value of the fixture is that it matches the real shape.

- [ ] **Step 3: Write `apps/web/app/_design/screens/page.tsx`**

Render the real presentational components against the fixtures, in these states, each under a heading:

1. A normal task board — five tasks, mixed statuses
2. An **empty** board
3. A board with **one overdue** task and one `pending_review`
4. A task with a **90-character title**
5. A worker with **no name** (null) on a row
6. A **loading** board (skeletons)
7. The materials list with **seven obra groups** (the collapse threshold is 3)

```tsx
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function DesignScreens() {
  if (process.env.NODE_ENV === 'production') notFound();
  // …render each state above, each inside a <Section> naming the case…
  return null; // replace
}
```

- [ ] **Step 4: Verify**

```bash
pnpm --filter web typecheck && pnpm --filter web build && pnpm design-check
```

Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/_design/fixtures.ts apps/web/app/_design/screens/
git commit -m "feat(web): /_design/screens — real screens, fake data, no login

Identical data on every render, so a before/after screenshot isolates the
design change. With live data rows move and a layout change is
indistinguishable from a data change.

Holds the hard cases deliberately: a 90-character title, an overdue task,
an empty board, a worker with no name. Those break layouts and a healthy
live account never produces them.

Fixtures are typed against the real view Row types, so one that drifts from
the schema fails tsc rather than rendering a screen that cannot exist."
```

---

### Task 15: Document the system and close the gate

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: everything above
- Produces: the written invariants that the screen-conversion plan will rely on

- [ ] **Step 1: Add a design-system section to `AGENTS.md`**

Insert after the "One clock, one definition of today" invariant, in the same voice as its neighbours:

```markdown
- **The design system is TOKENS plus THIRTEEN COMPONENTS, and `pnpm
  design-check` is what keeps it true.** `packages/ui/src/tokens.css` is the
  single source of every colour, size, spacing, radius, shadow and timing, and
  BOTH apps import it — before it, each declared its own `--background`, which
  is two copies of one rule and therefore an eventual disagreement. Six things
  are load-bearing:
  - **Never put `@utility` in `tokens.css`.** Tailwind discards the ENTIRE
    imported file when it finds one — no error, no warning, every token gone.
    It works only in an app's own `globals.css`. Nothing in the design needs
    one: `min-h-11 min-w-11` is already 44px.
  - **Text colours are `--fg*`, never `--text*`.** Tailwind v4 owns `--text-*`
    as its FONT-SIZE namespace, so `--text-muted` would generate a font-size
    utility named `text-muted` and collide with the colour of the same name.
  - **There is no `--duration-*` theme namespace**, so `duration-fast` is not a
    utility and fails silently. Use `--default-transition-duration` (a bare
    `transition-colors` is then 180ms) or `duration-(--duration-fast)`.
  - **`--background` aliases `--surface`, never `--bg`.** Every existing
    `bg-background` is on a sheet, an input, the tab bar or the chat composer —
    a surface, never the page. Aliasing it to the page colour silently repaints
    all fifteen, input fields included.
  - **`--brand` (`#c2410c`) is the only orange legal behind text**;
    `--brand-vivid` (`#ea580c`) is 3.56:1 and is for large non-text fills only.
    `design-check` asserts vivid stays UNSAFE behind text, so it cannot be
    quietly promoted back into the primary button it used to be.
  - **`UNCONVERTED` in `scripts/design-check.mts` may only ever shrink**, and a
    STALE entry fails too. An allowlist nobody prunes is how a temporary
    exception becomes permanent; that list is the remaining sweep, written down.
  Components live in `@capo/ui` when they need no browser JavaScript (ten of
  them) and in `apps/web/app/_ui/` when they must react (`Sheet`,
  `SegmentedControl`, `TabBar`) — `@capo/ui` is `'use client'`-free by
  contract. `/_design` and `/_design/screens` are dev-only and render every
  component and every hard layout case without a login.
```

- [ ] **Step 2: Run the complete gate one final time, serially**

```bash
pnpm turbo lint typecheck build
```

Then:

```bash
pnpm design-check && pnpm scheduler-check && pnpm guard-check && pnpm cache-check && pnpm cost-check && pnpm push-check && pnpm whatsapp-check && pnpm memory-check && pnpm billing-check
```

Expected: every one green. If any of the pre-existing checks went red, **stop** — this plan touched none of their subject matter, so a failure means something unexpected was disturbed.

- [ ] **Step 3: Confirm no screen changed**

```bash
git diff --stat main -- 'apps/web/app/(app)' 'apps/web/app/(public)'
```

Expected: **empty**. This plan builds the foundation and the components; not one screen is converted. If this shows changes, they were unintended.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs: record the design system's six load-bearing invariants

Four of them are silent failures found by spike rather than by reading:
@utility deletes the whole token file, --text-* collides with Tailwind's
font-size namespace, --duration-* does not exist as a namespace, and
--background must alias --surface or fifteen inputs repaint themselves.

Also records why --brand-vivid stays illegal behind text, and that the
UNCONVERTED ledger may only shrink."
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §4.1 colour roles | 2 |
| §4.2 type scale, Arial deletion | 2, 3 |
| §4.3 spacing restriction | 4 (enforced by the `off-scale-spacing` rule) |
| §4.4 depth and blur | 2 (`--shadow-float`/`--shadow-sheet`), 9 (`AppBar`), 10 (`Sheet`) |
| §4.5 motion + reduced-motion | 2 |
| §4.6 radius | 2 |
| §4.7 touch targets | 5 (`min-h-11`/`min-h-12`), 6, 11, 12 |
| §5.1 ten server components | 5, 6, 7, 8, 9 |
| §5.2 three client components | 10, 11, 12 |
| §5.3 deliberately not built | honoured — no collapsing header, native `Select`, no animation library |
| §6 invariants | 3 (globals.css verbatim), 12 (safe-area), 15 (documented) |
| §7.1 `design-check` | 1, 4 |
| §7.2 `/_design` | 13 |
| §7.3 `/_design/screens` | 14 |
| §8 rollout steps 0–1 | this plan; steps 2–8 are the next plan |
| §3.7 duplicated `:root` | 3 |

**Known gaps, stated rather than hidden**

- **`StatusBadge` and `ScreenShell` do not yet delegate** to `Badge` and `AppBar`. Both live in `dashboard-ui.tsx`, which is in `UNCONVERTED` and is read by live screens; changing it converts screens, which belongs to the next plan. The components are built and ready.
- **Task 14 Step 2 leaves `BASE_TASK` to be filled from the generated type.** That is deliberate: the columns of `task_board` are generated output that will have changed by execution time, and `tsc` names every missing one. Writing a guess here would be worse than an instruction to read the real type.
- **`Field` cannot force its a11y object to be used**, only offered. Recorded in Task 7 Step 3 rather than overclaimed.

**Type consistency checked**

`Tone` is defined once in `badge.tsx` and imported by `banner.tsx`, and the gallery imports it as a type for its tone list. `buttonClasses` is used internally by `Button` and `ButtonLink` only — Tasks 10 and 11 use `Button` itself, and `SegmentedControl` has its own pill surface. `FieldA11y` matches the render-prop parameter spread in Task 13's gallery usage. `TabBar` takes `{ locale: Locale }`, matching the `BottomNav` signature it will replace.

**Two deliberate red states.** Task 1 ends with `design-check` failing (no tokens yet) and Task 8 Step 2 ends with it failing on a raw `text-white`. Both are genuine red-green cycles, not oversights — Task 8's is the rule catching a real violation in code written moments earlier, and it is fixed by adding a token held to the same 4.5:1 standard rather than by weakening the rule.

**The plan failed its own spacing rule during review** — `gap-1.5`, `gap-0.5` and `py-0.5` appeared in five components while the rule bans anything outside 1/2/3/4/6/8/12/16. Fixed, and `0.5` was added to the deny pattern, which had missed it.

---

## Carried into the screen-conversion plan

Findings that were real, deliberately not fixed here, and that the next plan
must not rediscover from scratch. Recorded in the repo rather than in a scratch
ledger, because a parked finding that dies with its workspace was never parked
— it was discarded.

- **The reference screens currently show BOTH design systems side by side.**
  `/design-system/screens` renders the new `Badge` immediately beside the legacy
  `StatusBadge` from `dashboard-ui.tsx`, which still uses `text-[11px]`, `py-0.5`
  and raw palette classes. That is the correct, unavoidable consequence of the
  known gap below — but the route whose job is a clean before/after baseline
  currently shows a mixed one. Convert `dashboard-ui.tsx` early in the sweep and
  it resolves itself.

- **`StatusBadge` and `ScreenShell` do not delegate to `Badge` and `AppBar`.**
  Deliberate: `packages/ui/src/dashboard-ui.tsx` is in `UNCONVERTED` and is read
  by live screens, so converting it converts screens — which this plan's scope
  assertion forbids. It is the natural first task of the sweep.

- **Any interactive control placed directly inside `Card padding="none"` needs
  an INSET focus ring.** `Card` carries `overflow-hidden` (so square-cornered
  rows do not poke outside its radius), which also clips an *outward* focus ring
  on a child flush to the edge. `ListRow` is already safe — it uses
  `focus-visible:-outline-offset-2`. `Button` and `Select` use the outward
  `outline-offset-2` and would be clipped. Today `padding="none"` only ever
  wraps `ListRow`, so nothing is broken; the sweep is where that stops being
  true.

- **`Sheet`'s scrim closes on a drag-release from inside the sheet.** Select text
  in the sheet body, release the mouse over the scrim, and the click lands on the
  common ancestor and dismisses it. Not fixed here because it is a behavioural
  change to the one component whose seven behaviours were verified by hand, and
  the fix should be re-verified against a real screen. Guard on `onMouseDown`'s
  target rather than `onClick`.

- **`design-check` does not police tap-target size, and says so.** Expressing
  "this element is tappable and shorter than 44px" as a regex over class strings
  cannot be done honestly — `min-h-11` is a size utility and `off-scale-spacing`
  excludes `h`/`w` deliberately, so `h-8` on a new icon button passes. The 44px
  floor lives in the `Button`/`IconButton` size maps and in review. If the sweep
  introduces bespoke tappable elements, that gap widens.

- **`ListRow` has no `onClick`.** It renders a link when given `href` and a plain
  row otherwise. The first screen that needs a non-navigating tappable row adds
  the prop then — deliberately not added speculatively to a component in a
  `'use client'`-free package.
