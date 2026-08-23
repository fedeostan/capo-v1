# The Capo design system

**Date:** 2026-08-23
**Migration:** none — this touches no database column, no policy, no RPC
**New dependencies:** none
**New CI script:** `pnpm design-check` (credential-free, runs on every PR)

---

## 1. What this is about, in plain language

Capo works. It reads dated. A manager opening it in 2026 sees a 1982 typeface,
form fields whose edges nearly vanish in daylight, buttons that snap rather than
respond, and fifteen slightly different versions of the same orange button. None
of that is a bug — every screen was built correctly, one at a time, with no
shared vocabulary to build from.

After this change there is a vocabulary: a small fixed set of colours, sizes,
spacings, depths and timings, and thirteen building blocks that are the only way
those decisions get expressed. A screen stops choosing `border-zinc-500/30` and
starts saying "the edge of a control". The look becomes something the build can
check rather than something a reviewer has to remember.

Nothing about what Capo *does* changes. No screen gains or loses a feature.

## 2. The four decisions this is built on

Federico chose each of these explicitly on 2026-08-23. They are recorded here
because every value in section 4 follows from them, and changing one of them
invalidates a lot of what follows.

| Dial | Chosen | The alternative that was rejected |
|---|---|---|
| **Scope** | Foundation **plus a full sweep of all 51 screens** | Converting only the five daily screens — rejected because a half-converted app reads as broken rather than in progress |
| **Character** | **Field-first minimal** — Rams discipline, contrast and touch targets tuned up for outdoors | Showroom minimal (soft greys, hairlines) — looks better on a laptop, genuinely harder to read on a sunlit building site |
| **Brand** | **Keep the orange, darken one step** where it carries text | Making orange a rare accent — stronger hierarchy but a brand decision, not a design one |
| **Motion** | **Restrained and functional** — 120–260ms, explains something or it does not exist | Expressive (springs, staggers, animated counters) — risks feeling slow on actions done fifty times a morning |

The build approach chosen was **our own token layer plus our own components**,
over adopting shadcn/ui + Radix. Three reasons, in order of weight:

1. `@capo/ui`'s own file header states it is presentational and
   `'use client'`-free by contract. Almost every shadcn component is a client
   component. Adopting it would push rendering work into the browser on exactly
   the devices and networks Capo is built for.
2. It adds ~8–12 dependencies and ships more JavaScript to a phone on a
   building site.
3. Its default look is a specific, recognisable house style. We would spend
   significant effort making it stop looking like itself.

## 3. What is actually wrong today — measured, not asserted

Every figure below was counted or calculated against the codebase at
`c8e3139`. They are recorded so the design decisions in section 4 can be
audited against evidence rather than taste.

### 3.1 The typeface is loaded and then discarded

`app/layout.tsx` loads Geist and puts `--font-geist-sans` on `<html>`.
`app/globals.css:78` then sets `body { font-family: Arial, Helvetica, sans-serif }`,
which is a direct declaration on `body` and therefore beats the inherited
variable. **Every word in Capo currently renders in Arial.** This single line is
the largest share of the dated feeling and is a one-line fix.

### 3.2 Contrast failures, including on the primary button

| Where | Colours | Ratio | WCAG AA needs | |
|---|---|---|---|---|
| Primary button | `#FFFFFF` on `#EA580C` | **3.56 : 1** | 4.5 : 1 | ❌ |
| Active tab label, 11px | `#EA580C` on white | **3.56 : 1** | 4.5 : 1 | ❌ |
| All secondary text | `#71717A` on white | **4.83 : 1** | 4.5 : 1 | ⚠ scrapes past |
| Input borders | `zinc-500/30` on white | **≈1.8 : 1** | 3 : 1 (WCAG 1.4.11) | ❌ |

The input-border failure matters more than it sounds. That border is the *only*
signal that a box is typeable, which is why the standard applies to it at all.

### 3.3 Everything is the same size, and that size is small

Of ~380 text-size declarations: **153 `text-sm`, 145 `text-xs`, 47 `text-[11px]`**
— 345 of 380 between 11px and 14px. Only 3 are `text-lg`. There is effectively
no typographic hierarchy anywhere in the product.

### 3.4 No shared components

- **60 `<button>`, 33 `<Link>`, 28 `<input>`, 23 `<form>`, 22 `<label>`** — all
  styled by hand
