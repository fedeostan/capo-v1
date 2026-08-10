<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Repository layout (pnpm workspaces + Turborepo)

- `apps/web` — the tenant-facing Next 16 App Router PWA (RLS, publishable key).
- `apps/operator` — internal mission-control Next app (service-role,
  cross-tenant, separate deploy; must never be reachable by tenants).
- `packages/core` (`@capo/core`) — agent core, capabilities, guard/render,
  models, channels, persona/prompts (bundled TS modules, not files on disk).
- `packages/db` (`@capo/db`) — Supabase clients (system + user), generated
  types, session helpers, proxy session.
- `packages/ui` (`@capo/ui`) — shared presentational components.
- `packages/i18n` (`@capo/i18n`) — locale primitives (`Locale`, `LocaleContext`,
  `coerceLocale`) and the user-facing copy catalogs (pt-PT / es-ES / en-US).
  A zero-dependency leaf: `i18n ← db ← core ← {web, operator}`, `i18n ← ui`.
  Model-facing prompt copy lives in `packages/core/src/i18n` instead —
  deliberately separate, so UI strings never enter the agent bundle.
- `packages/config` (`@capo/config`) — shared tsconfig/eslint presets.
- `supabase/migrations` — single shared DB; migrations stay at the root.
- `scripts/rls-isolation-matrix.mjs` — the two-tenant RLS isolation matrix: a
  per-tenant visibility sweep over every relation carrying `company_id`, a
  deny-all check on the two send ledgers, and a set of adversarial cross-tenant
  attacks (cross-company FKs, billing self-upgrade, forging a translation undo
  snapshot, forging a worker check-in answer). Run with `pnpm rls-matrix` after
  any change that touches auth, RLS, or the DB clients; it must stay green.
  Needs credentials, so it does not run in CI.
- `scripts/scheduler-check.mts` — deterministic checks over the plan
  scheduler and the Portuguese working-day calendar. Needs **no credentials
  and no network**, so it runs in CI on every PR (`pnpm scheduler-check`).
- `scripts/agent-smoke.mts` — drives `handleInbound()` against a throwaway
  seeded tenant. Needs real API keys, so it is a manual gate
  (`pnpm agent-smoke`).

Three language dials (do not collapse them into one):

- `profiles.language` — **per user**. What Capo speaks, the deterministic
  approval cards, the transcription instruction, the rolling summary, the web
  UI. Changeable from chat via the `set_language` tool.
- `companies.language` — **per tenant**. What Capo *stores*: task titles, job
  names, memories, generated plan titles.
- `workers.language` — **per crew member**, and the only one a worker controls
  themselves, by replying `PT`/`ES`/`EN` to their 07:00 WhatsApp briefing. It
  is nullable and the null means "inherit `companies.language`" — do not give
  it a default. See the structural invariant below.

Both dials live on **`/perfil`** (there is no `/definicoes` route). The primary
control there moves them together and offers to translate the existing rows;
the bare per-dial forms are demoted into an "advanced" disclosure for the case
that actually needs them — a manager who does not share the crew's language.

Moving `companies.language` **alone** still retranslates nothing, and that is
why no path offers it casually. The paths that move it together with the data:

- `/perfil` → the Language card with "also translate what already exists".
- chat → `translate_company_data`, which only ever *proposes*. Its applier,
  `apply_company_translation`, is deliberately **absent from the roster** and
  reachable solely through an approved card — same shape as
  `generate_plan`/`apply_plan`, and for the same reason: a *guarded* tool in the
  roster would be executed directly whenever the model can quote the manager,
  which for "traduz tudo para inglês" is always.

Translation invariants (`packages/core/src/translation`, migration `0015`):

- **Collect from base tables, never `task_board`.** The view filters by
  `lisbon_today()`, so collecting through it would silently skip rows and couple
  translation to the calendar. Translate every status, `done` included.
- **Undo marks, it never deletes** — uniform with the schema's no-DELETE-policy
  posture. `old_value` is immutable at the *grant* layer, so the bytes the undo
  replays cannot be forged even by the tenant that owns them.
- **Write the domain row before recording the item.** Dying in between
  re-translates one value on resume; the reverse order loses a write silently.
