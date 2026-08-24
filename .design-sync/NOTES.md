# design-sync notes — Capo

Repo-specific gotchas for anyone re-running the sync. Read this BEFORE the
converter; several of these cost a debugging cycle to find and none of them is
discoverable from the error message alone.

## Required pre-step: compile the stylesheet

`apps/web/app/globals.css` is a Tailwind v4 SOURCE file, not a stylesheet — its
`@import "tailwindcss"` is an instruction to scan components and generate the
utilities they use. Shipping it verbatim ships a recipe that claude.ai/design
cannot run, and every card renders unstyled.

Run this before `package-build.mjs`, every time:

```sh
.ds-sync/node_modules/.bin/tailwindcss \
  -i .design-sync/tailwind-entry.css \
  -o packages/ui/.ds-styles/capo.css
```

(`@tailwindcss/cli` is installed into `.ds-sync/`, pinned to the repo's
tailwindcss 4.3.2. `.ds-styles/` is gitignored via `packages/ui/.gitignore`.)

- **The output MUST live inside `packages/ui/`.** `cfg.cssEntry` is bounded to
  PKG_DIR by the converter (its content is uploaded verbatim, so a path anywhere
  else would let a config exfiltrate project files). A path under
  `.design-sync/` resolves outside the bound and is silently skipped —
  the only symptom is `! cssEntry: … not found — skipped` in the build log.
- **`.design-sync/tailwind-entry.css` is NOT a copy of globals.css.** It
  `@source`s BOTH `packages/ui/src` and `apps/web/app` (components ship from
  both), defines `--font-geist-sans`/`--font-geist-mono` (next/font injects
  those at runtime in the app and nothing does here — without them every card
  falls back to a system face), and OMITS globals.css's closing
  `html, body { overflow: hidden; overscroll-behavior: none }`. That rule is an
  app-shell decision; this stylesheet is applied to every design built with the
  DS and a document that can never scroll is wrong for most of them.
- **⚠ RE-DIFF `tailwind-entry.css` AGAINST `globals.css` EVERY RE-SYNC.** This
  file is a hand-maintained near-copy, and it went badly stale between #102 and
  #103: `globals.css` was rewritten to `@import "../../../packages/ui/src/tokens.css"`
  and this file still carried the pre-token `--background`/`--foreground` pair.
  Nothing errors — the compile succeeds and every component styled with
  `bg-surface`/`text-fg-muted`/`text-heading` renders with undefined variables.
  The four deliberate differences are listed in the file's own header; treat
  everything else as "must match globals.css verbatim".
- **The Google Fonts `@import` is load-bearing and easy to drop.** Geist is
  fetched by `next/font/google` at BUILD time in the app, so there is no
  `@font-face` in the repo to harvest. Removing that line turns the expected
  `[FONT_REMOTE]` into `[FONT_MISSING]` and every card renders in a system face.
- **`source(none)` is load-bearing.** Tailwind's automatic content detection
  walks outward from the input file, so output depended on where the file sat
  and where the command ran — two runs of the same input differed by 600 bytes.
  With it off, the `@source` lines are the only inputs and output is
  reproducible. Do not remove it.

## Build command

```sh
node .ds-sync/package-build.mjs --config .design-sync/config.json \
  --node-modules apps/web/node_modules --out ./ds-bundle
node .ds-sync/package-validate.mjs ./ds-bundle
```

**`--node-modules` must be `apps/web/node_modules`, not `packages/ui/node_modules`.**
The converter resolves the package as `<node-modules>/@capo/ui/package.json`;
pnpm does not self-link a package into its own `node_modules`, so pointing at
`packages/ui/node_modules` crashes with ENOENT before anything runs.
`apps/web/node_modules` has the `@capo/ui` symlink AND react, react-dom, next
and `@types/react`, which is everything the build and the `.d.ts` pass need.

There is **no `dist/`** — `@capo/ui` has no build script and its `exports` point
straight at `src/*.tsx`, so the converter runs in synth-entry mode
(`[NO_DIST] … synthesizing from 11 src files` — 12 minus the excluded
`dashboard-ui.tsx`, see the EmptyState section). That is expected, not a failure.

## Two shim files, both required, both committed

- **`.design-sync/named-exports.ts`** — the converter builds its bundle entry
  with `export * from`, and `export *` does NOT carry a module's DEFAULT export.
  Ten of the older components are `export default function`, so without this
  they bundle and are then invisible on `window.Capo`; every card fails with
  "Element type is invalid" and nothing points at the cause.