- **15 distinct hand-written primary-button class strings**
- **4 separate implementations of "a row of pills where you pick one"**
  (`tarefas/filter-chips.tsx`, `perfil/theme-pills.tsx`, `perfil/page.tsx`,
  `onboarding/page.tsx`)
- **5 spellings of the card container** (`rounded-xl border border-zinc-500/20`
  and variants)
- Border opacity is chosen ad hoc: `/30` (43×), `/20` (30×), `/40` (11×), `/15`,
  `/10`

### 3.5 Nothing moves, nothing has depth

One `transition-transform` and one animated progress bar in the entire app.
Four shadows, all `shadow-2xl` — so an element is either perfectly flat or
dramatically lifted, with nothing in between.

### 3.6 Accessibility gaps

- **One file** in the whole app uses `focus-visible`. Keyboard users are largely
  invisible.
- The bottom tab bar signals the active tab **by colour alone** (orange + bold).
  Roughly 1 in 12 men has a colour-vision deficiency; construction is a heavily
  male trade. Orange-versus-grey is a difficult pair for the common type.
- The bottom sheet (`_tasks/completion-sheet.tsx:232`) has: no Escape handler,
  no focus trap, no initial focus, no background scroll lock, and no entrance
  animation. Tab out of it and you are silently in the page behind.
- Several controls are ~26px tall (`px-2 py-1 text-xs`) against a 44px minimum.

### 3.7 The two apps each keep their own copy of the colours

`apps/web/app/globals.css` and `apps/operator/app/globals.css` both declare
`--background` and `--foreground` independently. Two copies of a rule
eventually disagree — the same argument this repo already makes about consent
filters and photo writers.

## 4. The token layer

One file, `packages/ui/src/tokens.css`, imported by both apps' `globals.css`.
That import is what ends 3.7.

### 4.1 Colour — roles, not shades

A component never names a colour. It names a role. Dark mode is the same roles
answering differently, which is why it costs one block rather than 51 screens
of patches.

> **Naming, settled by a spike on 2026-08-23:** the text-colour tokens are
> `--fg`, `--fg-muted`, `--fg-faint`, **not** `--text*`. Tailwind v4 owns
> `--text-*` as its *font-size* namespace, so `--text-muted` would generate a
> font-size utility named `text-muted`, colliding with the colour utility of
> the same name. `--fg` yields `text-fg` / `text-fg-muted` for colour and
> leaves `text-body` / `text-caption` for size. The table below uses the old
> names for readability; the plan uses `--fg`.

| Token | Light | Dark | Contrast on surface, or purpose |
|---|---|---|---|
| `--bg` | `#FAFAF9` | `#0C0A09` | page |
| `--surface` | `#FFFFFF` | `#1C1917` | cards, rows, sheets |
| `--surface-sunken` | `#F5F5F4` | `#121110` | inputs, wells |
| `--surface-hover` | `rgb(28 25 23 / .04)` | `rgb(250 250 249 / .06)` | row hover |
| `--text` | `#1C1917` | `#FAFAF9` | 17.5:1 / 16.7:1 |
| `--text-muted` | `#57534E` | `#A8A29E` | 7.6:1 / 6.9:1 |
| `--text-faint` | `#78716C` | `#8C8781` | 4.8:1 / 4.9:1 |
| `--hairline` | `#E7E5E4` | `#292524` | decorative only |
| `--border-control` | `#78716C` | `#78716C` | 4.8:1 / 3.7:1 |
| `--brand` | `#C2410C` | `#FB923C` | 5.2:1 / 7.7:1 |
| `--brand-hover` | `#9A3412` | `#FDBA74` | |
| `--brand-quiet` | `--brand` @ 10% | `--brand` @ 15% | tinted badges |
| `--on-brand` | `#FFFFFF` | `#1C1917` | text on a brand fill |
| `--focus` | `--brand` | `--brand` | 2px ring, 2px offset |

Status colours, all verified against `--surface`:

| Token | Light | Ratio | Meaning |
|---|---|---|---|
| `--danger` | `#B91C1C` | 6.5:1 | blocked, destructive, overdue |
| `--warn` | `#B45309` | 5.0:1 | at risk, trial ending |
| `--success` | `#15803D` | 5.0:1 | done |
| `--info` | `#1D4ED8` | 6.7:1 | unread, informational |
| `--review` | `#6D28D9` | 7.1:1 | `pending_review` — a decision to make, not a problem to fix |

