# Human TODO — Capo upgrade (2026-07-13)

Only-Federico items: external accounts, dashboards, physical devices —
nothing here can be done by an agent. The capo-upgrade code is merged to
`main` and live on Vercel (both `capo-v1` and `capo-operator` production
deployments are READY); everything below is what's left to fully activate
each feature.

## 1. Stripe billing

1. Create a Stripe account (or use an existing one) → create Product "Capo"
   with a recurring Price of €45/mo EUR → copy the Price id
   (`STRIPE_PRICE_ID`) and the account's secret key (`STRIPE_SECRET_KEY`) →
   set both in Vercel (production env, project `capo-v1`).
2. Stripe → Webhooks: add an endpoint `https://<prod>/api/stripe/webhook`
   subscribed to `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted` → copy the signing secret
   (`STRIPE_WEBHOOK_SECRET`) into Vercel → redeploy.
3. Run one Stripe test-mode checkout end to end (Assinar on `/subscricao` →
   Stripe Checkout → back to the app) and confirm the company's
   `subscription_status` flips to `active` in Supabase.
   Until steps 1–2 are done, billing is fully disabled app-wide (no
   `STRIPE_SECRET_KEY` → `/subscricao` shows "faturação ainda não
   disponível", the webhook 503s, and no write path is ever gated) — the app
   ships and works correctly before any of this exists. Confirmed live: the
   `capo-v1` production env currently has no `STRIPE_*` vars set (checked via
   `vercel env ls`), exactly as intended at this stage.

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

## 8. Backlog (deliberately cut from this upgrade)

18:00 materials-anticipation send (n8n reads `tasks.materials`, which now
exists — enabling the send is n8n work, not app code), two-way worker SMS
replies, multilingual worker briefings, Moloni/Vendus integration, client
progress PDF, per-seat billing, test framework adoption, Gantt charts.
