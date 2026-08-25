# Home launchpad, persistent top bar & profile drawer

**Date:** 2026-08-24
**Source:** Claude Design handoff `design_handoff_home_launchpad_nav`
(`Capo Home Launchpad.dc.html` + README + 7 screenshots)
**Migration:** none in Round 1. Round 3 (Activity feed) may need one — decided there.
**New dependencies:** none
**New CI script:** none (`pnpm design-check` already gates the token layer)

---

## 1. What this is about, in plain language

Capo opens onto a conversation. That is the right front door for telling Capo
what happened, and the wrong one for finding out what is happening. A manager
at 07:00 wants three answers — what is on today, what is waiting on me, what did
the crew do — and today he gets a blinking cursor.

After this work he gets a launchpad: a stack of widgets answering exactly those
questions, with the conversation one tap away instead of zero. Above it, a bar
that follows him onto every screen carrying his own name, and the three things
he does most. Behind his face, a drawer with four clearly-named rooms replacing
one settings page he has to scroll.

Nothing Capo *does* is removed. Two tabs leave the bottom bar and both land
somewhere better: Materiais becomes a view on Obras, Perfil becomes the drawer.

## 2. The decisions this is built on

Federico chose each of these explicitly on 2026-08-24, after being shown what
each one costs. Every design choice below follows from them.

| Decision | Chosen | What was rejected, and why it mattered |
|---|---|---|
| **Bottom bar** | Materiais moves **inside Obras**; Perfil becomes **the drawer**; the freed slots become Home and Atividade | Keeping Materiais in the bar — rejected because Obras is where materials belong, and a switch costs one tap rather than a feature |
| **Materiais shape** | **Two views on the Obras screen** (`Obras | Materiais`), buy-list untouched | Per-site materials only — rejected because it destroys the one list that answers "what do I buy tomorrow across all three sites", which is the feature's whole value |
| **Atividade** | **A real site feed** — closed tasks, photos, check-ins, claims, time-ordered | Promoting the notifications inbox as-is — rejected because it only ever carries one kind of row, so the tab would usually be empty and Home's feed widget would still need building |
| **Sequencing** | **A — shell, then Home, then Activity** | One big round (no early feedback) and Home-first-at-a-temp-URL (slowest to the design) |
| **Delete account** | **Row and sheet ship; deletion does not** | Building real erasure now — deferred, see §4.6 |
| **Search** | **Icon ships, inert** | Building search now (grows Round 1 a lot) and pointing it at the Tarefas filter (reads as broken search) |
| **Drawer rooms** | **Five**, not the handoff's four — Billing is its own room, and Automatic messages sits in Settings, not Privacy | Folding Subscription into Personal information — rejected because billing is the room a manager goes looking for by name |
| **Materiais access** | **A switch on Obras**, not a "Ver materiais" link | A link — rejected on discoverability: it demotes Materiais twice (a tap *and* the word disappearing) where a switch demotes it once. See §4.5 |

## 3. What the handoff asks for that Capo does not have

The handoff is high-fidelity and internally coherent. It was written from
pictures of the app, so several controls in it are front doors to rooms that
were never built. Each was verified against the codebase, not assumed.

| The handoff specifies | Reality | Resolution |
|---|---|---|
| `BottomNav`, `InstallGuide`, `PushCard`, `PullToRefresh` in `@capo/ui` | **Do not exist.** `TabBar` is in `apps/web/app/_ui`; `PullToRefresh` is `apps/web/app/pull-to-refresh.tsx`; the install and push cards are inline on `/perfil` | Use what exists; do not create packages/ui components to satisfy a mapping table |
| `ScreenShell`, `StatusBadge` in `@capo/ui` | Exist, but in `dashboard-ui.tsx`, not the modules AGENTS.md lists | Import from `@capo/ui/dashboard-ui` |
| "Cement delivery signed for — 2 pallets short" in the activity feed | **No delivery, goods-in or receipt concept exists anywhere in the schema.** Materials are notes on a task | Drop that row. Round 3's feed carries only events that are actually recorded |
| Team: "8 people · 2 invites pending", "Roles & permissions" | **No invites. No roles.** `workers` has no invite state and no permission model | Drop both. Team shows the real crew list only |
| "Delete account" row + typed-confirmation sheet | **No deletion anywhere.** The schema has exactly one DELETE policy in the entire database (`push_subscriptions`), by deliberate design | §4.6 — row and sheet ship, destructive button permanently inert |
| Search in the top bar | **No search of any kind** | Icon ships `disabled` |
| "New task" button | No new-task screen or form exists | Points at the chat with the composer focused — this is genuinely how Capo creates tasks (`create_task` via conversation), not a workaround. **`Chat` accepts `initialInput` fed from `?q=` today, but nothing focuses the composer** — that focus behaviour is new work in Round 1 |
| Voice note button | The recorder exists — `apps/web/app/mic-button.tsx` — but **only as a control inside the chat composer.** There is no URL that opens it | Round 1 adds one search param, `voice=1`, which `(app)/page.tsx` passes to `Chat` to arm the recorder on mount. Small, but real work, not a link |
| Home widgets: next tasks, decisions, crew, materials | All have real loaders (`loadBoardTasks`, `loadPendingReviews`, `loadTeamLoad`, `loadMaterials`) | Round 2 wires them |
| Home widget: "What just happened" | No single source; needs the Round 3 query | Round 2 ships Home **without** it; Round 3 adds it and the tab together, sharing one source |