Two notes that are decisions, not details:

- **`--on-brand` inverts in dark mode.** The dark primary button is orange-400
  with near-black text, not white text. White on orange-400 is 2.26:1 — it would fail worse than the bug this whole section exists to fix.
- **`--brand-vivid` (`#EA580C`) survives as a separate token** for large
  non-text fills and `viewport.themeColor`, where the requirement is 3:1 and
  the brighter orange is the one people recognise. It is *never* valid behind
  text. `design-check` enforces that.

### 4.2 Type

The floor rises. Nothing a human reads sits below 13px.

| Token | Size / line-height | Weight | For |
|---|---|---|---|
| `--text-display` | 32 / 36 | 600 | landing page only |
| `--text-title` | 22 / 28 | 600 | screen titles (today: 18) |
| `--text-heading` | 17 / 24 | 600 | task titles, section heads |
| `--text-body` | 16 / 24 | 400 | **the default** (today: 14) |
| `--text-callout` | 15 / 20 | 400 | dense list rows |
| `--text-caption` | 13 / 18 | 400 | meta, timestamps (today: 11) |
| `--text-micro` | 11 / 14 | 600, `+0.04em` | badges only |

And `body { font-family: Arial … }` is deleted so `--font-geist-sans` takes
effect.

### 4.3 Spacing — restrict, don't reinvent

Tailwind's existing scale already maps to a 4px base (`p-4` = 16px). Inventing
a parallel scale would mean rewriting every spacing class for no gain. So the
rule is a **restriction**: only `1, 2, 3, 4, 6, 8, 12, 16` are legal.
`2.5`, `1.5`, `5`, `7`, `9`, `10` and arbitrary values are denied by
`design-check`.

The rule that does the actual work — Gestalt proximity:

> **Space inside a group ≤ 8px. Space between groups ≥ 24px.**

No boxes, no dividers, no headings required. The eye groups by distance alone.

### 4.4 Depth and blur

| Level | Treatment | Where |
|---|---|---|
| 0 | nothing | the page |
| 1 | 1px `--hairline`, no shadow | cards, list rows |
| 2 | `--shadow-2` + hairline | sticky headers, dropdowns |
| 3 | `--shadow-3` | bottom sheets, dialogs |

```
--shadow-2: 0 1px 2px rgb(0 0 0 / .06), 0 1px 3px rgb(0 0 0 / .04);
--shadow-3: 0 8px 24px rgb(0 0 0 / .12), 0 2px 6px rgb(0 0 0 / .06);
```

**Shadows barely work on a dark background** — a black shadow on a near-black
page is invisible. In dark mode both levels additionally lift the surface one
step and strengthen the border, which is how depth is actually communicated
there. This is a real asymmetry, not an oversight.

**Blur has exactly two permitted uses:** the sticky top bar (translucent, so
content is visibly passing underneath — a status cue) and the scrim behind a
sheet. Anywhere else it costs GPU and battery on cheap Android phones for no
information.

### 4.5 Motion

| Token | Value | For |
|---|---|---|
| `--duration-fast` | 120ms | press, hover, focus ring |
| `--duration-base` | 180ms | colour, opacity, size |
| `--duration-slow` | 260ms | sheets, page transitions |
| `--ease-out` | `cubic-bezier(.2, 0, 0, 1)` | almost everything |
| `--ease-spring` | `cubic-bezier(.34, 1.3, .64, 1)` | sheet entrance only |

**How these reach a component, verified by spike rather than assumed.** Tailwind
v4.3.2 has **no `--duration-*` theme namespace**, so `duration-fast` is not a
utility and would fail silently. Two mechanisms, both confirmed working:

- `--default-transition-duration: 180ms` in `@theme` — a bare `transition-colors`
  then runs at 180ms with no duration class at all. This covers most components.
- `duration-(--duration-fast)` — Tailwind v4's variable shorthand, for the
  places that want 120ms or 260ms. Measured at `0.12s`.

`--ease-out` **is** a real namespace key, so overriding it redefines Tailwind's
built-in `ease-out` globally, which is intended. And no custom `tap-target`
utility is needed: `min-h-11 min-w-11` already means 44px.