- **`.design-sync/preview-providers.tsx`** — mounts the real Next App Router
  contexts. Four components read them (`TabBar` via `usePathname`,
  `PullToRefresh` / `FilterControls` / `TranslationProgress` via `useRouter`)
  and throw without them.
  ⚠ **Its `next/...` imports are RELATIVE (`../apps/web/node_modules/next/...`)
  on purpose. Do not tidy them into bare specifiers.** This file sits at the
  repo root, and in a git WORKTREE a bare specifier makes Node walk up out of
  the worktree and resolve Next from the parent `capo-v1` checkout — a
  physically different copy. `React.createContext` then runs twice, the provider
  sets a context the components never read, and you get the exact original
  errors back with the provider visibly present and apparently correct.
  Diagnose by counting `var PathnameContext` in `ds-bundle/_ds_bundle.js`: it
  must be **1**.
- `.design-sync/process-shim.ts` (imported first by named-exports.ts) installs
  an empty `process.env`. Next's client runtime reads build-time flags
  (`__NEXT_CACHE_COMPONENTS`, `NEXT_RUNTIME`, …) that its own compiler normally
  substitutes; outside a Next build the first read throws at module scope and
  the WHOLE bundle fails to evaluate, which presents as every component missing
  from `window.Capo` rather than as a routing problem. Empty is correct: an
  unset `__NEXT_*` flag is what a Next app without those features has.

## The EmptyState collision, and the one lib fork

`packages/ui` exports TWO different components called `EmptyState`:
`src/dashboard-ui.tsx` (`{text, cta}`, still live on five screens) and
`src/empty-state.tsx` (`{icon, title, body, action}`, the design-system one that
AGENTS.md names). The synth entry star-exports every src file, and **a name
exported by two star-exported modules is ambiguous: esbuild drops it from the
bundle ENTIRELY** — not "one wins". `window.Capo.EmptyState` was `undefined`,
every card composing it rendered blank, and nothing pointed at the cause.

An explicit re-export in `named-exports.ts` does **not** beat this — verified
with a minimal esbuild repro (shim listed first, name still dropped). The only
fix is for exactly one module in the graph to export the name, so:

- `.design-sync/overrides/source-kit.mjs` (declared in `cfg.libOverrides`) keeps
  `dashboard-ui.tsx` OUT of the synth entry. One added constant, one filter
  clause; everything else is the bundled adapter verbatim.
- `named-exports.ts` therefore became **the ONLY provider of dashboard-ui's
  exports** and lists all eight explicitly (`ScreenShell`, `StatusBadge`,
  `TaskBoardList`, `ObrasList`, `TimelineList`, `MaterialsList`, `riskReasons`,
  `formatShortDate`). **Deleting a line there silently removes that component
  from `window.Capo`.**
- The three `apps/web/app/_ui` components (`Sheet`, `SegmentedControl`,
  `TabBar`) also need shim lines — they are named exports, but they live outside
  `packages/ui/src`, which is the only tree the synth entry walks.

Diagnose any "N/36 not a component on window.Capo" by loading
`ds-bundle/_ds_bundle.js` in a headless page and dumping `Object.keys(window.Capo)`;
the validate error names the missing ones directly.

**Adding or removing a fork resets the grade contract** (`scriptsSha` moves), so
the next sync re-verifies all 36 components once. That is expected, not a bug.

## Render check without downloading a browser

There is no playwright browser cache on this machine and no repo pin. Installing
chromium is ~200MB and unnecessary: `playwright` itself installs fine with
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, and both `package-validate.mjs` and
`package-capture.mjs` honour **`DS_CHROMIUM_PATH`**. Export it for every
validate/capture/driver run:

