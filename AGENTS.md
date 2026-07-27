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
- `scripts/rls-isolation-matrix.mjs` — the two-tenant RLS isolation matrix
  (24 visibility checks + 2 adversarial cross-tenant attacks). Run with
  `pnpm rls-matrix` after any change that touches auth, RLS, or the DB
  clients; it must stay green.
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
- **`workers.language` is the third dial** (see the top of this file).
  Nullable, and the null means "inherit `companies.language`" — do not give it
  a default. A worker sets it themselves by replying `PT`/`ES`/`EN` to their
  briefing.
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
  computes a due date from a duration goes through `addWorkdays`.
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
