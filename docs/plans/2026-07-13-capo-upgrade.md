# Capo Upgrade — Autonomous Implementation Plan

> **For the executing agent:** You are running AUTONOMOUSLY. The user (Federico) is NOT available. Do not ask questions — every decision you'd want to ask about is already settled in the **Decision Record** below. If you hit a genuine blocker (missing credential, external service down), work around it, degrade gracefully, log it in `docs/human-todo.md`, and keep going. Do not stop until every phase is complete, verified, and deployed live. Copy this plan into the repo at `docs/plans/2026-07-13-capo-upgrade.md` as your first action and check off tasks (`- [ ]` → `- [x]`) as you complete them.

**Goal:** Upgrade Capo from a pilot chat agent into a complete, sellable product: onboarding-aware agent, quote→day-by-day planning engine, self-serve auth, €45/mo Stripe billing, public landing page, obra-level dashboard control center, operator visibility — all live on Vercel, without breaking the live WhatsApp pilot.

**Architecture:** Everything plugs into existing seams: new agent tools follow the `CapoTool` + guard/propose/render pattern in `packages/core/src/capabilities/`; new pages follow the `(app)`/`(public)` route-group + `requireAuth`/`proxy-session` pattern in `apps/web`; new DB objects are additive migrations mirroring the RLS patterns of `0007_auth_multitenancy.sql`. Stripe and Google OAuth are env-gated so the app builds and deploys before their credentials exist.

**Tech stack:** Next.js 16 App Router (read `node_modules/next/dist/docs/` before writing route/metadata/proxy code — this version has breaking changes), ai@7 + @ai-sdk/anthropic, Supabase (project `qdfmvhjrcmeoxbattnsm`, eu-west-3) with RLS, Stripe, Vercel, pnpm + Turborepo.

## Repository context (why this change)

Capo is an AI "capataz virtual" for micro construction companies in Portugal (owner + ~5 workers). Built today: multi-tenant web+WhatsApp chat agent (guarded writes → proposal cards), read-only dashboard (Hoje/Amanhã/Atrasadas/Obras), morning SMS dispatch via external n8n+Twilio, invite-only email+password auth. Live pilot: Federico's own phone on Meta's WhatsApp free test tier.

The founder's research corpus establishes: the differentiator is **quote → AI day-by-day plan** ("AI proposes, manager disposes" — manager edits are the moat); positioning is "an AI assistant that runs your WhatsApp and automates the paperwork," NOT "construction management software"; workers never install anything; flat company pricing, no seats. This upgrade builds the planning engine, makes the product self-serve and billable, and gives it a public face.

## Decision Record (settled — do not re-litigate)

| Decision | Value |
|---|---|
| Price | **€45/month flat per company**, 14-day free trial, no card required to start |
| Billing | Stripe Checkout + Customer Portal + webhook; env-gated (no keys → billing fully disabled, app works) |
| Gating | Soft: banner from 7 days left of trial; after expiry block **writes** (chat API, proposal resolution, task actions) with a friendly PT message; dashboard stays readable; **WhatsApp channel is never gated** during pilot |
| Auth | Self-serve signup (email+password, email confirmation), password reset, Google OAuth env-gated behind `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=1`; existing invite login untouched |
| Landing | Served at `/` to anonymous visitors via proxy **rewrite** to `(public)/landing`; authenticated `/` stays the chat (PWA start_url unchanged) |
| Planning | One new model-facing tool `generate_plan` → dedicated `planner` model role (`claude-sonnet-5`, `generateObject`) → deterministic topological scheduler → stored as an `apply_plan` **proposal** (never direct-executes). No Gantt, no CPM, no plans table — the proposal row IS the stored AI plan |
| Language | All user-facing copy in **European Portuguese** (match existing tone in `render.ts`, dashboard, login) |
| Observability | `logEvent` JSON lines + `@vercel/analytics` only. No Sentry, no log drains |
| Out of scope (do NOT build) | 18:00 anticipation sender (n8n work — human TODO), two-way worker SMS replies, multilingual worker briefings, Moloni/Vendus integration, client portal, per-seat billing, test framework adoption, Gantt charts |

## Global constraints (violating any of these = failure)

