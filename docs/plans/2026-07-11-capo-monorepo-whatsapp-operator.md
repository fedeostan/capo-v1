# Capo — Monorepo + Operator portal + WhatsApp manager channel (Fable execution plan)

## ▶ Goal command (paste to start the Fable session)

```
/goal Read @docs/plans/2026-07-11-capo-monorepo-whatsapp-operator.md and execute it end
to end as your goal. That file is your full instruction set: context, locked decisions,
guardrails, phases, and verification. Follow it exactly — treat the Guardrails as hard
constraints and never regress them (Supabase+RLS stays the source of truth, no Convex;
lazy env reads; system-vs-user client split). Work the phases in order; after each one run
the QA gate (pnpm turbo lint typecheck build + re-run the RLS isolation matrix) and commit
before starting the next — do not batch phases. Keep worker SMS dispatch (Twilio/n8n)
untouched throughout. Do not ask for approval or report back until the Verification
section's definition of done is met. Start now.
```

---

## Context — why this work

Capo is a working, deployed Next 16 App Router PWA: an EU-PT AI foreman for small construction companies. It already has a **verified** Supabase + RLS multi-tenancy core (migrations 0001–0009, a 24-check two-tenant isolation matrix, adversarial cross-tenant tests), a channel-agnostic agent core (`ToolLoopAgent`, guard/propose safety model), Gemini voice transcription, a PWA dashboard, and an external n8n SMS dispatch. It is a **single package** today — no workspaces, no Turborepo.

The company is **agent-driven and solo-maintained**. The goal of the monorepo is **agent visibility** — one repo an agent can see end-to-end. The bar for every decision is: *easy, robust, good, easy to fix.* We adopt the *organization* lesson from the system-design transcript (monorepo + clean "service" seams) and **reject its infrastructure opinion** (Convex): a second backend paradigm is more for a solo dev to maintain and would move tenant auth from DB→TS, weakening the structural boundary that is the product's core promise.

## Decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| **Backend** | **Keep Supabase + RLS as single source of truth. NO Convex.** | Fewer moving parts for a solo maintainer; keeps tenant isolation *structural* (in the DB). Realtime → Supabase Realtime; schedules → n8n / `pg_cron`; durable runs → Vercel Workflow (WDK) *only if ever needed*. |
| **Monorepo tooling** | **pnpm workspaces + Turborepo** | Vercel-native, standard, agent-friendly. |
| **WhatsApp transport** | **Meta WhatsApp Cloud API direct** (one shared business number) | Free test number + 5 test recipients now, no verification for the pilot; fully programmatic webhook. Avoids the documented Twilio trial blocker (error 572006 — trial can't send custom bodies; a conversational agent must). Twilio stays untouched for worker SMS. |
| **WhatsApp identity** | One number for everyone; identify sender by `profiles.phone` (already unique E.164) → `company_id` → the company's perpetual thread; `channel='whatsapp'`. | Standard Business-API model; clean fit with the existing "one thread per company, channel is an attribute" design. |
| **Persistent WhatsApp token** | Meta **System User** token, expiration **Never**, scopes `whatsapp_business_messaging` + `whatsapp_business_management`; server-only env var (lazy read). | Solves the temporary-token problem; one-time dashboard setup captured in a runbook. |
| **Chatwoot** | **Skip.** | The Capo app *is* the manager's human-in-the-loop surface. |
| **Operator portal** | **Separate app** `apps/operator`, service-role, own deploy. | Physical separation so cross-tenant/service-role data can never leak into the tenant app. |

## Guardrails (load-bearing invariants — do NOT regress)

- **Lazy server-env reads** (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, WhatsApp token, app secret): read *inside* functions, never at module scope or in statically-rendered routes (AGENTS.md hard rule; breaks `next build` on Vercel otherwise).
- **System-vs-user Supabase client split**: `getDb()` service-role = system-only; `createUserClient()` RLS publishable-key client = per-request request path. Keep both intact across the package move.
- **RLS is the tenant boundary.** After the move, re-run the isolation matrix — no policy weakened.
- **Guard/structural-safety model** (`guard.ts` + server-side `render.ts`): moves into `packages/core` unchanged; model-authored display text never diverges from the executed payload; deferred executions re-validate at execution time.
- **Prompt/persona file loading**: `src/agent/context.ts` currently reads files via `process.cwd()`/`src/agent/...` paths — this **will break** inside a package. Switch to package-relative resolution (`new URL(..., import.meta.url)`) or import prompts as bundled assets. **Named migration risk #1.**
- **CI gates unchanged**: `lint` → `tsc --noEmit` → `build` must still gate merges, now run across the workspace via Turbo.

## Target structure

```
capo-v1/                     (pnpm-workspace.yaml + turbo.json at root)
├── apps/
│   ├── web/                 existing Next 16 PWA — manager chat + dashboard (RLS, publishable key)
│   │   └── app/api/whatsapp/route.ts   ← WhatsApp webhook (service-role, phone→company)
│   └── operator/            NEW internal Next app — mission control (service-role, cross-tenant, own deploy)
├── packages/
│   ├── core/                agent core, capabilities, guard, render, models, context, memory, persona/prompts
│   ├── db/                  Supabase clients (system + user), types, session, proxy-session
│   ├── ui/                  shared components (web + operator)
│   └── config/              shared tsconfig / eslint / tailwind presets
└── supabase/               migrations stay at root (single DB, shared)
```

WhatsApp is a **channel adapter (route handler) in `apps/web`**, not a standalone service — simplest for a solo maintainer, reuses the existing `src/channels/` seam and channel-agnostic `handleInbound`, and stays a "reversible node." Extractable to `services/whatsapp` later with no logic change.

---

## Phase 0 — Monorepo conversion (mechanical; do first)

1. Add `pnpm-workspace.yaml`, root `turbo.json` (pipeline: `lint`, `typecheck`=`tsc --noEmit`, `build`, `dev`), root `package.json` (workspace scripts). Pin pnpm.
2. Move current app → `apps/web` (keep `app/`, `proxy.ts`, `public/`, `next.config.ts`, PWA files).
3. Extract `src/` into packages: `packages/core` (agent + capabilities + persona/prompts), `packages/db` (all of `src/db/*` + `src/auth/session.ts`), `packages/ui`, `packages/config`.
4. Replace the `@/*` path alias with workspace imports (`@capo/core`, `@capo/db`, …); update every import site.
5. **Fix prompt-file loading** (migration risk #1) — package-relative resolution.
6. Update `.github/workflows/ci.yml` to `pnpm install` + `pnpm turbo lint typecheck build`.
7. Update Vercel: `apps/web` becomes the project root directory for the existing linked project; env vars unchanged.
8. **QA gate:** workspace `lint`+`typecheck`+`build` green; `apps/web` runs and behaves identically; **re-run the 24-check two-tenant RLS isolation matrix + the two adversarial cross-tenant attacks → 0 fail**; worker SMS dispatch untouched. Commit.

## Phase 1 — Operator / mission-control app (`apps/operator`)

- New minimal Next app on its own Vercel project. Uses **`getDb()` service-role only** (from `packages/db`) in Server Components; never ships the publishable/RLS client.
- Access control **structural**: separate deploy + gate behind an operator-only auth (Supabase Auth with an `operator` allowlist, or platform-level protection) — must never be reachable by tenants.
- Read-only mission-control views: all companies' conversations/chats, tasks + completion status, `dispatch_log`, key metrics. Reuse `packages/ui`.
- Realtime "live view" (optional) via **Supabase Realtime** — no new infra.
- **QA gate:** operator app builds/deploys separately; confirmed it exposes *no* route to tenant sessions; tenant app (`apps/web`) still isolated. Commit.

## Phase 2 — WhatsApp manager channel (Meta Cloud API)

**Operator runbook (one-time, manual — write as `docs/whatsapp-cloud-api-runbook.md`):** create Meta app + WhatsApp product; get the free **test number**; add up to 5 test recipients; create a **System User** with the WhatsApp app asset (full control); generate a **Never-expiring token** with scopes `whatsapp_business_messaging` + `whatsapp_business_management`; note phone-number-id + business-account-id + app secret. Store token + app secret as server-only env vars. Post-pilot: Meta Business Verification → production number + higher messaging tier.

**Code (in `apps/web`):**
- `app/api/whatsapp/route.ts`: **GET** = webhook verification challenge (`hub.verify_token`); **POST** = inbound. Verify **`X-Hub-Signature-256`** HMAC with the app secret (structural boundary on the webhook).
- Resolve sender: `from` phone → `profiles.phone` (service-role) → `company_id`. Unknown numbers → safe no-op / decline.
- Route into the existing channel-agnostic `handleInbound` (service client + a **WhatsApp sink** that sends outbound via the Graph API `messages` endpoint), persist to the same perpetual thread with `channel='whatsapp'`. Guard model applies to mutating tools exactly as on web.
- **24-hour window:** free-form replies within 24h of the user's last message; proactive/outside-window sends require an **approved template** — implement a template path only if/when needed; note the limit.
- **QA gate:** end-to-end from a real test recipient → agent reply from the one shared number; message lands in the right company's thread; cross-tenant safe (wrong phone → no access); worker SMS dispatch untouched. Commit.

## Phase 3 — Richer manager web surface (product-led, build against the pilot)

Keep light and pilot-driven — don't over-spec in a vacuum:
- More **tracking/visibility** in the manager dashboard (task completion, progress per obra, overdue trends) beyond today's read-only Hoje/Amanhã/Atrasadas/Obras.
- Chat completeness improvements surfaced by the pilot.
- Related roadmap nodes to sequence *after* validation: **two-way worker replies** (workers mark tasks done from the thread) and **quote→day-by-day plan** (the real differentiator).
- **QA gate:** each increment gated + committed; RLS unaffected.

## Verification (end-to-end, every phase)

1. `pnpm install && pnpm turbo lint typecheck build` — all green.
2. Run `apps/web` and `apps/operator` locally; confirm web behaves identically to pre-move.
3. **Re-run the RLS isolation matrix** (24 checks, two tenants) + both adversarial cross-tenant attacks → expect 0 fail / both blocked (23514).
4. Confirm operator app exposes no tenant-reachable route and uses service-role only.
5. WhatsApp: send from a test recipient → correct company thread + reply from the shared number; unknown number denied.
6. Confirm n8n/Twilio **worker SMS dispatch still runs** (nothing in Phase 0–2 touches it).

## Open follow-ups (not blocking)

- Meta Business Verification + production number (post-pilot).
- Decide operator auth mechanism (Supabase `operator` role vs platform protection) at Phase 1 start.
- Extract WhatsApp to `services/whatsapp` only if a second non-web consumer appears.