- **Never zip a translator response by position** — match on the returned ids.
  A dropped item would otherwise land every later translation on the wrong row,
  with no error and a snapshot that faithfully records the mistake.
- Translating `tasks.title` / `jobs.name` changes what the 07:00 crew WhatsApp
  briefing says. `dispatch_tasks_today` is untouched structurally, but its
  *content* switches language — which is why the approval card says so out loud.

The single highest-risk regression in this area: the guard
(`packages/core/src/capabilities/guard.ts`) authorizes a direct write by
substring-matching the model's `manager_instruction` quote against what the
manager actually typed. If the model ever translates that quote, **every direct
write silently degrades into an approval card** — no error, just friction.
`buildLanguageDirective` carries an emphatic carve-out; keep it there, and watch
`proposals` with `status='pending'` after any prompt change.

Edit that carve-out by **appending only**, never by rewording it, and keep it
the last bullet about translating — the `translate_company_data` line was
deliberately placed before it. The risk is highest in exactly the conversation
where the manager is asking for a translation, which is why the carve-out now
ends by saying so. `translate_company_data` being unguarded is the structural
backstop: `toAiTools` never gives it a `manager_instruction` field at all.

Structural invariants (do not regress):

- **System-vs-user client split**: `getDb()` (service role) is system-only;
  `createUserClient()` (publishable key, RLS) is the client for everything on
  the tenant request path.
- **RLS is the tenant boundary** — never rely on prompts or app code for
  tenant isolation.
- Worker SMS dispatch (Twilio/n8n) is external and currently **PAUSED, not
  removed** — the n8n workflow is switched off outside this repo. Nothing here
  may break `dispatch_tasks_today` / `dispatch_log` semantics; they are kept
  byte-identical (baseline: `docs/plans/dispatch-viewdef-baseline.sql`) so SMS
  can be switched back on. **Do not write to `dispatch_log`** — the live daily
  briefing has its own ledger, `notification_log`, precisely because
  `dispatch_log`'s `unique (worker_id, dispatch_date)` would collide the day
  both channels run.
- **The worker briefing goes out over WhatsApp**, from
  `apps/web/app/api/cron/reminders` at 07:00 Europe/Lisbon (two UTC Vercel Cron
  entries, gated on `lisbon_hour()`). It reads `task_board` like everything
  else. Proactive sends need an approved Meta **template** — free-form text is
  only allowed inside the 24h window a recipient's own reply opens, which is
  why the webhook acknowledges worker replies.
- **There is a second daily send: the 16:30 check-in**, from
  `apps/web/app/api/cron/checkin`, same two-entry/`lisbon_hour()` shape. It asks
  "did you finish today's tasks?" as a template with two quick-reply buttons and
  records the tap in `worker_checkins`. Three things about it are load-bearing:
  it is **deterministic in both directions** (no model is called on this path at
  all); it **records an answer and never writes `tasks.status`**; and it claims
  under `kind='task_checkin'` in `notification_log`, which is the only reason
  two sends can share a day under that table's unique constraint. Both routes
  share `apps/web/lib/cron.ts` for auth and the claim protocol — the parts where
  drift would be a correctness bug — and nothing else.
  The inbound tap is a **template quick reply** (`type: 'button'`, from a
  worker), a different shape from an approval card's **interactive reply
  button** (`type: 'interactive'`, from a manager). They are handled on
  different paths and their payload codecs are deliberately non-overlapping;
  conflating them is the mistake to watch for.
- **`workers.language` is the third dial** (see the top of this file).
  Nullable, and the null means "inherit `companies.language`" — do not give it
  a default. A worker sets it themselves by replying `PT`/`ES`/`EN` to their
  briefing.