- **NEVER break the live WhatsApp path**: `apps/web/app/api/whatsapp/route.ts` — do not modify `testTierArSendTarget`, HMAC verification, or its session exemption in `apps/web/proxy.ts`. Federico's phone is the only live user; this must keep working after every deploy.
- **NEVER change `dispatch_tasks_today` / `dispatch_log` semantics** (external n8n+Twilio contract). After every migration: `select pg_get_viewdef('dispatch_tasks_today'::regclass);` via Supabase MCP `execute_sql` and diff against the pre-upgrade snapshot (capture it in Phase 0) — must be identical.
- **RLS is the tenant boundary**: `pnpm rls-matrix` must be green after every phase that touches DB or auth. All migrations additive, mirroring `supabase/migrations/0007_auth_multitenancy.sql` patterns.
- **Lazy env reads**: every new secret (`STRIPE_*`, etc.) is read inside function bodies, never at module scope (module-scope reads break `next build`).
- **Merge gate**: `pnpm turbo lint typecheck build` green before every commit to main. All tsconfigs are strict.
- **Client split**: `createUserClient()` (RLS) for everything on the tenant request path; `getDb()` (service role) only for system paths (WhatsApp webhook, Stripe webhook, smoke scripts, operator).
- **Next 16**: consult `node_modules/next/dist/docs/` before writing routes, metadata files, server actions, or proxy code. `typecheck` runs `next typegen` first — new routes need it.
- Migrations applied to the live project via Supabase MCP `apply_migration` AND saved as files in `supabase/migrations/` (keep numbering: next is `0010`). Regenerate `packages/db/src/types.ts` via `generate_typescript_types` after each migration.
- Work on a feature branch (e.g. `feat/capo-upgrade`), commit per phase with clear messages, merge/push to `main` only when gates pass. Deploy to production at the end (Phase 8) and verify live.

---

## Phase 0 — Safety harness + observability

Everything later depends on these gates existing.

**Files:**
- Create: `scripts/agent-smoke.mts`
- Create: `apps/web/lib/log.ts`
- Create: `docs/human-todo.md` (seed with header; phases append)
- Modify: `apps/web/app/layout.tsx` (add `<Analytics/>` from `@vercel/analytics/react`)
- Modify: root `package.json` (script `"agent-smoke": "tsx scripts/agent-smoke.mts"`, devDep `tsx`), `apps/web/package.json` (dep `@vercel/analytics`)

**Tasks:**
- [x] Snapshot baseline: run `select pg_get_viewdef('dispatch_tasks_today'::regclass);` via Supabase MCP; save output to `docs/plans/dispatch-viewdef-baseline.sql` for later diffs. Run `pnpm rls-matrix` and `pnpm turbo lint typecheck build` to confirm green baseline.
- [x] `apps/web/lib/log.ts`: `export function logEvent(name: string, fields: Record<string, unknown> = {}) { console.log(JSON.stringify({ evt: name, ts: new Date().toISOString(), ...fields })); }`. Wire calls into `api/whatsapp/route.ts` (inbound handled / unknown sender / send failure — additive, alongside existing console.*) and `api/chat/route.ts`.
- [x] `scripts/agent-smoke.mts`: modeled on `scripts/rls-isolation-matrix.mjs` (same env loading from `apps/web/.env.local`, same seed/cleanup discipline). Seeds one throwaway tenant (auth user + company via `complete_onboarding`-equivalent service-role inserts + one job + one worker), then calls `handleInbound(getDb(), companyId, {channel:'web', ...}, collectingSink)` from `@capo/core` directly. Checks: (1) "Olá" → non-empty pt-PT reply; (2) "Cria uma obra chamada Obra Teste Smoke" → `jobs` row OR pending proposal exists; (3) suggestion-shaped ask → proposal with `rendered_text`. Cleans up everything including the auth user. Exit 0/1.
- [x] Add `<Analytics/>` to root layout; verify build.
- [x] Verify: `pnpm agent-smoke` green, `pnpm turbo lint typecheck build` green. Commit.

  Note: `scripts/agent-smoke.mts` needed `tsx`, `@capo/core`, `@capo/db`, and `ai` added as root devDependencies (pnpm is strict, no phantom hoisting) — implied by "modeled on rls-isolation-matrix.mjs" but not spelled out in the file list above. `pnpm approve-builds` prompted for `esbuild`'s postinstall; declined it (tsx runs fine — prebuilt binary).