## 4. Round 1 — the shell

Round 1 is deliberately **almost pure interface**. No new database reads, no new
queries, no migration; everything it renders is already loaded somewhere today.
The one exception is two new search params on the chat page (`voice`,
`compose`, §4.2) so the top bar's two right-hand buttons have real
destinations — named here so it is not discovered mid-build.

That near-purity is what makes Round 1 safe to ship first and judge on a real
phone.

### 4.1 The bottom bar

Four tabs in Round 1, five in Round 2:

| | Round 1 | Round 2 onward |
|---|---|---|
| 1 | Chat → `/` | Home → `/` |
| 2 | Tarefas → `/tarefas` | Tarefas → `/tarefas` |
| 3 | Obras → `/obras` | Chat → `/chat` |
| 4 | Atividade → `/notificacoes` | Obras → `/obras` |
| 5 | — | Atividade → `/atividade` |

**Four, not five, and this is load-bearing.** Home does not exist until Round 2.
A Home tab pointing at `/` alongside a Chat tab pointing at `/` gives two tabs
one destination, both lit by the prefix-match rule in `tab-bar.tsx`. The grid
goes `grid-cols-4` → `grid-cols-5` in Round 2.

Atividade points at `/notificacoes` in Rounds 1–2. This is not a placeholder: it
is the closest real surface, it keeps its unread count, and Round 3 widens it
rather than replacing it.

**`nav` catalog changes** (`packages/i18n/src/catalog.ts` + all three
dictionaries — the `Catalog['nav']` type makes a missed dictionary a `tsc`
error, which is why `tab-bar.tsx` types `key` against it):

- add `home` (PT "Início" / ES "Inicio" / EN "Home")
- add `activity` (PT "Atividade" / ES "Actividad" / EN "Activity")
- keep `materials` (still used by the Obras switch) and `profile` (still used by
  the drawer header and `/perfil`)

**The notifications strip stays.** It is tempting to retire `NotificationsStrip`
in `(app)/layout.tsx` now that Atividade has a tab, and that is wrong until
Round 3: the strip's justification is that an unread decision must be
unmissable, and a tab label is not a count. Revisit when the tab carries a
badge.

### 4.2 The persistent top bar

New component: `apps/web/app/_ui/top-bar.tsx` (`'use client'` — it owns the
drawer's open state). Rendered in `(app)/layout.tsx` **above** the content
column, as a sibling of the two banner strips, for the same reason they are
siblings: the content column is `overflow-hidden` and would clip an absolutely
positioned drawer.

Layout follows the handoff exactly (§1 of its README): `space-between`, padding
`6px 10px 10px`, `bg-surface`, bottom hairline.

- **Burger** 40×44, `aria-label` from the catalog, opens the drawer.
- **Profile block** 44px tall — 36px `--brand-quiet` avatar with the manager's
  initials, a `--success-solid` presence dot, then name over company name. Both
  strings are **already loaded** by `getAuthState` + the layout's existing
  reads; no new query.
- **Search** 44×44, `disabled`, `aria-label` present. Disabled rather than a
  no-op click handler so assistive technology does not announce a working
  button (Federico's call was "nothing happens"; `disabled` is how that is said
  honestly).
- **Voice note** 44×44 → `/?voice=1`. **This param does not exist yet.**
  `(app)/page.tsx` reads `?q=` and passes it to `Chat` as `initialInput`;
  `voice` is a second param on the same path, passed down to arm the recorder on
  mount. Two files, small — but it is work, and it is the one place Round 1
  touches chat behaviour rather than chrome.
- **New task** 44×44, solid `--brand` — the only solid brand fill in the bar →
  `/?compose=1`, which focuses the composer. Same shape and same two files as
  `voice`. Nothing focuses the composer today.

**One bar per screen, never two.** Today every tab screen renders its own
`ScreenShell` with a title. The persistent bar replaces that on the tab screens
(four in Round 1, five from Round 2): their titles move into the scroller as a
heading, the way Home's greeting does. Drill-down screens (`/tarefas/[id]`,
`/obras/[id]`, `/perfil/*`) keep their own `AppBar` **instead of** the
persistent bar, because that bar carries Back and Back outranks the avatar
there.

