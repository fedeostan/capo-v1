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

Added 2026-07-26 — check these too (I verified the components render
correctly against mock data, but not on a real device with real data):

- Bottom nav is **Chat · Tarefas · Obras · Materiais · Perfil**.
- Paste a real multi-line orçamento into the chat composer — it is a
  growing textarea now, not a one-line input. Enter sends, Shift+Enter adds
  a newline.
- Force a chat failure (airplane mode mid-send) and confirm the error card
  with **Tentar outra vez** appears instead of silence.
- Ask Capo "o que temos hoje?" and check the answer matches the Tarefas
  board under the Hoje chip, exactly.
- Long-press the installed PWA icon → shortcuts to Tarefas and Materiais.

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

1. ✅ **DONE (2026-07-26)** — migrations `0013_task_board.sql` and
   `0014_language.sql` applied to `qdfmvhjrcmeoxbattnsm` via the Supabase
   connector. The DB had been sitting at `0012` while the app was already
   deployed — i.e. exactly the ordering this item warned against — so
   production was in fact broken until these landed: `task_board` did not
   exist (every task/materials/obras read failed) and `complete_onboarding`
   still took 3 arguments against a 4-argument caller (signup failed).
   Verified after applying: `dispatch_tasks_today` viewdef md5 **byte-identical**
   to the pre-migration baseline (`95a38640773ca0d0ae9267b696d69e2f`); row
   counts unchanged (2 companies, 1 profile, 11 tasks); `task_board` is
   `security_invoker` and returns **0 rows to `anon`**.
2. ✅ **DONE (2026-07-26)** — `packages/db/src/types.ts` reconciled against the
   live schema. One real discrepancy was found and fixed: the merge had left
   `dashboard_tasks` typed with five columns it does not have
   (`active_this_week`, `assignee_worker_id`, `duration_days`, `job_address`,
   `materials`) — leftovers from a migration that was deleted during the
   reconciliation in PR #9. Nothing read them, but the types were lying. The
   block now matches the live view's 15 columns exactly.
3. ✅ **DONE (2026-07-26)** — gates re-run against the migrated DB:
   `pnpm rls-matrix` → **26/26 visibility, 3/3 adversarial blocked** (including
   "tenant self-upgrade of subscription_status", which matters because 0014
   re-granted column privileges on `companies`), and `pnpm agent-smoke` →
   **9/9**, with the `agenda` and `materials_outlook` tool-choice checks and the
   `en-US` locale check all green. Seeded test tenants cleaned up; row counts
   confirmed back to baseline.
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

## 9. Materials anticipation + operator health (2026-07-26)

No migration of its own — it reads `task_board` from item 8's branch, which
already exposes `materials`, `assignee_worker_id` and the date window. So
nothing here blocks a deploy; it goes live with the code.

1. ⚠️ **`/materiais` will look EMPTY on your real data, and that is expected.**
   Checked 2026-07-26: all 11 existing production tasks have `materials = null`.
   They predate the planner writing materials, and most were created by hand
   through chat. The screen is not broken — there is genuinely nothing to buy
   on record.
   The feature itself is verified working: `pnpm agent-smoke` generated a fresh
   plan and `materials_outlook` correctly answered *"Amanhã só precisas de
   tratar do contentor de entulho, para a demolição da casa de banho"*.
   **To see it populated on your own data**, generate a plan for a real
   orçamento (the planner now records materials per phase), or just tell Capo
   what a given task needs.
2. **Read the operator Health page** (`/` on `capo-operator`) once with real
   data and sanity-check the alert thresholds against your own judgement: a
   proposal is "stale" after 24h, a company "quiet" after 7 days, "stuck at
   signup" after 2 days. Those numbers are guesses; they are all in one place
   at the top of `apps/operator/app/data.ts`.
3. **Decide the Spanish register.** `CONTEXT.md` says Rioplatense, but
   `packages/i18n/src/dictionaries/es-ES.ts` is written in Peninsular Spanish
   (`tú`, "inténtalo"). I matched the existing file rather than mixing two
   registers in one dictionary — but the docs and the product now disagree,
   and only you can settle which is right for the first Spanish customer.

## 10. Backlog (deliberately cut from this upgrade)

Two-way worker SMS replies, multilingual worker briefings, Moloni/Vendus
integration, client progress PDF (Flow 4's read-only share link is still
unbuilt), per-seat billing, a real test framework, Gantt charts.

**Now unblocked and worth doing next — the 18:00 anticipation send.** As of
2026-07-26 the app surfaces tomorrow's materials on `/materiais` and the
agent has a `materials_outlook` tool, so the manager-side half of the killer
feature is live. The remaining half is the evening push to workers, which is
n8n work, not app code: read `task_board` where `active_tomorrow` is true and
`materials` is non-empty, grouped by `assignee_worker_id` — every column it
needs already exists. Per `03_PRODUCT/02-flows.md` §Flow 2, the worker's
evening reply is also what keeps the 24h WhatsApp window open, so this send is
both the feature and the cost mechanism.

**Municipal holidays and Carnaval.** The plan scheduler now skips the
thirteen Portuguese *national* holidays. Municipal holidays (Lisboa 13 Jun,
Porto 24 Jun…) need the company's município, which Capo does not collect;
Carnaval is a year-by-year tolerância de ponto, not statutory. Both were
left out deliberately — see the comment at the top of
`packages/core/src/capabilities/workdays.ts`. If you want them, they belong
as a per-company setting, not a guess in the scheduler.