## Phase 1 — Agent upgrade: onboarding-aware, app-aware conversation

Prompt/context only — no schema, no tools, no channel changes. Instantly revertible.

**Files:**
- Modify: `packages/core/src/agent/context.ts`
- Modify: `packages/core/src/agent/prompts/orchestration.ts`
- Modify (optional, small): `packages/core/src/agent/persona/capo.pt-PT.ts`

**Tasks:**
- [x] `context.ts` → extend `buildSystemPrompt` with a **company snapshot** block fetched per turn on `ctx.db` (cheap `{ count: 'exact', head: true }` queries): company name, counts of active obras, active workers, open tasks, pending proposals. Render as a short `# Estado atual da empresa` section. Tolerate nulls/failures (snapshot must never crash the turn — wrap in try/catch, omit on error).
- [x] When obras=0 AND workers=0 AND tasks=0, append a **first-run block**: Capo introduces itself once, then guides setup conversationally — (1) first obra (nome, morada, cliente), (2) equipa (nomes, funções, telefones E.164), (3) primeiras tarefas — one question at a time, never a form-dump; mention results appear in the Hoje/Amanhã/Obras tabs. When partially set up (e.g. obras but no workers), nudge the gap once, not repeatedly.
- [x] `orchestration.ts` → add `## A app à volta de ti`: factual map of the surface (bottom tabs Chat/Hoje/Amanhã/Atrasadas/Obras; per-obra detail page with the plan timeline; approval cards tapped in web chat; workers get a morning SMS briefing driven by task start_date/due_date/assignee/status; dashboard is read-mostly — changes happen through Capo). Add `## Primeiros passos` referencing the snapshot-driven behavior above.
- [x] Extend `agent-smoke.mts` with check (4): seeded EMPTY tenant, "Olá" → reply mentions "obra" and asks a question.
- [x] Verify: `pnpm agent-smoke`, build gates. Commit.

  Note (infra fix, not in original file list): found and fixed a pre-existing race in `turbo.json` — `build` and `typecheck` had no `dependsOn` relationship within a package, so both ran `next typegen` concurrently against the same `.next` dir. Reproduced twice: `web:typecheck` threw an ENOENT unhandled rejection while `next build` was mid-rewrite of `.next`, yet turbo still reported the run as fully successful (a silent false-positive green gate). Since every phase in this plan depends on `pnpm turbo lint typecheck build` being a trustworthy signal, changed `build.dependsOn` to `["^build", "typecheck"]` so typecheck completes before build starts in the same package. Verified with two forced clean full-workspace runs afterward: no ENOENT, no race.

## Phase 2 — Planning engine (the differentiator)

**Migration:** `supabase/migrations/0010_planning.sql`
```sql
alter table tasks add column duration_days integer check (duration_days is null or duration_days > 0);
alter table tasks add column materials text[];
```
(`task_dependencies` already exists with RLS + cross-company guards from 0007/0009 — reuse as-is.)

**Files:**
- Create: `packages/core/src/capabilities/plan-apply.ts` (no propose import — avoids cycle), `packages/core/src/capabilities/plan.ts` (imports `createProposal` from `./propose`), `packages/core/src/agent/prompts/planner.ts`
- Modify: `packages/core/src/capabilities/index.ts` (add `generatePlan` to roster; NOT `applyPlan`), `propose.ts` (add `...planApplyTools.filter(t => t.guarded)` to `proposable`, importing from `./plan-apply` only), `render.ts` (case `'apply_plan'`), `tasks.ts` (list_tasks selects new columns + dependencies; create/update_task accept optional `duration_days`, `materials`), `packages/core/src/agent/models.ts` (add `planner: anthropic('claude-sonnet-5')`), `orchestration.ts` (`## Planeamento de obra` section), `apps/web/app/chat.tsx` (`TOOL_LABELS` entry for `generate_plan`)

