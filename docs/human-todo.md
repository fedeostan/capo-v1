# Human TODO — Capo upgrade (2026-07-13)

Only-Federico items: external accounts, dashboards, physical devices —
nothing here can be done by an agent. The capo-upgrade code is merged to
`main` and live on Vercel (both `capo-v1` and `capo-operator` production
deployments are READY); everything below is what's left to fully activate
each feature.

## 0. Apply migration 0013 — REQUIRED, do this first (2026-07-26)

`supabase/migrations/0013_dashboard_materials_team.sql` extends the
`dashboard_tasks` view with `materials`, `duration_days`,
`assignee_worker_id`, `job_address` and `active_this_week`. It is a
`create or replace view` — additive only, no table or data change, and
reversible by re-running 0005's definition.

Apply it in the Supabase dashboard (SQL editor) or via the CLI **before or
right after** deploying this branch. I did not run it myself: it is a
production database and running migrations there is your call, not an
agent's.

Until it is applied the app degrades on purpose rather than breaking —
the new columns are simply absent, so:
- **Materiais** shows nothing (the tomorrow list is empty, the week section
  is hidden).
- **Equipa** lists the crew but every load count reads 0, and the
  "sem responsável" banner correctly stays hidden rather than flagging
  everyone.
- The agent's `agenda` tool works for hoje/amanhã/atrasadas and returns an
  empty `semana`.

Nothing errors, but none of tonight's headline features actually work until
0013 lands. **Verify after applying:** open `/materiais` and `/equipa` on a
company that has tasks with materials.

## 1. Stripe billing — ✅ DONE (2026-07-17)

1. ✅ Stripe account created, Product "Capo" with recurring Price €45/mo EUR.
   `STRIPE_PRICE_ID` and `STRIPE_SECRET_KEY` set in Vercel (production env,
   project `capo-v1`).
2. ✅ Webhook destination added at `https://capo-v1.vercel.app/api/stripe/webhook`
   subscribed to `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`. `STRIPE_WEBHOOK_SECRET` set in Vercel,
   redeployed.
3. ✅ Ran a Stripe test-mode checkout end to end (Assinar on `/subscricao` →
   Stripe Checkout → back to the app) using a disposable test account. Confirmed
   in Supabase: `subscription_status` flipped `trialing` → `active`, and
   `stripe_customer_id`/`stripe_subscription_id` were populated with real
   `cus_.../sub_...` ids — proof the webhook fired and the signature verified.
   Test account and its Stripe test-mode subscription were cleaned up afterward.

## 2. Supabase auth (self-serve signup, password reset, Google OAuth)

1. Supabase dashboard → Authentication → Providers → Email: enable "Allow
   new users to sign up". Until this is on, `/registar` shows "Os registos
   abrem em breve" for every signup attempt (env-gated failure mode, by
   design).
2. Supabase dashboard → Authentication → Emails: configure production SMTP
   (the default Supabase sender is rate-limited, not meant for production
   volume) and set EU-PT copy for the "Confirm signup" and "Reset password"
   templates.
3. Supabase dashboard → Authentication → URL Configuration: set Site URL to
   the production domain once known (see item 5), and add
   `https://<prod>/auth/confirm` and `https://<prod>/auth/callback` to
   Additional Redirect URLs.
4. Google OAuth (optional): create a GCP OAuth consent screen + OAuth client
   (authorized redirect URI = the Supabase project's callback URL, shown in
   Supabase dashboard → Authentication → Providers → Google) → paste the
   client id/secret into the Supabase Google provider → set
   `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=1` in Vercel (production env) → redeploy.
   Until this env var is set, the "Entrar com Google" button simply doesn't
   render.

## 3. Meta (WhatsApp)

1. Complete Meta Business Verification to leave the WhatsApp free test tier
   — the `testTierArSendTarget` AR allow-list workaround in
   `api/whatsapp/route.ts` becomes a no-op once verified (leave the code, it
   only fires for that one legacy-format case).
2. Add a payment method for the Cloud API once off the test tier.
3. Confirmed live: `capo-v1` production env already has
   `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`,
   and `WHATSAPP_PHONE_NUMBER_ID` set (checked via `vercel env ls`) — the
   webhook is live and configured, not just deployed.

## 4. Domain