- **`pending_review` is the completion claim, and the surfaces that see it
  split into denylists and allowlists on purpose.** A worker (PRD 4) or the
  manager declares a task finished; it
  lands in `task_reviews` and the task moves to `pending_review` until the
  manager approves, rejects, or dismisses it. Adding a status touches ~10
  hand-written enumerations — the map is in `0018_task_reviews.sql`. Three
  migrations built this: `0018_task_reviews.sql` (table, RLS, both RPCs),
  `0019_task_reviews_hardening.sql` (fix round 1: closed a fail-open tenant
  guard, added a row lock, revoked the INSERT grant), and
  `0020_task_review_supersede.sql` (the trigger below). The surfaces that
  matter are listed below, and the review that shipped this feature found
  the map itself had contained one inversion — treat this list as ground
  truth, not the in-progress draft:
  - `task_board.is_open` (`0013:71`) is a **denylist**
    (`status not in ('done','cancelled')`), so `pending_review` stays
    **open**: on the board, and still overdue when its dates say so. That is
    the safety property — a false completion claim is visible, never silent.
    Note the asymmetry inside the same view: `risk_late_start`/
    `risk_due_soon` (`0013:116-121`) are `status = 'pending'` **allowlists**,
    so those two *at-risk-of-slipping* signals never fire for a task in
    review. That does **not** make a task in review immune to `at_risk`
    overall: `risk_late_dependency` (`0013:92`) and `risk_paused_job`
    (`0013:125`) are **not** status-gated, so either can still put a
    `pending_review` task under the Em risco chip — e.g. a task declared
    finished but not yet approved still counts as a late dependency blocking
    its successors.
  - `dashboard_tasks` (`0006:31`, replacing `0005:71`) is a **denylist**, so
    `pending_review` rows DO appear in it — superseded predecessor of
    `task_board`, kept only so an old bundle served mid-deploy keeps working;
    it has no live reader.
  - `dashboard_obras.pendentes` (`0005:82`) is a **denylist**, so a task in
    review counts as *pendente* on the Obras screen. This view **is**
    live-read (`apps/web/app/dashboard-data.ts`).
  - `dispatch_tasks_today` (`0003:34`) and `BRIEFABLE`
    (`apps/web/app/notifications/briefing.ts:51`) are both **allowlists**, so
    both exclude it with no edit: the 07:00 briefing stops nagging a worker
    about work they already declared finished, and the frozen n8n view stays
    byte-identical.
    `BRIEFABLE` now gates **both** daily sends, which is load-bearing and was
    not designed — it fell out of the two streams meeting. The 16:30 check-in
    (`apps/web/app/api/cron/checkin/route.ts`) reads through
    `loadCompanyBriefing`, so a task in review is silently dropped from
    "acabaste as tarefas de hoje?" too. That is exactly right: the worker
    already said they finished it and is waiting on the manager, so asking
    again would read as the system having forgotten. Anything that widens
    `BRIEFABLE` therefore changes two messages, not one.
  - `context.ts`'s `openTasks` count (`packages/core/src/agent/context.ts:39`)
    is an **allowlist that had to be widened by hand**, or a task in review
    would silently vanish from the count Capo sees while still showing on the
    manager's board.

  Resolution goes through `resolve_task_review()`, never two client-side
  updates: the review and its task must move in one transaction or the
  half-applied state is exactly what the feature exists to prevent. Like
  `revert_translation_batch`, it is SECURITY DEFINER — RLS does **not** cover
  it and its internal `auth.uid()` check is the whole tenant boundary, which
  is why `scripts/rls-isolation-matrix.mjs` attacks it directly. `task_reviews`
  has **no INSERT and no UPDATE grant** for `authenticated` — SELECT is the
  only tenant grant that exists on the table. Every write, filing a claim as
  well as resolving one, goes through the two SECURITY DEFINER RPCs
  (`open_task_review` / `resolve_task_review`), so a tenant can neither forge
  `status`/`resolved_by` nor strand a task open by hand.

  The fifth status, **`superseded`**, exists because a task can leave
  `pending_review` out of band — `update_task` writes `status` straight
  through with no precondition, so "marca a tarefa como concluída" while a
  claim is outstanding would otherwise strand the review at `pending`
  forever: `task_reviews_one_pending_idx` blocks a replacement review, and
  tenants have no UPDATE grant to fix it themselves. `tasks_supersede_review`
  (`0020`) is an `after update of status on tasks when (old.status =
  'pending_review' and new.status is distinct from 'pending_review')` trigger
  that marks any still-`pending` review `superseded` instead. It is safe to
  fire on every exit from `pending_review`, including the legitimate one
  through `resolve_task_review()`, only because that RPC updates
  `task_reviews` to its resolution **before** it updates `tasks` — by the time
  the trigger fires on the `tasks` update, the review is no longer `pending`
  and the trigger's `where status = 'pending'` matches nothing. **This
  statement ordering inside `resolve_task_review` is load-bearing**: reorder
  it and every legitimate approve/reject/dismiss overwrites itself with
  `superseded`.

  `task_reviews.note` is the one place worker-authored text reaches the
  manager. Render it as an attributed quote, never as UI copy.
