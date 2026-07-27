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

## 5. Twilio (worker SMS) — PAUSED as of 2026-07-26, see §11

Superseded: worker briefings now go out over WhatsApp. Kept here because the
path is paused rather than deleted and these are the steps to bring it back.

1. Upgrade the Twilio account from trial so worker SMS reaches real (not
   just verified) numbers.
2. The external n8n 07:00 Lisbon cron that reads `dispatch_tasks_today` should
   now be **switched off** (§11.1). The view and `dispatch_log` are still
   byte-identical to the pre-upgrade baseline, so re-enabling the workflow is
   the only step needed to resume SMS — but do not run both channels at 07:00
   without checking `dispatch_log`'s `unique (worker_id, dispatch_date)`
   against the parallel `notification_log`.

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

## 11. SMS off, WhatsApp briefings on (2026-07-26) — see §10 for what stayed cut

The 07:00 worker briefing moved from SMS (external n8n + Twilio) to WhatsApp,
sent by a Vercel Cron inside `capo-v1`. The manager also gets it, both on
WhatsApp and as a permanent note in their chat thread. Nothing in the repo can
switch SMS off — that is step 1, and it is yours.

**Nothing here works until all six steps are done.** Until then the cron runs,
finds no approved template, and writes `failed` rows to `notification_log`.

1. **Switch off the n8n workflow `LJu5bNaRL9gLpeQ0`.** This is the only thing
   that actually stops the SMS going out. Leave the workflow in place — the DB
   contract it reads is untouched, so re-enabling is a toggle.
2. **Apply migration `0016_worker_notifications.sql` BEFORE deploying the
   code.** It adds `workers.language`, `lisbon_hour()` and `notification_log`.
   Deploying first means every cron run 500s and `/perfil` is unaffected but
   the operator Briefing log page errors. (This is the same ordering hazard
   that broke production in §8.1 — the DB sat at 0012 under a 0013 app.)
3. **Create the `capo_daily_briefing` template** in WhatsApp Manager, in
   pt_PT + es_ES + en_US, category Utility, two body parameters. Full
   instructions in `docs/whatsapp-cloud-api-runbook.md` §6. Until it is
   approved every send fails with Meta code **132001**.
4. **Add every pilot worker's number to the WhatsApp test recipient
   allow-list** (5 max on the free test tier) and have each confirm the opt-in
   on their phone. The number must equal `workers.phone` exactly, in E.164.
   A number that is not on the list fails with **131030** — expect to see this
   in the operator Briefing log while you work through the list.
5. **Set `CRON_SECRET`** in the Vercel `capo-v1` project (Production +
   Preview) and in `apps/web/.env.local`. Vercel injects it automatically as
   `Authorization: Bearer …` on scheduled invocations; without it the route
   answers 503 and nothing is sent.
6. **Confirm the Vercel Root Directory for `capo-v1`.** `vercel.json` was
   written to `apps/web/vercel.json` on the assumption that the project root
   is `apps/web` (which is what having two separate projects implies). If the
   root is the repo root instead, **move the file there** — a misplaced
   `vercel.json` is silently ignored, so the symptom is simply that no cron
   ever fires. Also check the plan: Hobby allows **2 cron jobs, once daily,
   fired within the hour**, and the two entries here consume that budget
   exactly.

Then verify, in this order:

- `curl -H "Authorization: Bearer $CRON_SECRET" 'http://localhost:3000/api/cron/reminders?dry_run=1'`
  — renders everything, sends nothing, writes nothing, and ignores the hour
  gate so it works at any time of day. Check each worker with work today
  appears once, and that the locale is theirs.
- Re-run without `dry_run` and confirm a second call sends nothing more
  (`notification_log`'s unique constraint holding).
- On a real phone: the 07:00 message arrives; reply `ES` → confirmation in
  Spanish and `workers.language` flips; reply anything else → the canned ack,
  and **nothing** appears in the manager's chat thread; a number matching
  neither table still gets total silence.
- Operator app → **Briefing log** shows the sends, with Meta error codes on
  the failures.

A `failed` row holds that day's claim, so a transient error costs that person
one briefing rather than risking a duplicate. To force a retry, delete the
`notification_log` row and re-invoke the route.

Two dials worth a look once it runs, both single constants:

- `NOTIFY_IDLE_WORKERS` in `apps/web/app/api/cron/reminders/route.ts` —
  currently `false`, so a worker with nothing today is not messaged at all
  (recorded as `skipped`). Set it `true` if you would rather Capo were never
  silent; it costs one template send per idle worker per day.
- `renderWorkerBriefing()` in `apps/web/app/notifications/briefing.ts` — the
  product-voice dial for the whole feature. It currently lists at most 5 tasks
  then "+N", shows the obra in parentheses, and puts overdue tasks first with
  their age. All three are judgement calls about your users, not architecture.

Known and accepted: **briefings are bilingual.** Task titles and materials are
stored in `companies.language` and nothing retranslates existing rows, so a
worker who picks `es-ES` gets a Spanish sentence wrapping Portuguese titles.
Also, no consent column was added — Meta's 5-number allow-list is the gate in
test mode, but a real opt-in record is required before production under Meta's
business-messaging policy.

## 10. Backlog (deliberately cut from this upgrade)

Moloni/Vendus integration, client progress PDF (Flow 4's read-only share link
is still unbuilt), per-seat billing, a real test framework, Gantt charts.

Two items left this list on 2026-07-26 (see §11): **multilingual worker
briefings** shipped as `workers.language`, and **two-way worker replies**
shipped in the narrowest possible form — a worker can reply `PT`/`ES`/`EN` to
change their language, and anything else gets a canned ack. A real
conversation with workers is still cut: it would put third-party text into the
model's context window, which is a security decision, not a feature decision.

**Now much cheaper to build — the 18:00 anticipation send.** As of 2026-07-26
the app surfaces tomorrow's materials on `/materiais` and the agent has a
`materials_outlook` tool, so the manager-side half of the killer feature is
live. The evening push to workers is no longer n8n work: `/api/cron/reminders`
already has the scheduler, the template sender, the per-target idempotency
ledger and the locale resolution. An evening send is a second `kind` in
`notification_log` (the unique constraint is per-kind, so it will not collide
with the morning briefing), a second Meta template, and a `task_board` read
where `active_tomorrow` is true and `materials` is non-empty, grouped by
`assignee_worker_id`. Per `03_PRODUCT/02-flows.md` §Flow 2, the worker's
evening reply is also what keeps the 24h WhatsApp window open, so this send is
both the feature and the cost mechanism.

**Municipal holidays and Carnaval.** The plan scheduler now skips the
thirteen Portuguese *national* holidays. Municipal holidays (Lisboa 13 Jun,
Porto 24 Jun…) need the company's município, which Capo does not collect;
Carnaval is a year-by-year tolerância de ponto, not statutory. Both were
left out deliberately — see the comment at the top of
`packages/core/src/capabilities/workdays.ts`. If you want them, they belong
as a per-company setting, not a guess in the scheduler.