```sh
export DS_CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

## Known render warns (expected — not new)

- `[FONT_REMOTE] "Geist", "Geist Mono"` — deliberate. `next/font/google` fetches
  these at build time in the app, so there is no `@font-face` to harvest; the
  generated stylesheet pulls them from Google Fonts instead. Informational.
- `[EXPORT_COLLISION] … named-exports.ts exports N names the main package also
  exports` — **false positive.** In synth-entry mode the converter adds every
  `componentSrcMap` name to the "main package exports" set, then flags the shim
  for colliding with itself. Verified harmless: the real main namespace
  (`ds-bundle/.pkg-entry.mjs`) re-exports only the three `packages/ui/src` files,
  so the runtime `Object.assign(__dsMainNs)` cannot clobber anything.
- `[NO_DIST]` — expected, see above.

## Components deliberately NOT synced

Roughly a dozen presentational-looking files in `apps/web` import a
`'use server'` action module (`theme-pills`, `assignee-picker`,
`collaborators-picker`, `completion-sheet`, `materials-editor`,
`review-actions`, `task-actions`, `profile-forms`, `sign-out-button`,
`mark-all-read`). A server action only exists while the server is answering a
request, so these cannot render outside the app without stand-ins being written
for them — which would be inventing code rather than shipping Capo's.
`(public)/language-switch.tsx` is the hard case: it calls `cookies()` at module
top level and cannot render anywhere but inside a live request. `chat.tsx` is
excluded as scope (it is the whole chat screen, driven by `useChat`).

## Things that cannot be shown statically

- **`PullToRefresh`** — the pull gesture needs touch input. Its cards show the
  scroller doing its ordinary job, which is the honest render.
- **`TranslationProgress`** — it DRIVES ITSELF: on mount it POSTs to
  `/api/translation/<batchId>/run` and loops. With no endpoint the first request
  fails and it settles into its stopped state, deliberately keeping the last
  known counts. Its `initialStatus` is therefore a starting point, not a display
  prop, and cards labelled "Completed"/"Running" would be a lie. The cards show
  the stopped state at two different counts instead.
- **`PushCard` / `InstallGuide` / `MicButton`** — all three read the VIEWING
  browser (notification permission, platform, speech-recognition support), so
  their cards show whatever state the capture browser was in.
  ⚠ **`PushCard` now captures BLANK, and that is not a regression.** It awaits
  `navigator.serviceWorker.ready`, which never resolves in a preview page
  because no service worker is registered there, so it stays in `loading` and
  `push-card.tsx` returns `null` for that state. Earlier syncs happened to
  capture the "blocked" state instead — the difference is the capture browser,
  not the component or the preview. **The uploaded card is HTML that renders in
  the VIEWER's browser**, so this affects the local screenshot only. It trips
  `[RENDER_THIN] variants render identically` on every run; graded `needs-work`
  and deliberately deferred, since nothing short of registering a fake service
  worker in the harness would change it.

## Finding for the product (not a sync issue)

`packages/ui/src/markdown.tsx` enables `remarkGfm` but its `components` map has
no `table`/`th`/`td` entry, so a model-authored reply containing a GFM table
renders with browser defaults — no cell padding, columns running together
("Por fazerAtrasadas"). Spun off as a separate task.

## Re-sync risks — what can go stale silently

1. **`cfg.dtsPropsFor` is HAND-WRITTEN for 25 components now** (the 9 older ones
   plus the 16 added in #103).**
   The converter could not extract props (there is no `.d.ts` tree, and
   synth-entry mode emitted `[key: string]: unknown` for everything — useless as
   an API contract). The bodies were written from source. **If a component's
   props change, the config does NOT follow and nothing will warn you** — the
   emitted `.d.ts` will simply be wrong, and the design agent codes against it.
   Re-read the signatures in `dashboard-ui.tsx` / `task-detail.tsx` on any
   re-sync that follows a change to those files.
   *The durable fix is to give `@capo/ui` a build* — `tsc --emitDeclarationOnly`
   into `packages/ui/types/` would be auto-detected by `findTypesRoot` with no
   config change, and props would then be extracted from real declarations.
2. **Preview data is inlined.** Every `.design-sync/previews/*.tsx` hard-codes
   obra names, worker names and FIXED dates (2026-08-24 etc). Fixed dates are
   deliberate — the board takes `today` as a prop from `lisbon_today()`, so a
   preview reading the browser clock would drift out of its own data and render
   differently every day. They do not need updating unless a prop shape changes.
3. **The Next contexts are internal paths** (`next/dist/shared/lib/*.shared-runtime`).
   A Next major upgrade can move or rename them; the symptom would be the four
   router-dependent components failing again.
4. **`packages/ui/.ds-styles/capo.css` is gitignored**, so a fresh clone has no
   stylesheet until the compile step above is re-run. It is step one, not an
   optimisation.
5. **Grades are gitignored** (`.design-sync/.cache/`). Cross-machine
   carry-forward comes from the uploaded `_ds_sync.json`; a machine that has
   never synced re-verifies everything, which is correct.
6. **`tailwind-entry.css` drifting from `globals.css`** — the highest-value
   thing to check first, every time. See the ⚠ in the pre-step above; it is
   silent, and it breaks every component that uses a token.
7. **A new component in `packages/ui/src` is NOT picked up automatically.**
   Discovery runs off the `.d.ts` tree, which does not exist here, so
   `cfg.componentSrcMap` is the whole component list. A component added to
   `package.json`'s `exports` but not to the map simply never appears — no
   warning. Compare `ls packages/ui/src` and `ls apps/web/app/_ui` against the
   map on every re-sync.
8. **A second component sharing a name with an existing one repeats the
   EmptyState failure** and is equally silent. If validate reports a component
   "not a component on window.Capo", suspect a duplicate export name first.
9. **Preview composition sources**: `apps/web/app/design-system/page.tsx` and
   `fixtures.ts` (added in #103) are the repo's own usage examples and are what
   the 16 new previews were ported from. Re-read them when a component's API
   changes — they are maintained by the product, unlike the previews.