1. Buy a domain → add it to the Vercel `capo-v1` project → set
   `NEXT_PUBLIC_SITE_URL` in Vercel (production env) → redeploy.
2. Update Supabase Auth Site URL (item 2.3) and the Meta webhook URL once
   the domain changes.
3. Until a domain exists, production is only reachable at
   `capo-v1.vercel.app` — see item 8 below on Deployment Protection.

## 5. Twilio (worker SMS)

1. Upgrade the Twilio account from trial so worker SMS reaches real (not
   just verified) numbers.
2. Confirm the external n8n 07:00 Lisbon cron that reads `dispatch_tasks_today`
   is still running — this upgrade never touched that view (verified
   byte-identical to the pre-upgrade baseline after every migration) or the
   n8n/Twilio dispatch contract.

## 6. Visual QA on a phone

Walk through, on a real device: landing page, `/registar` full signup flow,
onboarding, chat first-run guidance (empty company), generate a plan on a
real orçamento and approve it, obra detail timeline (Concluir/Reabrir),
`/subscricao` checkout (once Stripe is live).

Added 2026-07-26 — check these too (I verified the components render
correctly against mock data, but not on a real device with real data):

- Bottom nav is now **Chat · Hoje · Obras · Equipa · Materiais**. Amanhã and
  Atrasadas moved into a switcher at the top of Hoje, with the overdue count
  as a red badge.
- Paste a real multi-line orçamento into the chat composer — it is a
  growing textarea now, not a one-line input. Enter sends, Shift+Enter adds
  a newline.
- Force a chat failure (airplane mode mid-send) and confirm the error card
  with **Tentar outra vez** appears instead of silence.
- Mark a task done from Hoje and confirm the count on the switcher updates.
- Long-press the installed PWA icon → shortcuts to Hoje and Materiais.

## 7. Vercel Deployment Protection (found during Phase 8 verification)

Both `capo-v1` and `capo-operator` currently have Vercel's Deployment
Protection (SSO) enabled — every request to `*.vercel.app` for these
projects, including the production URL, redirects to `vercel.com/sso-api`
for anyone not logged into the `fedeostans-projects` Vercel team. This
predates this upgrade (the previous production deployment had it too) — I
did not enable it and did not change it. It fully blocked the plan's
unauthenticated live-curl smoke checks in Phase 8; I substituted local build
artifact verification (identical source/commit, confirmed via Vercel's own
build logs) and live Supabase checks (`rls-matrix`, `agent-smoke`, which
bypass Vercel entirely) instead — see the Phase 8 notes in
`docs/plans/2026-07-13-capo-upgrade.md` for detail.
**Decision needed**: keep this on (private until the domain/launch is
ready) or turn it off now that the landing page is meant to be public? If
keeping it on, WhatsApp/Stripe webhook deliveries from Meta/Stripe are
server-to-server and unaffected by this browser-session-based protection —
only interactive page loads are blocked. Toggle in Vercel dashboard →
`capo-v1` → Settings → Deployment Protection.

## 8. Backlog (deliberately cut)

Two-way worker SMS replies, multilingual worker briefings, Moloni/Vendus
integration, client progress PDF (Flow 4's read-only share link is still
unbuilt), per-seat billing, a real test framework, Gantt charts.

**Now unblocked and worth doing next — the 18:00 anticipation send.** As of
2026-07-26 the app surfaces tomorrow's materials on `/materiais` and the
agent has a `materials_outlook` tool, so the manager-side half of the killer
feature is live. The remaining half is the evening push to workers, which is
n8n work, not app code: read `dashboard_tasks` where `active_tomorrow` is
true and `materials` is non-empty, grouped by `assignee_worker_id` (all four
columns exist once migration 0013 is applied). Per
`03_PRODUCT/02-flows.md` §Flow 2, the worker's evening reply is also what
keeps the 24h WhatsApp window open, so this send is both the feature and the
cost mechanism.

**Municipal holidays and Carnaval.** The plan scheduler now skips the
thirteen Portuguese *national* holidays. Municipal holidays (Lisboa 13 Jun,
Porto 24 Jun…) need the company's município, which Capo does not collect;
Carnaval is a year-by-year tolerância de ponto, not statutory. Both were
left out deliberately — see the comment at the top of
`packages/core/src/capabilities/workdays.ts`. If you want them, they belong
as a per-company setting, not a guess in the scheduler.
