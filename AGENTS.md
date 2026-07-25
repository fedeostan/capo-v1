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

Structural invariants (do not regress):

- **System-vs-user client split**: `getDb()` (service role) is system-only;
  `createUserClient()` (publishable key, RLS) is the client for everything on
  the tenant request path.
- **RLS is the tenant boundary** — never rely on prompts or app code for
  tenant isolation.
- Worker SMS dispatch (Twilio/n8n) is external; nothing in this repo may
  break `dispatch_tasks_today` / `dispatch_log` semantics.
- **One clock, one definition of "today".** The active-window rule
  (`lisbon_today() BETWEEN coalesce(start_date, created_at) AND
  coalesce(due_date, 'infinity')`) lives in SQL, in the `dashboard_tasks`
  view. Anything that answers "what is on today / tomorrow / overdue" —
  a screen, a loader, or an agent tool — reads that view. Never re-derive
  those buckets in TypeScript: the failure mode is Capo telling the manager
  one thing while the Hoje screen shows another, and the manager having no
  way to tell which is right. The `agenda` tool
  (`packages/core/src/capabilities/agenda.ts`) exists solely to hold this
  line on the agent side.
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