Fast start, gentle stop — motion that begins instantly feels responsive even
when it takes 260ms to settle. A global `@media (prefers-reduced-motion: reduce)`
block collapses every duration to `0.01ms`, which switches motion off for users
who have that accessibility setting on, without any component knowing.

### 4.6 Radius

`8` chips · `12` buttons and inputs · `16` cards · `20` sheets · `full` pills.
Nested radius = outer minus padding, so a button inside a card looks concentric
rather than accidental.

### 4.7 Touch targets

Nothing tappable under **44×44px**; primary actions **48px**. Apple HIG and
Material minimums, and non-negotiable for a man in work gloves.

## 5. The components

Thirteen. Ten need no browser JavaScript at all — press, hover, focus and the
pressed animation are pure CSS — so they live in `@capo/ui` and preserve its
`'use client'`-free contract. Three genuinely need to react and stay in
`apps/web`.

### 5.1 In `@capo/ui` (server-rendered, zero JS)

**`Button`** — `variant: 'primary' | 'secondary' | 'tertiary' | 'destructive'`,
`size: 'sm' | 'md' | 'lg'`, `loading`, `disabled`, `icon`, `fullWidth`.
`ButtonLink` is the same surface over `next/link`.

| Variant | Treatment | Means |
|---|---|---|
| primary | solid `--brand`, `--on-brand` text | *the one thing this screen is for* |
| secondary | `--surface` fill, `--border-control`, `--text` | a real alternative |
| tertiary | text only, no box | low-stakes or repeated |
| destructive | outlined `--danger`; solid **only** on a final confirm | deleting |

> **Rule: at most one primary button per screen.** If two are needed, one of
> them is not primary. This is the single highest-value rule in the document.
> Three solid orange buttons force the manager to read all three; one solid
> button means he does not read at all.

`loading` keeps the button's exact rendered width so the layout does not jump
on tap — the spinner replaces the label in place.

**`IconButton`** — `label` is a **required** prop, rendered as `aria-label`. An
unlabelled icon button is invisible to a blind user; making the label required
turns a code review you must remember into a build failure. Enforces 44px.

**`Card`** — level-1 container. `padding: 'none' | 'sm' | 'md'`, optional
`as="section"`.

**`ListRow`** — leading icon/avatar, title, meta, trailing chevron or action.
Whole row tappable at ≥56px. Absorbs the hand-built row markup on every list
screen.

**`Field`** — wraps `Input`, `Select`, `Textarea`. Label, hint and error are
**always** wired via `id`/`aria-describedby`/`aria-invalid`, so a screen reader
announces the error and the label is tappable. Today 28 inputs and 22 labels are
connected by hand, inconsistently.

**`Badge`** — `tone: 'neutral' | 'info' | 'warn' | 'danger' | 'success' | 'brand' | 'review'`.
Generalises the existing `StatusBadge`, which keeps its current API and status
map and delegates.

**`Banner`** — one component for the billing strip and the notifications strip.
`tone`, `icon`, optional `href`, optional dismiss.

**`EmptyState`** — icon, line, suggested action. An empty screen should say what
to do next.

**`AppBar`** — replaces `ScreenShell`'s header. Sticky, translucent + blurred,
22px title, optional back button and one trailing action. `ScreenShell` keeps
its current signature and delegates, so no caller changes.

> The back button is an explicit `<Link href>`, never `router.back()`. Browser
> history can lead out of the app entirely; a declared destination cannot. It is
> also what keeps this component free of JavaScript.

**`Skeleton`** — shaped like the content that is coming, not a generic grey bar.

### 5.2 In `apps/web` (need browser JavaScript)

**`Sheet`** — replaces the four hand-rolled modals. Adds every one of the five
things `completion-sheet.tsx` lacks today: Escape closes, focus is trapped
inside, focus moves in on open and returns to the trigger on close, the page
behind is scroll-locked, and it slides up over `--duration-slow` with
`--ease-spring`. Plus a grab handle and a blurred scrim.

**`SegmentedControl`** — one component replacing the four pill implementations.
Arrow-key navigable, `role="radiogroup"`.

> **It must keep working before JavaScript loads.** `theme-pills.tsx` and
> `onboarding/page.tsx` are plain `<form>`s with `peer-checked` styling
> precisely so a cold PWA on a slow phone can still save. The component keeps
> the radio-input structure; JavaScript only enhances it.

**`TabBar`** — the bottom nav. Needs `usePathname`.

