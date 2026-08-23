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
(`[NO_DIST] … synthesizing from 3 src files`). That is expected, not a failure.

## Two shim files, both required, both committed

- **`.design-sync/named-exports.ts`** — the converter builds its bundle entry
  with `export * from`, and `export *` does NOT carry a module's DEFAULT export.
  Eleven of the twenty components are `export default function`, so without this
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
  their cards show whatever state the capture browser was in. PushCard currently
  renders the "blocked" state. This is real output, not a failure.

## Finding for the product (not a sync issue)

`packages/ui/src/markdown.tsx` enables `remarkGfm` but its `components` map has
no `table`/`th`/`td` entry, so a model-authored reply containing a GFM table
renders with browser defaults — no cell padding, columns running together
("Por fazerAtrasadas"). Spun off as a separate task.

## Re-sync risks — what can go stale silently

1. **`cfg.dtsPropsFor` is HAND-WRITTEN for all 9 `packages/ui` components.**
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