- **One clock, one definition of "today".** The active-window rule
  (`lisbon_today() BETWEEN coalesce(start_date, created_at) AND
  coalesce(due_date, 'infinity')`) and every schedule-risk signal live in SQL,
  in the `task_board` view. Anything that answers "what is on today /
  tomorrow / overdue / at risk" — a screen, a loader, or an agent tool —
  reads that view. Never re-derive those buckets in TypeScript: the failure
  mode is Capo telling the manager one thing while the Tarefas board shows
  another, and the manager having no way to tell which is right. The `agenda`
  tool (`packages/core/src/capabilities/agenda.ts`) exists solely to hold this
  line on the agent side, and its horizon names are deliberately the board's
  own chip names so the two cannot drift.
  (`dashboard_tasks` is the superseded predecessor, kept only so an old bundle
  served mid-deploy keeps working; do not write new readers against it.)
- **Plan durations are working days, not calendar days.** The scheduler
  advances through `packages/core/src/capabilities/workdays.ts`, which skips
  weekends and the thirteen Portuguese national holidays. Anything that
  computes a due date from a duration goes through `addWorkdays`. Measuring an
  existing span (rather than walking one) goes through `countWorkdays` /
  `workdayDelta` in the same file — they are the exact inverse of `addWorkdays`
  and `scheduler-check` asserts that, because a task with no `duration_days`
  (nullable since `0010` — every pre-planner task) has its length read back off
  its dates.