- **Two signals for the active tab**, not one: brand colour **and** a filled
  icon (inactive tabs use outline icons). Works with no colour perception at
  all, which fixes 3.6.
- Labels 11px → 13px, targets 48px, `pb-[env(safe-area-inset-bottom)]` retained
- Translucent with a backdrop blur, hairline top border
- The active icon scales briefly (120ms) on change

### 5.3 Deliberately not built

- **No collapsing large-title header.** An Apple signature, but it needs scroll
  listeners on every screen for pure decoration.
- **No custom dropdown or date picker.** The native ones work offline, handle
  keyboards correctly, and match the phone. Capo's are native today.
- **No animation library, no icon-set change, no theming beyond the two modes.**
- **No new `dark:` utilities in screens.** If a screen needs one, a token is
  missing.

## 6. Invariants that must survive the sweep

Each of these is written into the codebase's own comments as load-bearing. A
careless restyle would undo them silently.

| Must survive | Why |
|---|---|
| `html, body { overflow: hidden; overscroll-behavior: none }` | without it the whole UI drags on a touch gesture, tab bar included |
| `BillingBanner`/`NotificationsStrip` staying **siblings** of the content column | children of it are clipped by `overflow-hidden` |
| `pb-[env(safe-area-inset-bottom)]` on the tab bar, `pt-` on `<body>` | notch and home indicator |
| The `@custom-variant dark` **block** form in `globals.css` | its own comment: the selector form emits siblings and breaks the theme cookie |
| Theme pills and onboarding pills working pre-hydration | a cold PWA on a slow phone must still save |
| Materials groups using native `<details>` | collapse state survives a server-action revalidation; React state would not |
| `ScreenShell` owning no scroller | scrolling belongs to `PullToRefresh`; two would fight |
| Components staying **inside** `packages/ui/src` or `apps/web/app` | `@source` is a directory glob, so files there are auto-detected; one placed elsewhere loses every style with no error |
| **No `@utility` rule inside `tokens.css`** | proven by spike: Tailwind silently discards the *entire imported file*, no error and no warning. `@utility` only works in an app's own `globals.css`. The design needs none — see §4.5 |
| `viewport.themeColor` staying a single value, not the `[{media, color}]` form | that form keys off `prefers-color-scheme`, the exact signal the theme cookie exists to override |

## 7. Verification

Capo has no test suite. `AGENTS.md` says so plainly. Three mechanisms replace
one.

### 7.1 `pnpm design-check` — the design contract, machine-checked

A credential-free script in the established idiom of `scheduler-check`,
`cache-check`, `guard-check` and `cost-check`, running in CI on every PR. It
asserts:

1. **Every foreground/background token pair clears its threshold**, calculated
   from the hex values: 4.5:1 for text, 3:1 for large text and control borders.
   *This check would have caught the orange primary button on the day it
   shipped.*
2. `--brand-vivid` never appears behind text.
3. No raw palette colour (`text-zinc-*`, `bg-orange-*`, `border-zinc-*`) in app
   or component code — roles only.
4. No spacing step outside `1, 2, 3, 4, 6, 8, 12, 16`.
5. No `text-[11px]` or arbitrary text size outside `Badge`.
6. Every `Button`/`IconButton` size declaration meets 44px.

A rule that is only written down erodes. A rule that fails the build holds.
This is the same move `AGENTS.md` makes everywhere else — "enforced by `tsc`,
not by review" — pointed at colour and size.

### 7.2 `/_design` — the component gallery

One development-only route rendering every component in every state: four
button variants × three sizes × loading/disabled, every badge tone, fields with
errors, sheets, empty states, skeletons — light and dark side by side. Lets the
system be reviewed without logging in or hunting for a screen that happens to
contain a disabled button.

### 7.3 `/_design/screens` — real screens, fake data

A second development-only route rendering the actual screen components against
**static sample data**, no auth and no database. Three advantages over a real
login:

- Needs no credentials from anyone, ever.
- The data is identical every time, so a before/after screenshot comparison
  isolates the design change. With live data, rows move and a layout change is
  indistinguishable from a data change.
- It can render the hard cases on demand — a 90-character task title, an overdue
  task, an empty board, a worker with no name — the states that break layouts
  and that browsing a healthy live account never surfaces.

Both routes are gated on `process.env.NODE_ENV !== 'production'` and return
`notFound()` otherwise.