Mechanically: the persistent bar renders only when the route is one of the tab
roots. It reads `usePathname()` and returns `null` otherwise. This is a
deliberate exception to "the layout renders it once" — the alternative is every
detail route opting out, which is a rule someone eventually forgets.

### 4.3 The drawer

New component: `apps/web/app/_ui/profile-drawer.tsx` (`'use client'`).

330px, slides from the left, `translateX(-102%)` → `0` over **260ms
`cubic-bezier(0.32, 0.72, 0, 1)`**; scrim `rgb(28 25 23 / 0.45)` over 220ms,
`pointer-events: none` when closed, tap-to-close.

It must reuse `Sheet`'s hard-won behaviours rather than re-derive them — escape
closes, focus moves in and is handed back, tab does not walk out, the page
behind does not scroll. `Sheet` is a bottom sheet and cannot be used directly;
the focus-trap and scroll-lock logic should be **extracted** from
`_ui/sheet.tsx` into a shared hook both call. Two copies of a focus trap is how
one of them silently stops working.

Contents per the handoff: header (48px avatar, name, "Site manager · <company>",
44×44 close), the section list (**five rows** — see §4.4), the install card, and
a footer with Sign out + version.

The install card and sign-out already exist inline on `/perfil`; they move here
rather than being rewritten.

### 4.4 The five rooms

The handoff draws four. Federico added a fifth on 2026-08-24 — **Billing** —
and moved Automatic messages out of Privacy into Settings, on the grounds that a
daily summary is about how Capo is used, not about what it knows.

Real routes, not client-side panels:

