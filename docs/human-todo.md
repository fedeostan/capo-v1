# Human TODO — Capo upgrade (2026-07-13)

Only-Federico items: external accounts, dashboards, physical devices —
nothing here can be done by an agent. The capo-upgrade code is merged to
`main` and live on Vercel (both `capo-v1` and `capo-operator` production
deployments are READY); everything below is what's left to fully activate
each feature.

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

## 8. Multilingual + WhatsApp voice notes (branch `claude/agent-audio-language-config`)

The code is complete and `pnpm turbo lint typecheck build` is green. These
steps need a human because they touch the live Supabase project or a real
phone.

1. **Apply migration `0014_language.sql`.** The Supabase MCP was not
   authorized in the session that wrote it, so the file exists but has NOT
   been applied. Apply it via the Supabase MCP `apply_migration` (or the SQL
   editor) against project `qdfmvhjrcmeoxbattnsm`.
   ⚠️ Apply this **before** deploying the app. The migration drops and
   recreates `complete_onboarding` with a 4th `p_language` parameter that has
   a DEFAULT, precisely so the currently-deployed 3-argument caller keeps
   working in the window between migration and deploy. In the other order,
   signup breaks.
2. **Regenerate `packages/db/src/types.ts`** via the Supabase MCP
   `generate_typescript_types` and commit it. The two `language` columns and
   the new `complete_onboarding` signature were **hand-patched** to keep the
   workspace compiling; the regenerated file should be identical, and any
   diff beyond those three spots is worth reading.
3. **Run the gates** once the migration is applied: `pnpm rls-matrix` (the
   column grants changed — it must stay green), then `pnpm agent-smoke`
   (there is a new 6th check that seeds an `en-US` tenant and asserts the
   reply is English), then diff
   `select pg_get_viewdef('dispatch_tasks_today'::regclass);` against
   `docs/plans/dispatch-viewdef-baseline.sql` — this migration touches no
   view, so it must be byte-identical.
4. **Test voice notes against the live Meta test tier** — this is the only
   real gate on the audio path, since there is no test suite:
   a. pt-PT voice note → correct transcript + coherent reply.
   b. Voice note from a profile switched to `es-ES` → Spanish both ways.
   c. Send an image → confirm a `whatsapp.unsupported_message` log line and
      **no** reply.
   d. Send a corrupt or oversized audio file → confirm the canned localized
      apology arrives (silence here is the failure mode that matters).
   e. Check the Vercel function logs for `after()` timeouts. The route now
      declares `maxDuration = 300`; if the plan caps below that, the build
      would have failed, but confirm the real tail latency.
5. **Review the es-ES and en-US personas** —
   `packages/core/src/agent/persona/capo.{es-ES,en-US}.ts`. These are product
   voice, translated from your pt-PT original rather than written from
   scratch, and marked with the usual FEDERICO dial comment. Same for the
   per-locale transcription glossaries in
   `packages/core/src/agent/transcription.ts` and the copy in
   `packages/i18n/src/dictionaries/*`.
6. **Watch for a spike in pending proposals** after rollout. The guard
   authorizes direct writes by substring-matching the model's verbatim quote
   of the manager; if the model ever translates that quote, every direct
   write silently downgrades to an approval card. The language directive
   forbids it explicitly, but the failure is silent, so the metric is the
   detector.

Known, accepted: making `<html lang>` locale-aware turned `/landing`,
`/offline`, `/instalar` and the manifest from static into dynamic routes. The
service worker still precaches `/offline` (it fetches it at install, which a
dynamic route answers fine), and this is a PWA rather than an SEO property.

Merged with the task-board branch (PR #7): the two language dials live as cards
on `/perfil`, which that branch established as the only tab owning settings —
there is no separate settings page. `/tarefas` filter VALUES stay Portuguese
(`?quando=hoje`) because they are a shareable-URL contract; only their labels
are translated.

## 9. Backlog (deliberately cut from this upgrade)

18:00 materials-anticipation send (n8n reads `tasks.materials`, which now
exists — enabling the send is n8n work, not app code), two-way worker SMS
replies, multilingual worker briefings, Moloni/Vendus integration, client
progress PDF, per-seat billing, test framework adoption, Gantt charts.