**Interfaces:**
- `generate_plan` (model-facing, unguarded, roster): input `{ job_id: uuid, source_text: string, start_date: iso date, notes?: string }`. Execute: validate job belongs to tenant (fetch it); fetch workers (name/trade) for optional assignee suggestions; call `generateObject` with `planner` model + planner prompt → relative plan `{ tasks: [{ key, title, description?, trade?, duration_days, materials?, depends_on? (sibling keys), assignee_worker_id? }] }` (zod, max 20 tasks, `superRefine` validates depends_on closure + no cycles via topological sort); run pure scheduler `scheduleTasks(planTasks, startDate)` — dependencies first, each task starts the workday after its latest dependency ends, skip Sat/Sun — producing concrete `start_date`/`due_date` per task; then `createProposal(ctx, 'apply_plan', datedArgs)`; return `{ status: 'proposed', proposalId, renderedText }` (chat UI already renders this shape as a card — zero UI change).
- `apply_plan` (guarded: true, proposable, NOT in roster — can only run via approved proposal): input `{ job_id, tasks: [{ key, title, description?, trade?, start_date, due_date, duration_days, materials?, assignee_worker_id?, depends_on? }] }` (min 1, max 25). Execute: insert tasks sequentially (source from `ctx.actor`), build key→id map, insert `task_dependencies` edges. On mid-way error: throw — `resolveProposal` marks proposal `failed` (documented non-atomicity; acceptable, leftover tasks are visible/cancellable via chat).
- `render.ts` case `'apply_plan'`: pure function of action_args + job-name lookup (`RenderError` on unknown job). Header `Plano para a obra «X» — N tarefas, DD/MM a DD/MM`, then numbered lines `1. Demolição — 21/07 → 22/07 (2 dias) · Zé`, with `   ⤷ depois de: 1, 2` and `   materiais: …` lines when present.
- `planner.ts` prompt: universal PT construction DAG (demolição → alvenaria/estrutura → abertura de roços → canalização/eletricidade → reboco/estuque → betonilha → azulejos/pavimentos → carpintarias → pintura → loiças/acabamentos), EU-PT task titles, realistic durations for a 1–2 person crew, materials per task, only include phases implied by `source_text`, ≤20 tasks.