| Drawer row | Route | Absorbs from `/perfil` |
|---|---|---|
| Personal information | `/perfil/pessoal` | `profile.company`, `profile.yourAccount` |
| Team | `/perfil/equipa` | `profile.team` |
| Billing | **`/subscricao`** — already exists | `profile.subscription` (the card becomes the row's subtitle) |
| Privacy | `/perfil/privacidade` | `memory.title`, `notifications.title`, `settings.whatsappConsent` |
| Settings | `/perfil/definicoes` | `settings.language`, `settings.appearance`, `settings.confirmPosture`, `automations.title`, `profile.app` |

**Billing needs no new route.** `/subscricao` is a complete screen with its own
`actions.ts` (Stripe checkout + portal). `/perfil`'s subscription card is only a
status line and a link into it, so the card collapses into the drawer row's
subtitle — which is strictly better than today, where the manager learns their
trial is ending by scrolling to the bottom of a long page.

Consequence to note: the drawer's section list is now **five rows, not four**,
against the handoff's screenshot. A list growing by one row needs no design
decision; it is called out only so the screenshot and the build differing is not
read later as a mistake.

**Routes rather than panels, for three reasons, in order of weight:**

1. Those cards save with **plain `<form>` + server actions**, which is why
   `SegmentedControl` is built on radio inputs and says so in a shouted comment:
   a cold PWA on a bad site connection must be able to change language and save
   before any JavaScript has run. Moving them inside a client-rendered drawer
   panel puts that property at risk for an animation.
2. Refresh-safety and the phone's back gesture come free.
3. `/perfil/automacoes` and `/perfil/memoria` already exist as routes; four
   siblings is the pattern already in the tree.

**Cost, stated:** the handoff shows a panel sliding over a still-open drawer,
with Back returning to it. With routes, Back is a navigation and the drawer
re-opens. Visually near-identical; one frame different. Accepted.

`/perfil` survives as a plain page rendering the same four rows — bookmarks keep
working, the drawer is a shortcut into the rooms rather than the only door, and
a desktop-width browser has somewhere sensible to land.

**AGENTS.md must be updated by this change.** It currently states: *"Both dials
live on `/perfil` (there is no `/definicoes` route)"*. After this, both language
dials and the appearance dial live on `/perfil/definicoes`. `LanguageDriftNote`
moves with the Language card and must stay **above** the control that fixes the
drift, not inside the advanced disclosure — a manager who does not know the
split exists will not open a disclosure about it.

### 4.5 Obras gets a switch

`SegmentedControl` at the top of `/obras`: `Obras | Materiais`.

**A switch rather than a "Ver materiais" link, decided 2026-08-24.** Both cost
one extra tap; they differ in what they cost *discoverability*. Materiais was a
tab yesterday — the word was visible without any action. A link inside the
scroller demotes it twice (a tap, and the word vanishing until you scroll to
it); a switch demotes it once (a tap, word still visible on landing). That
weighting matters more than usual for this screen specifically: the buy-list is
consulted **before leaving for the supplier**, i.e. at the moment the manager is
already thinking about something else and needs reminding it exists.

The objection, recorded because it is real: a switch implies Materiais is a
filtered view of the sites list, and it is not — it is a different question
(what to buy, by day) about the same work. Judged the smaller cost. The switch
is also trivially reversible if Materiais is ever promoted back to a tab.

The existing `/materiais` page body moves in unchanged — the tomorrow / this
week grouping and `MaterialsList` are untouched. `/materiais` stays as a route
and redirects to `/obras?vista=materiais`, so nothing bookmarked breaks and the
switch state is a URL param rather than client state (refresh-safe, and the
server can render the right view directly).

Note `SegmentedControl` today is a scrolling pill row, not the 3-up grid track
the handoff draws. For a two-way switch that difference does not show. Round 2's
Settings screen wants the grid track for its 3-up PT/ES/EN and
Light/Dark/System controls; that is where the component grows a `variant`, not
here.

### 4.6 Delete account

The row ships at the bottom of `/perfil/definicoes`, styled as drawn —
full-width 56px, `--danger-quiet` / `--danger`, with "Cannot be undone" trailing.

The sheet opens as drawn: grabber, `--danger` title, the body copy, the
confirmation input, Cancel and Delete forever.

**The destructive button is permanently `disabled`, and the sheet says why in
one plain line.** It does not become enabled when the company name is typed.
Federico's decision was "add the button, don't create the route yet"; a control
that arms itself on a correct answer and then does nothing would leave a manager
believing their account was gone. The typed-confirmation gate is built and
wired to nothing, so Round 4 (if it happens) enables it by deleting one prop.

Recorded as a deferral, not an omission: **EU data protection law gives an
individual a right to erasure, and Capo has no route to it.** That gap exists
today and this change neither creates nor closes it.

## 5. Invariants that must survive Round 1

These are properties the codebase has today that this change could plausibly
break without any test noticing. Every one has been checked against the source.

1. **`SegmentedControl`'s radios stay radios.** Not buttons, not client state.
   The no-JavaScript save path is the reason.
2. **The two banner strips stay siblings of the content column**, never children
   — the column is `overflow-hidden` and would clip them. The top bar and drawer
   join them as siblings for the identical reason.
3. **`(app)/layout.tsx` never becomes the auth gate.** A layout persists across
   client navigations; auth is per-route via `requireAuth()`. The top bar's
   profile block reads from the layout's existing opportunistic `getAuthState`
   and must render nothing rather than throw when there is no session.
4. **`countUnread` keeps swallowing its own errors.** The shell renders above
   every route and must never be why a screen fails.
5. **Every tap target ≥44px**, and every icon-only control carries a label —
   `IconButton` enforces this at the type level; hand-rolled buttons in the top
   bar must carry `aria-label` explicitly.
6. **`pnpm design-check`'s `UNCONVERTED` list may only shrink.** Moving
   `/perfil`'s cards into four files must not re-introduce raw hex or
   `text-zinc-*`; note `/perfil/page.tsx:39` currently has a `text-zinc-500`
   heading that should be converted on the way rather than copied four times.
7. **Locale is a prop, per component.** There is no provider. Every new screen
   takes `locale` and resolves its own catalog.
8. **No `@utility` may enter `tokens.css`**, and no route folder may start with
   an underscore. `apps/web/app/_ui/` is correct because it is components, not
   routes.

## 6. Verification

There is no test suite. The gate is `pnpm turbo lint typecheck build` plus the
credential-free check scripts. For this change specifically:

- **`tsc` carries the nav change.** Adding `home`/`activity` to `Catalog['nav']`
  makes a missed dictionary a compile error at the dictionary, and a typo'd key
  a compile error in `TABS`.
- **`pnpm design-check`** must stay green and `UNCONVERTED` must not grow.
- **`/design-system/screens`** gains the new shell cases: top bar with a long
  company name, drawer open, drawer at 320px width, and the delete sheet with
  its inert button. That gallery is dev-only and needs no login.
- **Manual, on a real phone, before Round 2 starts:** change the language on
  `/perfil/definicoes` with JavaScript disabled and confirm it saves. That is
  the single property most at risk in this round and nothing automated covers
  it.
- **Grep `proposals` for `status='pending'`** is *not* needed here — no prompt
  text changes in Round 1.

## 7. Risks and trade-offs, stated rather than buried

1. **Perfil is taken apart.** Twelve working cards redistribute into four files.
   Nothing is dropped, but these cards save real settings — language, WhatsApp
   consent, confirm posture, memory — and a broken save is silent. This is the
   highest-risk part of Round 1 by a distance. Mitigation: move the cards
   **verbatim**, changing only their file and their surrounding shell. No
   rewrite, no tidy-up, in the same commit.
2. **The bar costs ~50px of vertical space on every screen, permanently**, on a
   phone. Real tax on the task list; accepted for what it buys.
3. **The first thing Federico feels is unfamiliarity with no payoff**, because
   Home arrives in Round 2. That is the deliberate cost of sequencing A.
4. **Two inert controls ship** (search, delete-forever). Both are Federico's
   explicit call and both are rendered `disabled` so they are honest to
   assistive technology. They are still, by construction, things the app shows
   and cannot do.
5. **The focus-trap extraction touches `Sheet`**, which four existing surfaces
   already depend on. Extracting is right and copying is worse, but this is a
   change to working code in service of new code.

## 8. Rounds 2 and 3, in outline

Not specified here — each gets its own spec when it starts. Recorded so the
shape is not lost.

**Round 2 — Home launchpad.** `/` becomes the launchpad; chat moves to `/chat`;
the bar goes to five tabs. Five widgets: greeting, Next up today
(`loadBoardTasks`), Needs your decision (`loadPendingReviews`), Today's crew
(`loadTeamLoad`), Materials running low (`loadMaterials`). **"What just
happened" is deliberately absent** — it ships in Round 3 with the tab, from one
source, so the two can never disagree. Every widget needs an empty state; the
handoff has none. `Skeleton` / `EmptyState` already exist.

**Round 3 — Atividade.** A real site feed at `/atividade`, and the Home widget
reading the same loader. Sources that genuinely exist: task status changes,
`task_reviews` claims, `task_photos` arrivals, `worker_checkins`. Deliveries do
not exist and are not invented. Open question for that spec: whether this is a
query unioning several tables at read time or a new events table — the first is
cheaper and correct today, the second scales.

**Round 4 — account deletion.** Named, unscheduled. Legal as much as technical.

## 9. File map

**New**
- `apps/web/app/_ui/top-bar.tsx` — persistent bar, owns drawer state
- `apps/web/app/_ui/profile-drawer.tsx` — the drawer
- `apps/web/app/_ui/use-overlay.ts` — focus trap + scroll lock, extracted from `sheet.tsx`
- `apps/web/app/(app)/perfil/pessoal/page.tsx`
- `apps/web/app/(app)/perfil/equipa/page.tsx`
- `apps/web/app/(app)/perfil/privacidade/page.tsx`
- `apps/web/app/(app)/perfil/definicoes/page.tsx`
- `apps/web/app/(app)/perfil/definicoes/delete-account-sheet.tsx`

**Changed**
- `apps/web/app/(app)/layout.tsx` — renders `TopBar`
- `apps/web/app/_ui/tab-bar.tsx` — four tabs, new order, new keys
- `apps/web/app/_ui/sheet.tsx` — consumes the extracted hook
- `apps/web/app/(app)/perfil/page.tsx` — becomes the five-row list
- `apps/web/app/(app)/obras/page.tsx` — gains the `Obras | Materiais` switch
- `apps/web/app/(app)/materiais/page.tsx` — redirects to `/obras?vista=materiais`
- `apps/web/app/(app)/tarefas/page.tsx`, `obras/page.tsx` — title moves into the scroller
- `apps/web/app/(app)/page.tsx` — reads the new `voice` / `compose` params
- `apps/web/app/chat.tsx` — accepts them; arms the recorder / focuses the composer
- `packages/i18n/src/catalog.ts` + three dictionaries — `nav.home`, `nav.activity`, drawer and top-bar labels
- `apps/web/app/design-system/screens/` — new shell cases
- `AGENTS.md` — the `/definicoes` statement, and the tab-bar rationale comment

**Reused as-is, not rebuilt**
- `apps/web/app/(app)/subscricao/` — becomes the Billing room. No new route, no
  change to its Stripe wiring; only the drawer row that points at it is new

**Untouched, deliberately**
- Everything under `apps/web/app/api/` — no send, cron, webhook or agent path is
  involved in a shell change
- `packages/core` — no prompt text changes, so the guard's quote-matching and
  the cache breakpoint are not at risk
- `supabase/migrations` — no migration in Round 1
