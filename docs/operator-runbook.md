# Operator app (`apps/operator`) — deploy & access runbook

The operator app is Capo mission control: read-only, cross-tenant views over
every company (conversations, tasks, dispatch log). It runs **only** on the
service-role client (`getDb()` from `@capo/db`) — it never ships the
publishable/RLS client and has no tenant login surface. Isolation from the
tenant app is physical: separate Next app, separate deploy, separate domain.

## The screens

| Route | What it answers |
|---|---|
| `/` **Health** | *Does anything need me today, and is anyone stuck?* Alerts first, then today's counters, then the activation funnel. |
| `/companies` | Per-company detail: managers, worker count, task tallies, billing state. |
| `/conversations` | Read any tenant's thread with Capo. |
| `/tasks` | Every task, grouped by company. |
| `/dispatch` | The n8n/Twilio SMS ledger. |
| `/signups` | Newest profiles with their company's billing state. |

### Reading the Health page

**Alerts** are ordered `critical` before `warning`. What each one means:

- *subscription past_due / canceled* — the manager is locked out of the chat
  and every write path; WhatsApp deliberately keeps working.
- *proposals pending over 24h* — Capo asked for a decision and nobody
  answered. This is the product's clearest friction signal: either the card
  was unclear or the manager never saw it. Read the thread before assuming
  disinterest.
- *approved but failed to execute* — the manager said yes and nothing
  happened. Always worth a look; `proposals.action_name` says which tool.
- *stuck mid-execution* — a crash between the compare-and-set claim and
  `finalize_proposal`. By design these are **never retried automatically**
  (that guarantee is what stops double-writes), so they need a human.
- *N open tasks, nobody reachable by SMS* — no active worker has a phone
  number, so the 07:00 dispatch reaches nobody. The daily loop is dead for
  that company even though the app looks healthy.
- *No SMS dispatched today* — some company has dispatched before but nothing
  went out today. Check the external n8n 07:00 cron and Twilio first; nothing
  in this repo can cause it.

**Activation** is a five-step funnel — signed up → created an obra → tasks
scheduled → crew reachable → SMS going out. The point is not the count but
*which* step a company died at, because the fix differs at each one:
onboarding, plan quality, missing phone numbers, or the n8n cron.

## Access control (structural, two layers)

1. **HTTP Basic Auth in `apps/operator/proxy.ts`** — every request must match
   the `OPERATOR_BASIC_AUTH` env var (`user:password`, server-only, read
   lazily). Unset ⇒ the app answers 503 (fail closed). Wrong/missing
   credentials ⇒ 401. Tenants can never reach a page because there is no
   shared session mechanism with the web app at all.
2. **Vercel Deployment Protection** (dashboard, one-time): on the operator
   project enable *Vercel Authentication* for **Standard Protection** so
   production + previews additionally require your Vercel login.

## One-time Vercel setup

1. Create a **new Vercel project** (e.g. `capo-operator`) from this same
   GitHub repo.
2. Project → Settings → General → **Root Directory** = `apps/operator`.
3. Environment variables (Production + Preview):
   - `SUPABASE_URL` — same value the web project uses.
   - `SUPABASE_SERVICE_ROLE_KEY` — same value the web project uses.
   - `OPERATOR_BASIC_AUTH` — `<user>:<long-random-password>` (generate with
     `openssl rand -base64 24`).
4. Settings → Deployment Protection → **Vercel Authentication** → Standard
   Protection.
5. Deploy. Verify: unauthenticated request → 401; with credentials → overview
   renders.

## Pending from Phase 0 (tenant app)

The existing `capo-v1` Vercel project must point at the new app location:
Project → Settings → General → **Root Directory** = `apps/web`.
(An API PATCH to do this automatically was permission-gated during the
monorepo session — it is a one-time dashboard toggle.)

## Local development

`apps/operator/.env.local` (gitignored):

```
SUPABASE_URL=…            # same as apps/web/.env.local
SUPABASE_SERVICE_ROLE_KEY=…
OPERATOR_BASIC_AUTH=dev:dev
```

Run `pnpm --filter operator dev` → http://localhost:3001 (Basic Auth
`dev:dev`).