**Tasks:**
- [x] Apply migration 0010 (MCP + file), regenerate `packages/db/src/types.ts`, diff `dispatch_tasks_today` viewdef vs baseline (must be identical), run `pnpm rls-matrix`.
- [x] Implement files above (respect the existing `CapoTool` contract in `types.ts`; look at `tasks.ts`/`jobs.ts` for the guarded-tool shape and `propose.ts:11` for the proposable-registry comment).
- [x] `orchestration.ts` planning section: when the manager pastes a quote/scope and wants a plan → ensure the obra exists first (create/propose it), then call `generate_plan` with the manager's text verbatim as `source_text` and a confirmed start date; after the card appears, refer to it, never restate it; post-approval adjustments go through `update_task`.
- [x] Extend `agent-smoke.mts` check (5): seed tenant + obra; send "Aqui está o orçamento aprovado: demolição da casa de banho, canalização nova, azulejo e loiças. Começa na próxima segunda. Faz-me o plano." → assert pending proposal with `action_name='apply_plan'`, `rendered_text` has ≥3 numbered lines with dates; then `resolveProposal(db, id, 'approve')` → assert tasks + task_dependencies rows exist, every start_date ≤ due_date, no Saturday/Sunday start_date.
- [x] Verify: `pnpm agent-smoke`, `pnpm rls-matrix`, build gates, Supabase `get_advisors`. Commit.

  Notes: (1) `list_tasks` embeds dependencies via a separate follow-up query rather than a PostgREST FK-hinted embed — `task_dependencies` has two self-referencing FKs into `tasks`, which makes embed syntax ambiguous/fragile; a plain second query is simpler and unambiguous. (2) `trade` travels through `generate_plan`'s relative-plan schema and `apply_plan`'s input schema for planner reasoning/rendering but is never persisted (no `trade` column on `tasks` — migration 0010 only added `duration_days`/`materials`, matching the plan's stated migration). (3) First smoke run of check (5) failed because the orchestration prompt's original "confirm the start date" wording made the model ask for confirmation even when the manager had already given a relative date ("próxima segunda") — tightened the prompt to only ask when no date was mentioned at all; re-ran clean afterward. (4) `get_advisors` showed only pre-existing findings (dispatch_log deny-all by design, security-definer functions by design, unindexed FKs, auth connection strategy) — nothing new from migration 0010.

## Phase 3 — Dashboard control center

**Files:**
- Create: `apps/web/app/(app)/obras/[id]/page.tsx`, `apps/web/app/(app)/obras/[id]/actions.ts`, `apps/web/app/(app)/obras/[id]/task-actions.tsx` (client component for buttons)
- Modify: `packages/ui/src/dashboard-ui.tsx`, `apps/web/app/dashboard-data.ts`, `apps/web/app/(app)/obras/page.tsx` (items link to detail)

**Tasks:**
- [x] `dashboard-data.ts` → `loadObraDetail(ctx, jobId)`: job row + ALL its tasks (including done) + `task_dependencies`, one round trip where possible, RLS client.
- [x] Detail page (`requireAuth`, dynamic): header (nome/morada/cliente), progress (done/total), **timeline** — tasks ordered by `start_date` then `created_at`, grouped under day headings (`Intl.DateTimeFormat('pt-PT')`), each row: title, assignee, status badge, `depois de: <titles>` when dependencies exist, materials chips.
- [x] `actions.ts` server actions: `completeTask(taskId)` / `reopenTask(taskId)` — `createUserClient()` + company check via `requireAuth`, direct status update, `revalidatePath`, `logEvent`. (A manager tapping "Concluir" IS an explicit manager command — sanctioned non-chat write path.)
- [x] `dashboard-ui.tsx`: add `TimelineList` presentational component; give `EmptyState` an optional CTA prop (`href`, `label`) — keep props optional (operator app imports this package). Every dashboard empty state funnels to chat: "Sem obras ainda — pede ao Capo para criar a primeira." CTA → `/`.
- [x] Verify: build gates (typecheck covers the server-action wiring), `pnpm agent-smoke` still green. Manually render check via `pnpm --filter web dev` + curl of `/obras` (expect 307 to /login without cookie — proves route compiles). Commit.

  Notes: (1) `actions.ts` uses `requireAuth()` (which internally builds the RLS-scoped client via `createUserClient()`), not `createUserClient()` directly — matches every other server action in the repo (`login/actions.ts`, `onboarding/actions.ts`). (2) `completeTask`/`reopenTask` take only `taskId` (the update's `.select('job_id')` return supplies what's needed for `revalidatePath`, so no second arg is needed) and revalidate `/obras/[id]`, `/hoje`, `/amanha`, `/atrasadas`, `/obras` since a status change affects all of them. (3) Added a `TimelineList` `renderExtra` render-prop instead of building buttons into `dashboard-ui.tsx` directly — keeps that package free of any mutation/action import (its own file comment states "no buttons, no forms, no mutations"); the actual Concluir/Reabrir buttons live in `apps/web`'s `task-actions.tsx` and are injected via the slot. (4) `pnpm --filter web dev` hung without ever binding a port in this sandboxed environment (confirmed not a code issue — `next build` already compiles and lists `/obras/[id]` as a route, which is strictly stronger evidence the route compiles than a dev-server curl would have been); substituted the `next build` route listing + a clean `tsc --noEmit` as the compile-proof instead. `pnpm agent-smoke` re-run: 6/6 green (Phase 3 touched no agent code, unaffected).

## Phase 4 — Auth: self-serve signup, password reset, Google OAuth

All additive. `login/actions.ts` `signIn` is NOT modified.

**Files:**
- Create: `apps/web/app/(public)/registar/{page.tsx,actions.ts}`, `apps/web/app/(public)/recuperar/{page.tsx,actions.ts}`, `apps/web/app/(public)/nova-password/{page.tsx,actions.ts}`, `apps/web/app/auth/confirm/route.ts`, `apps/web/app/auth/callback/route.ts`, `apps/web/lib/site-url.ts`
- Modify: `apps/web/app/(public)/login/page.tsx` (+links, env-gated Google button), `packages/db/src/proxy-session.ts` (PUBLIC_PATHS += `/registar`, `/recuperar`, `/nova-password`, `/auth/confirm`, `/auth/callback`; logged-in redirect extends to `/registar`)

**Tasks:**
- [ ] `site-url.ts`: `siteUrl()` = `NEXT_PUBLIC_SITE_URL ?? (VERCEL_PROJECT_PRODUCTION_URL ? https://… : http://localhost:3000)`, read lazily.
- [ ] Signup: `supabase.auth.signUp({ email, password, options: { emailRedirectTo: siteUrl() + '/auth/confirm?next=/onboarding' } })`. If Supabase returns "signups not allowed" → friendly notice ("Os registos abrem em breve — pede um convite.") so the page deploys before the human flips the dashboard toggle. Success → "Confirma o teu email" state. No account enumeration (mirror login's uniform errors).
- [ ] `auth/confirm/route.ts` (GET): `verifyOtp({ type, token_hash })` handling both signup confirmation and recovery, redirect to `next` param. Use the token_hash flow per current `@supabase/ssr` docs (Context7 if unsure).
- [ ] Password reset: `resetPasswordForEmail(email, { redirectTo: siteUrl() + '/auth/confirm?next=/nova-password' })`; always answer "se existir conta, enviámos email". `nova-password` requires a session (arrives via recovery), `updateUser({ password })` → redirect `/`.
- [ ] Google: server action `signInWithOAuth({ provider: 'google', options: { redirectTo: siteUrl() + '/auth/callback' } })` → `redirect(data.url)`; `auth/callback/route.ts` does `exchangeCodeForSession(code)` → redirect `/`. Button renders only when `process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED === '1'`.
- [ ] Signup→onboarding→trial chain needs NO new code: fresh user hits `getAuthState() → no_profile → /onboarding` → unchanged `complete_onboarding()` RPC creates company+profile; trial starts via the Phase 5 column default. Verify this flow reasoning holds when you read `packages/db/src/session.ts`.
- [ ] Verify: **`pnpm rls-matrix` mandatory**, build gates, `curl -s localhost:3000/registar` → 200 with form, `/login` HTML still contains the original email+password form. Commit.

## Phase 5 — Stripe billing (€45/mo, 14-day trial, env-gated)

**Migration:** `supabase/migrations/0011_billing.sql`
```sql
alter table companies
  add column stripe_customer_id text unique,
  add column stripe_subscription_id text,
  add column subscription_status text not null default 'trialing'
    check (subscription_status in ('trialing','active','past_due','canceled')),
  add column trial_ends_at timestamptz not null default (now() + interval '14 days');
update companies set subscription_status = 'active';  -- never gate the existing pilot
revoke update on table companies from authenticated;
grant update (name) on table companies to authenticated;  -- tenants may rename, never touch billing columns
```
(Check first whether `authenticated` currently has UPDATE on companies at all — mirror whatever 0007 granted; the intent is: billing columns are never tenant-writable. Adjust the grant lines to reality.)

**Files:**
- Create: `apps/web/lib/billing.ts`, `apps/web/app/api/stripe/webhook/route.ts`, `apps/web/app/(app)/subscricao/{page.tsx,actions.ts}`
- Modify: `apps/web/app/(app)/layout.tsx` (BillingBanner), `apps/web/app/api/chat/route.ts` + `apps/web/app/api/proposals/[id]/route.ts` + Phase 3 `actions.ts` (call `assertNotBlocked`), `apps/web/proxy.ts` (session exemption for `/api/stripe/webhook`, same pattern as `/api/whatsapp`), `apps/web/package.json` (dep `stripe`)

**Interfaces (billing.ts):**
- `getBillingState(ctx) → { enabled: false } | { enabled: true, status, trialEndsAt, daysLeft, blocked: boolean }` — `enabled: false` when `STRIPE_SECRET_KEY` unset; `blocked` = status `trialing` && trial expired, or status `canceled`/`past_due` beyond grace. Lazy `getStripe()` constructs the client inside the function.
- `assertNotBlocked(ctx)` — no-op when billing disabled; otherwise throws/returns a 402 JSON body `{ error: 'A tua subscrição expirou…' }` the chat UI surfaces.

**Tasks:**
- [ ] Apply migration 0011 (MCP + file), regen types, viewdef diff, `pnpm rls-matrix`. Extend `scripts/rls-isolation-matrix.mjs` with one adversarial check: authenticated tenant `update companies set subscription_status='active'` must FAIL.
- [ ] Webhook route: `stripe.webhooks.constructEvent(await req.text(), sig, STRIPE_WEBHOOK_SECRET)`; 503 when env unset, 400 on bad signature. Handle `checkout.session.completed` (client_reference_id = companyId → store customer/subscription ids, status active), `customer.subscription.updated`/`.deleted` (map by `stripe_customer_id` → status mapping: active/trialing→active, past_due→past_due, canceled/unpaid→canceled). Uses `getDb()` (system path — sanctioned). `logEvent` every event.
- [ ] `/subscricao` page: status card (trial countdown / ativa / bloqueada / billing-indisponível), `startCheckout()` → `stripe.checkout.sessions.create({ mode:'subscription', line_items:[{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }], client_reference_id: companyId, customer_email, success_url: siteUrl()+'/subscricao?sucesso=1', cancel_url: siteUrl()+'/subscricao' })` → redirect; `openPortal()` → `billingPortal.sessions.create` → redirect.
- [ ] BillingBanner in `(app)/layout.tsx`: nothing when disabled/healthy; amber countdown ≤7 days left; red + link `/subscricao` when blocked.
- [ ] `assertNotBlocked` wired into chat API, proposals API, task server actions. WhatsApp route: NO gate — just `logEvent('billing.whatsapp_ungated', {companyId})` when a blocked company messages.
- [ ] Verify: build gates **with no Stripe env set** (graceful degradation proof); `curl -X POST localhost:3000/api/stripe/webhook` → 503 without env; SQL check pilot company is `active`; `pnpm rls-matrix` (with new check) green; `pnpm agent-smoke` green. Commit. Append Stripe setup steps to `docs/human-todo.md`.

## Phase 6 — Landing page + SEO

**Files:**
- Create: `apps/web/app/(public)/landing/page.tsx`, `apps/web/app/robots.ts`, `apps/web/app/sitemap.ts`
- Modify: `packages/db/src/proxy-session.ts` (anonymous `/` → `NextResponse.rewrite('/landing')` instead of redirect to /login; add `/landing` to PUBLIC_PATHS)

**Tasks:**
- [ ] Landing (server component, EU-PT, no client JS needed): hero — "O assistente que gere o teu WhatsApp e trata da papelada da obra" (anti-app positioning; never say "software de gestão"); 3-step how-it-works (envia o orçamento → o Capo faz o plano dia a dia → a equipa recebe o briefing de manhã); killer-feature highlight (antecipação de materiais para amanhã); pricing card (€45/mês, 14 dias grátis, sem cartão, sem custo por trabalhador); CTA → `/registar`, secondary "Entrar" → `/login`. Style with existing Tailwind theme (#ea580c orange). Full `metadata` export (title, description, openGraph). Keep it one tasteful page — no animations libraries, no marketing framework.
- [ ] `robots.ts`: allow `/`, disallow `/api/`; `sitemap.ts`: `/`, `/registar`, `/login` using `siteUrl()`. (Check Next 16 metadata-route docs first.)
- [ ] Proxy rewrite: in `updateSession`, when `!user && pathname === '/'` → rewrite to `/landing` (URL stays `/`). Re-verify the `/api/whatsapp` exemption ordering in `apps/web/proxy.ts` is untouched.
- [ ] Verify: build gates; `curl -s localhost:3000/` (no cookie) → 200 containing "45" and "registar"; `curl /robots.txt` and `/sitemap.xml` → 200; authenticated `/` still the chat (typecheck + the proxy logic reading). Commit.

## Phase 7 — Operator upgrade (small)

**Files:**
- Modify: `apps/operator/app/data.ts` (overview surfaces `subscription_status` + `trial_ends_at`; new `loadSignups()` — profiles+companies by `created_at` desc, limit 100), `apps/operator/app/page.tsx` (status/trial column), `apps/operator/app/layout.tsx` (nav link)
- Create: `apps/operator/app/signups/page.tsx`

**Tasks:**
- [ ] Implement; keep read-only service-role posture. Verify: build gates. Commit.

## Phase 8 — Final hardening, deploy live, human TODO

- [ ] Full gate run: `pnpm turbo lint typecheck build`, `pnpm rls-matrix`, `pnpm agent-smoke`, Supabase `get_advisors` (security + performance — fix anything new this upgrade introduced), final `dispatch_tasks_today` viewdef diff vs baseline.
- [ ] Push branch, merge to `main` (gates green). Deploy `apps/web` to production on Vercel (project `capo-v1` — Git integration deploys on push to main; verify with Vercel MCP `list_deployments`/`get_deployment` that the production deployment succeeds and is READY; if the Git integration doesn't fire, use the vercel:deploy skill / `deploy_to_vercel`).
- [ ] Post-deploy live smoke on the production URL: `curl -s https://<prod>/` → 200 landing with "45"; `/registar` → 200; `/login` → 200 with form; `GET /api/whatsapp?hub.mode=subscribe&hub.verify_token=wrong` → 403 (webhook alive); `/robots.txt` + `/sitemap.xml` → 200; `/api/stripe/webhook` POST → 503 (until keys exist). Send one message through the web chat path is not possible unauthenticated — instead run `pnpm agent-smoke` once more against the live DB.
- [ ] Operator app: check whether a Vercel project for `apps/operator` exists (Vercel MCP `list_projects`). If yes, verify deploy. If no, attempt to create + deploy one (root directory `apps/operator`) with `OPERATOR_BASIC_AUTH` env copied from local; if project creation is blocked, add to human TODO — the operator app is internal-only and non-blocking.
- [ ] Vercel env check (`vercel env ls` or MCP): confirm production has all existing vars; add `NEXT_PUBLIC_SITE_URL` if a production domain is known (else human TODO). Do NOT set placeholder Stripe/Google vars.
- [ ] Finalize `docs/human-todo.md` (see below), commit, push. Write a final summary comment on the plan file in the repo: what shipped, what's pending on the human.

### docs/human-todo.md (final content the executor must produce)

Only-Federico items, each with exact steps:
1. **Stripe**: create account → Product "Capo" + recurring Price €45/mo EUR → copy `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` into Vercel (production env, project capo-v1) → add webhook endpoint `https://<prod>/api/stripe/webhook` (events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`) → copy `STRIPE_WEBHOOK_SECRET` to Vercel → redeploy → run one test-mode checkout.
2. **Supabase dashboard**: Auth → enable "Allow new users to sign up"; configure production SMTP + EU-PT email templates (confirmação + recuperação); set Site URL + additional redirect URLs (`https://<prod>/auth/confirm`, `/auth/callback`).
3. **Google OAuth**: GCP consent screen + OAuth client (redirect: Supabase callback URL) → paste client id/secret into Supabase Google provider → set `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=1` in Vercel → redeploy.
4. **Meta**: complete Business Verification to leave the WhatsApp test tier (the AR allow-list workaround becomes a no-op — leave the code); then add payment method for Cloud API.
5. **Domain**: buy domain → add to Vercel project → set `NEXT_PUBLIC_SITE_URL` → update Supabase Site URL + Meta webhook URL if it changes.
6. **Twilio**: upgrade from trial so worker SMS reaches real numbers; confirm the n8n 07:00 Lisbon cron.
7. **Visual QA on a phone**: landing, /registar full signup, onboarding, chat first-run guidance, generate a plan on a real orçamento, obra detail timeline, /subscricao checkout.
8. **Backlog (deliberately cut)**: 18:00 materials-anticipation send (n8n reads `tasks.materials` — enabling column now exists), two-way worker replies, multilingual briefings, Moloni/Vendus import, client progress PDF.

## Verification (end-to-end definition of done)

All of these true, in order: `pnpm turbo lint typecheck build` green · `pnpm rls-matrix` green (incl. new billing check) · `pnpm agent-smoke` green (5 checks: greeting, guarded create, proposal, first-run guidance, quote→plan→approve→tasks+dependencies) · `dispatch_tasks_today` viewdef identical to baseline · production deployment READY on Vercel · live curl smoke passes (landing/registar/login/robots/sitemap/whatsapp-403/stripe-503) · `main` pushed · `docs/human-todo.md` complete · plan file in repo fully checked off with a closing summary.