## 8. Rollout

Nine changes, **strictly sequential**. Never parallel: GitHub reports
mergeability only against `main`, never between two open branches, so two design
PRs touching the same files is precisely the case that merges cleanly and is
wrong.

| # | Change | What becomes visible |
|---|---|---|
| 0 | `tokens.css` shared by both apps; delete the Arial line; motion + reduced-motion; focus ring | The whole app switches to Geist. Large, immediate, and nothing else moves. |
| 1 | Build all thirteen components + `/_design` + `/_design/screens` + `design-check` | Nothing. Used by no screen yet — safe by construction. |
| 2 | The shell: `TabBar`, `AppBar`, the two banners | The frame around every screen |
| 3 | Chat (`/`), mic button, pull-to-refresh | |
| 4 | Tarefas — list, filters, detail, its sheets | The densest and highest-risk screens |
| 5 | Obras + Materiais | |
| 6 | Perfil and sub-pages, notifications, subscription | |
| 7 | Public — landing, login, register, recover, onboarding, install, whatsapp, offline | The first thing a new customer sees |
| 8 | `apps/operator` (9 screens) | Internal tool, last |

Stopping after any step leaves the app in a coherent state.

### 8.1 The one hard rule for every conversion

> **A conversion commit changes how something looks. It never changes what it
> does.**

No server action, no form field `name`, no `href`, no data loading is touched in
the same change as a restyle. If a screen genuinely needs a behaviour change,
that is separate work with separate approval. This is what makes a 51-screen
sweep reviewable: every diff is "this got new classes", never "this got new
logic".

## 9. Risks and trade-offs, stated rather than buried

**Something can break silently.** With no test suite, a restyle that accidentally
drops a form field's `name` would look perfect and quietly stop saving. Section
8.1 and the small sequential steps are the mitigation. They are not a guarantee,
and this document does not claim one.

**Less fits on screen.** Bigger text, 44–48px targets and 24px between groups
means a task list showing 9 rows today may show 6–7. This is the correct trade
for a manager outdoors, but it is a real cost and it is the change most likely to
grate after a week. It is tunable in one file: dropping `--text-body` to 15px and
group gaps to 16px reverses most of it globally.

**Input borders become noticeably more present.** Going from ~1.8:1 to 4.8:1 is
not a subtle change. Paired with the increased internal padding it should read as
crisp rather than heavy, but it will look different immediately.

**Dark mode is currently barely designed, so it will change the most.** Today
there are ~36 `dark:` utilities and all of them merely rescue coloured text.
There is no dark card, no dark border, no dark input. After this it is a real
design. Anyone using dark mode should expect the largest visual change of anyone.

**`design-check`'s denylist will fail on legitimate one-offs.** Section 7.1 rules
3–5 are blunt. The escape hatch is an explicit, commented allowlist in the
script, in the same shape `rls-isolation-matrix.mjs` uses — never a silent
exception.

## 10. File map

**New**

- `packages/ui/src/tokens.css` — the single source of every value in section 4
- `packages/ui/src/button.tsx`, `card.tsx`, `list-row.tsx`, `field.tsx`,
  `badge.tsx`, `banner.tsx`, `empty-state.tsx`, `skeleton.tsx`, `app-bar.tsx`
  (`IconButton` ships inside `button.tsx` — same variants, square)
- `apps/web/app/_ui/sheet.tsx`, `segmented-control.tsx`
- `apps/web/app/_design/page.tsx`, `apps/web/app/_design/screens/page.tsx`
- `apps/web/app/_design/fixtures.ts` — the static sample data
- `scripts/design-check.mts`

**Modified**

- `apps/web/app/globals.css` — import tokens, delete the Arial line, keep the
  `@custom-variant dark` block untouched
- `apps/operator/app/globals.css` — import tokens, delete its duplicate `:root`
- `apps/web/app/bottom-nav.tsx` — becomes `TabBar`
- `packages/ui/src/dashboard-ui.tsx` — `ScreenShell` delegates to `AppBar`,
  `StatusBadge` delegates to `Badge`
- `package.json` — the `design-check` script
- `.github/workflows/*` — add `pnpm design-check` to the gate
- All 51 screens, in the order of section 8

**Untouched**

Every server action, every route handler, `packages/core`, `packages/db`,
`packages/i18n`, every migration, `vercel.json`.