- **`apply_reschedule` is the third absent-from-roster applier**, alongside
  `apply_plan` and `apply_company_translation`, and for the identical reason: a
  *guarded* tool in the roster executes directly whenever the model can quote
  the manager, and for "a Pintura acabou mais cedo" it always can. The model
  reaches rescheduling only through `reschedule_job`, which is unguarded
  because it never writes — it only ever produces a card.

  The cascade splits across four files on purpose, and the split is load-bearing:
  - `capabilities/reschedule.ts` — **pure**. No `Db`, no `Date.now()`, no locale,
    no `createProposal`. This is the only part of the task-completion work
    `pnpm scheduler-check` can cover, and it is the highest-risk pure function
    in the repo because it proposes moving dates on a live job. Keep it
    importable with no credentials and no network.
  - `capabilities/reschedule-load.ts` — reads **base `tasks`**, not `task_board`
    (the view's `lisbon_today()` window would drop exactly the future rows a
    cascade exists to move), but takes `today` from `lisbon_today()`: one clock.
    It loads one hop of **cross-job predecessors**, because `task_dependencies`
    only requires both ends be same-*company* (`0007:127-140`), never same-job —
    an unloaded outside predecessor is a silently *missing* constraint.
  - `capabilities/reschedule-propose.ts` — orchestration plus the `reschedule_job`
    roster tool.
  - `capabilities/reschedule-apply.ts` — the applier.

  Four things inside it that look like details and are not:
  - **Nothing outside `movable` is ever written.** `scheduleTasks` (`plan.ts`)
    cannot be reused precisely because it rewrites *every* task from one global
    start floor; on a live job that is catastrophic.
  - **`from_start_date`/`from_due_date` are in the payload as a compare-and-set
    predicate**, not as documentation. `resolveProposal` re-validates and
    re-renders but cannot know a *row* changed underneath, so without them
    approving a card left open overnight silently stomps a manual edit. Same
    role as `apply_company_translation`'s `languageMoved` re-check
    (`render.ts:169-178`). The applier reads every target row and verifies the
    whole set **before** the first write, so a stale card changes nothing.
  - **A cycle throws.** `task_dependencies` has no anti-cycle constraint in SQL
    and `scheduleTasks` silently drops back-edges — safe for model output, which
    zod-validates as a DAG first, never checked for DB edges.
  - **`pending_review` counts as finished for the cascade floor and as immovable
    for movement.** The cascade therefore fires on an *unverified* claim, which
    is exactly why it can only ever produce a card — and why the card says so
    out loud (`cards/types.ts`'s `reschedule.header({ unverified })`).

  An **empty result creates no proposal at all**: a job whose tasks were made
  one at a time by `create_task` has zero edges, so a completion cascades to
  nothing. That is the dominant case, not an error — an empty approval card is
  worse than silence. The skip is logged (`dashboard.reschedule_skipped`) so
  "no card appeared" stays falsifiable.

  Known and accepted: a manually pinned date gets stomped, defensible **only
  because** the card shows `from → to` per row and the CAS refuses stale rows.
  The long-term fix is a `schedule_locked boolean` on `tasks`.
- Views may only be extended with `create or replace view` **appending**
  columns (Postgres forbids reorder/retype). Code reading a view that a
  pending migration extends should `select('*')` and treat the new fields as
  optional, so a deploy landing before its migration degrades instead of
  erroring — see `0013` and the comment in `agenda.ts`.

## Local tooling

- **Stripe CLI** (`stripe`, installed via `brew install stripe/stripe-cli/stripe`,
  logged in with `stripe login`) — use for local billing work instead of
  editing webhook destinations in the Stripe Dashboard:
  - `stripe listen --forward-to localhost:3000/api/stripe/webhook` — forwards
    live test-mode events to the local dev server and prints a `whsec_...`
    signing secret; put that in `.env.local` as `STRIPE_WEBHOOK_SECRET` for
    local testing (separate from the production destination's secret in
    Vercel).
  - `stripe trigger checkout.session.completed` (or
    `customer.subscription.updated` / `.deleted`) — fires a synthetic test
    event at whatever `stripe listen` is forwarding to, without needing a
    real Checkout session.
  - `stripe logs tail` — tails live API request/event logs, useful when a
    webhook delivery from the Dashboard shows as failed and the response
    body isn't enough to diagnose.
  - Always confirm test mode (`stripe config --list` shows the active key)
    before running `trigger`/`listen` against anything — these hit real
    Stripe API state, just in the test-mode ledger.

<!-- BEGIN:codex-review-guidelines -->
## Codex Review Guidelines

This repository has no general test suite. The only automated correctness
check is `pnpm scheduler-check`, which covers the plan scheduler and the
working-day calendar and nothing else. Do not assume incorrect logic
elsewhere will be caught — it will not. Treat this as reason to be more
conservative and explicit in review comments about correctness risk, not
less.

The merge gate in CI is `pnpm turbo lint typecheck build` across the whole
workspace, plus `pnpm scheduler-check`:

- `lint` (ESLint flat configs per package, all based on `eslint-config-next`)
- `typecheck` (`tsc --noEmit` per package; every tsconfig extends
  `@capo/config/typescript/*` with `"strict": true`)
- `build` (`next build` — a full production build of every app must succeed)
- `scheduler-check` (deterministic assertions over the plan scheduler and the
  PT working-day calendar; the only correctness check that runs per PR)

When reviewing a PR, prioritize feedback in this order:
1. Correctness bugs and logic errors (most important, since nothing else
   will catch these).
2. Anything that would break `next build` or introduce a type error
   (`tsc --noEmit` runs in CI per package, all `"strict": true`).
3. Anything that would trigger an ESLint error under the Next.js
   core-web-vitals + TypeScript rule sets.
4. Next.js App Router conventions and idioms — this is a Next.js 16 App
   Router project deployed on Vercel. Before flagging anything as
   "deprecated" or "wrong" based on prior Next.js versions, check
   `node_modules/next/dist/docs/` for current behavior; this Next.js version
   has breaking changes versus older training data (see the section above).
5. Style/readability nits (lowest priority, and optional to raise at all).

Do not recommend adding a test suite as a blocking fix for a specific PR —
that's a separate, larger initiative. It is fine to suggest it as a
non-blocking follow-up.

Server-only environment variables (e.g. `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`) are read lazily inside functions, not at module
scope — flag any change that would move that access to module scope or into
a statically-rendered page/route, since that would break `next build` in CI
(and in Vercel's build) once those secrets aren't present at build time.
<!-- END:codex-review-guidelines -->
