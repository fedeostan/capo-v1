# Human TODO — Capo upgrade (2026-07-13)

Only-Federico items: external accounts, dashboards, physical devices —
nothing here can be done by an agent. The capo-upgrade code is merged to
`main` and live on Vercel (both `capo-v1` and `capo-operator` production
deployments are READY); everything below is what's left to fully activate
each feature.

## 0. Migrations 0015 + 0016 — ✅ APPLIED (2026-07-27)

PRs #11–#16 were merged together (2026-07-27). Two of them shipped migrations,
both now applied to the live `capo` project (`qdfmvhjrcmeoxbattnsm`):

| Migration | From | Adds | Live version |
|---|---|---|---|
| `0015_translation_batches.sql` | #11 | `translation_batches`, `translation_items`, `revert_translation_batch()` | `20260727115633` |
| `0016_worker_notifications.sql` | #12 | `notification_log`, `lisbon_hour()`, `workers.language` | `20260727115702` |

Verified after applying: all three tables and both functions exist;
`lisbon_hour()` returns Lisbon wall-clock; 6 RLS policies across the two
translation tables; `notification_log` has RLS on with **zero** policies
(deliberate deny-all, matching `dispatch_log`); and the column grants hold —
`authenticated` can update only `status/item_count/done_count/error/
started_at/finished_at` on batches and `new_value/status/applied_at` on items,
so **`old_value` is not writable by a tenant** and the undo snapshot is
immutable at the grant layer. Regenerating `packages/db/src/types.ts` was
confirmed to reproduce the committed file exactly.

### 0017 — ✅ APPLIED (live version `20260808140249`)

`0017_worker_checkins.sql` ships with the late-afternoon check-in (§12) and **is
applied** — verified against the live project on 2026-08-10, correcting the
"PENDING" this section used to claim. It adds `worker_checkins` (one row per
worker per day holding their answer), one SELECT-only RLS policy plus
`grant select`, and the `worker_checkins_fks_same_company` trigger. There is
deliberately **no** insert or update policy: the sole writer is the WhatsApp
webhook on the service role, and a tenant able to write there could forge a
worker's answer.

The two standing chores below were never done and still apply:

1. Regenerate `packages/db/src/types.ts` via the Supabase MCP and confirm it
   reproduces the committed file byte for byte. The `worker_checkins` block was
   hand-written **ahead** of the migration — the route code does not typecheck
   without it — so until this is done the file describes a table the live
   project does not have.
2. Re-run `pnpm rls-matrix`. It gains a visibility check for the new table plus
   an adversarial "a tenant cannot INSERT a check-in" case.

### 0018 — ⏳ PENDING (not yet applied)

`0018_whatsapp_optin.sql` adds `whatsapp_opt_in_at` / `whatsapp_opt_out_at` to
**both** `workers` and `profiles`, and re-states the column grants on each (they
REPLACE rather than add — `workers` has never had a column grant at all, so this
is its first, and every writable column had to be re-listed). The same two chores
apply: regenerate `packages/db/src/types.ts` and confirm byte-equality — both
blocks were hand-written ahead of the migration, so until then the file describes
columns the live project does not have — and re-run `pnpm rls-matrix`.

⚠ **Applying it stops every proactive send** until consent is recorded. That is
the intended behaviour, not a regression. See §13.

Still outstanding, because neither runs in CI and both need credentials:
`pnpm rls-matrix` (#11 adds two adversarial checks against the new
`SECURITY DEFINER` `revert_translation_batch`) and a `pnpm agent-smoke` pass
on *"põe o Miguel a receber em espanhol"* — #12 adds `language` to the
**guarded** `update_worker` tool, and that write must execute directly rather
than degrade into an approval card.

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

## 3. Meta (WhatsApp) — ✅ VERIFIED (2026-08-10), production number live

1. ✅ **Business Verification complete.** Meta shows verification *Verified* and
   account status *Approved*. The production number is **+351 911 097 383**,
   registered on the WABA 2026-08-11.

   The first pick, `+351913621087`, was abandoned: it was already the manager's
   own Portuguese handset and sat on two `workers` rows, so it would have been a
   permanent self-send (**131021**). Registering the replacement also needed one
   detour — the number carried a recycled WhatsApp registration from a previous
   holder and had to be claimed on a handset and deleted from inside the app
   first. Both traps are written up in `docs/whatsapp-cloud-api-runbook.md` §1.
2. ✅ **Payment method added** (VISA). Sends are billed now — roughly €0.04 per
   Portuguese utility template, so two sends/day × 6 workers ≈ €0.50/day.
3. ✅ Confirmed live: `capo-v1` production env has `WHATSAPP_VERIFY_TOKEN`,
   `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN` and
   `WHATSAPP_PHONE_NUMBER_ID` set — the webhook is live and configured. The
   first three are per-app and survive the number change; **only
   `WHATSAPP_PHONE_NUMBER_ID` is per-number and still points at the old test
   number** until step 1 below is done.

⚠ The old item 1 here said the `testTierArSendTarget` AR workaround "becomes a
no-op once verified (leave the code)". **That was wrong** and it is now deleted:
the regex matched the *modern* Argentine wa_id and rewrote it into the legacy
allow-list form, so it fired on every send to the only manager on the system
(`+5491…`). Off the test tier there is no allow-list to accept that form. See
"Phone formats" in `docs/whatsapp-cloud-api-runbook.md`.

### Still outstanding for this milestone

1. **Set `WHATSAPP_PHONE_NUMBER_ID`** in Vercel (`capo-v1`, Production +
   Preview), then redeploy. This is the *only* per-number env var.

   **There are two WhatsApp Business Accounts**, which is the thing to remember:

   | WABA | Holds | Phone number ID |
   |---|---|---|
   | `2042479536344006` | sandbox `+1 555-176-7609` "Test Number" | `1301175446407795` |
   | `715247827972608` | production `+351 911 097 383` "Capo", VERIFIED | `1271622762699292` |

   Vercel was pointing at the sandbox id, so production had been sending *as the
   test number* — no error, just the wrong identity. The value to set is
   `1271622762699292`.

   Because the production number is on a **different** WABA, two things follow:
   the System User token needs that account added as an asset (Business Settings
   → System users → Add assets → WhatsApp accounts → Full control), or sends fail
   on permissions; and no template approved on the old account carries over.

   `pnpm whatsapp-template numbers` prints these; the dashboard shows the Phone
   number ID next to an identically-shaped WABA id, which is easy to confuse.
2. ✅ **Crew rows cleaned up (2026-08-10/11).** `Zé` → `+351900000000` (a
   deliberately unroutable placeholder: `90` is not an allocated Portuguese
   mobile prefix, so it cannot reach a stranger). `Pepe` → `+351913621077`.
   `João`, `Manel` and `Rui` deactivated (`active = false`, not deleted — the
   `tasks.assignee_worker_id` FK forbids the delete, and their three open tasks
   stay attributable). `Federico Ostan Bazan`'s row keeps `+351913621087`, which
   is fine now that it is no longer the business number.

   Three overdue tasks are consequently assigned to inactive workers, so nobody
   is briefed about them. They remain on the Tarefas board under **Atrasadas**.
3. **Submit BOTH templates on the new WABA.** This is no longer "add the two
   missing languages" — templates belong to a WABA, so the pt_PT
   `capo_daily_briefing` approved on the sandbox account does not exist on
   `715247827972608`. All six name+language pairs start from nothing.

   That incidentally clears two older problems: the daily **132001**
   `does not exist in en_US` failure, and the body-text drift between the
   hand-made pt_PT template and the repo definition — everything is now created
   from `scripts/whatsapp-templates.ts`, so `status` should come back clean with
   no WARN.

   ```
   WHATSAPP_WABA_ID=715247827972608 pnpm whatsapp-template create
   WHATSAPP_WABA_ID=715247827972608 pnpm whatsapp-template status
   ```

   No 2388023 this time — nothing exists yet, so every pair should submit. Repeat
   `status` until all PASS; approval is usually minutes.
4. **Record consent for the crew.** Migration `0018` gates every proactive send
   on an opt-in record and existing rows were deliberately not backfilled, so
   nothing is sent until you do. See §13.

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
2. ✅ **DONE (2026-07-27).** `0016_worker_notifications.sql` is applied —
   `workers.language`, `lisbon_hour()` and `notification_log` are live. See §0.
3. **Create the `capo_daily_briefing` template** in WhatsApp Manager, in
   pt_PT + es_ES + en_US, category Utility, two body parameters. Full
   instructions in `docs/whatsapp-cloud-api-runbook.md` §6. Until it is
   approved every send fails with Meta code **132001**.
4. ~~**Add every pilot worker's number to the WhatsApp test recipient
   allow-list**~~ — **MOOT (2026-08-10).** The business is verified and the
   production number has no allow-list, so **131030** should never appear again.
   The allow-list was also the de-facto consent gate, and losing it is exactly
   why §13 exists; that is now the step to do instead of this one.
5. ✅ **`CRON_SECRET` is set.** This said "still outstanding" as of 2026-08-08,
   but the live `notification_log` shows both crons firing and writing rows, so
   the bearer is in place. (Vercel injects it as `Authorization: Bearer …` on
   scheduled invocations; without it the route answers 503 and nothing is sent.)
6. **Confirm the Vercel Root Directory for `capo-v1`.** `vercel.json` was
   written to `apps/web/vercel.json` on the assumption that the project root
   is `apps/web` (which is what having two separate projects implies). If the
   root is the repo root instead, **move the file there** — a misplaced
   `vercel.json` is silently ignored, so the symptom is simply that no cron
   ever fires.

   > Updated 2026-08-08: this step used to warn that Hobby allows **2 cron
   > jobs, once daily, fired within the hour**, and that the two entries here
   > consumed that budget exactly. The project is on **Pro**, so the cap does
   > not bind and schedules fire at the stated minute. §12 adds two more
   > entries on that basis. If the plan is ever downgraded, those four entries
   > are the first thing that breaks — silently, because a rejected cron
   > config just means no cron ever fires.

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
~~Also, no consent column was added~~ — **closed by migration `0018`
(2026-08-10).** That debt came due the moment the allow-list stopped being the
gate; see §13.

## 12. late-afternoon worker check-in (2026-08-08)

The end-of-day "did you finish today's tasks?" nudge, answered by two template
quick-reply buttons and recorded in `worker_checkins`. Deterministic end to end —
no model is called in either direction, so the "Ainda não" branch is free.

It records an **answer only**. It does not flip `tasks.status`; that is a later
PRD, and it should land against a table that already holds the answers.

**Nothing here works until all five steps are done.** Until then the cron runs,
finds no approved template, and writes `failed` rows to `notification_log` — the
same pre-launch state as §11, not a bug.

1. **Apply `0017_worker_checkins.sql`**, then do the two standing chores in §0
   (regenerate `packages/db/src/types.ts` and confirm byte-equality; re-run
   `pnpm rls-matrix`).
2. **Submit the template.** `pnpm whatsapp-template create`, then
   `pnpm whatsapp-template status` until every line is PASS. Full instructions
   and the credential caveats are in `docs/whatsapp-cloud-api-runbook.md` §6.
   ⚠ The WhatsApp secrets are **Sensitive** in Vercel and cannot be pulled back
   — `vercel env pull` returns the literal `[SENSITIVE]`. You need the System
   User token from your own records, or a freshly generated one (runbook §3),
   which must then also be updated in Vercel.
3. ✅ **`CRON_SECRET` is set.** This said "confirmed absent on 2026-08-08"; the
   live `notification_log` shows both crons firing, so it is in place.
4. ~~**The allow-list**~~ — moot, see §11 step 4. Replaced by §13.
5. ⚠ **The two check-in cron entries were rescheduled, because this send had
   NEVER FIRED.** `worker_checkins` was empty and `notification_log` held zero
   `task_checkin` rows, while `daily_briefing` rows existed for the same workers
   on the same days.

   The cause was thirty minutes. **Vercel's cron dispatch drifts** — every
   briefing row is stamped 06:45 UTC for an entry scheduled at 06:00, about 45
   minutes late, reproducibly on both observed days. Both routes gate on
   `lisbon_hour()` matching exactly. The `:30` entries drifted past the hour
   boundary (16:15 UTC = Lisbon 17, not 16) and were rejected every single time;
   the 07:00 briefing survived the identical drift only because `:00` leaves a
   full hour of headroom. `apps/web/vercel.json` now uses `0 15` / `0 16` UTC and
   the send lands in 16:00–16:59 Lisbon.

   Both routes now also `logEvent` on the rejection. Before that it wrote no row
   and raised no error, which is the whole reason this went unnoticed.

   Note this also means the drift is larger than "fires at the stated minute", so
   the §11 step 6 note about Pro scheduling is optimistic. It does not matter now
   that both schedules are on the hour.

Then verify, in this order:

- `curl -H "Authorization: Bearer $CRON_SECRET" 'http://localhost:3000/api/cron/checkin?dry_run=1'`
  — renders every eligible worker, sends nothing, writes nothing, and ignores
  the hour gate so it works at any time of day. Workers with no tasks today
  must be **absent** entirely, not listed as skipped.
- Re-run without `dry_run` twice and confirm the second call sends nothing more,
  and that `notification_log` holds exactly one `task_checkin` row per worker
  per day alongside the morning's `daily_briefing` row.
- On a real phone: tap **Ainda não** → an ack in the worker's language, one
  `worker_checkins` row with `answer='not_done'`, and **zero** model calls in
  the logs. Then tap **Sim, terminei** → a second ack, the **same** row flipped
  to `done` with a newer `answered_at`, and a free-form send now succeeds
  (proving the tap opened the 24h window).
- Confirm `tasks.status` is untouched and **nothing** appeared in the manager's
  chat thread.
- Operator app → **Health** shows "Check-ins asked", and **Briefing log** now
  has a Kind column separating the two daily sends.

Same retry rule as §11: a `failed` row holds that day's claim, so approving the
template at 17:00 and re-invoking sends nothing that day. Delete the
`notification_log` rows to force a retry.

One dial worth a look, and it is a single line in
`apps/web/app/api/cron/checkin/route.ts`: there is deliberately **no**
`NOTIFY_IDLE_WORKERS` equivalent — a worker with nothing on today is skipped
before any claim is written, because asking them whether they finished it is not
a product decision with two defensible answers.

## 13. WhatsApp opt-in record (2026-08-10) — the allow-list's replacement

Meta's five-number test allow-list was doing consent work nobody designed it to
do: a number that had not confirmed an opt-in code simply could not be reached.
Business verification removed it. Meta's business-messaging policy still requires
a recorded opt-in before any proactive template send, and requires opt-outs to be
honoured, so migration `0018` makes that explicit and the send path enforces it.

**Nothing proactive is sent to anyone without a record.** Existing rows were
deliberately not backfilled — writing a consent record nobody gave would be a lie
told in SQL — so after `0018` lands, expect Capo to go quiet until you act.

1. **Apply `0018_whatsapp_optin.sql`**, then the two standing chores in §0.
2. **Tick your own consent** on `/perfil` → **Mensagens no WhatsApp**. Until you
   do, your own 07:00 briefing stops (logged as `reminders.manager_no_consent`).
3. **Ask the crew, in person, then tell Capo** — *"o Zé aceita receber mensagens
   no WhatsApp"*. That routes through the guarded `update_worker` tool, so it
   needs your words, not an inference. `/perfil` shows **Falta autorização** on
   any worker who has a number but no record, and `list_workers` reports
   `falta_consentimento`, so neither surface can claim someone is covered when
   they are not.
   If you would rather do all five at once after actually asking them:
   `update workers set whatsapp_opt_in_at = now() where company_id = '…' and active and phone is not null;`
4. **Tell the crew how to leave.** Replying **STOP** unsubscribes them and
   **START** brings them back, deterministically and with no model involved. The
   `capo_daily_briefing` template copy in `scripts/whatsapp-templates.ts` says so
   in every message — but the live pt_PT template predates that copy, so it will
   not say it until you edit it in WhatsApp Manager to match (`status` prints a
   WARN showing the diff).

Watch `reminders.workers_no_consent` / `checkin.workers_no_consent` in the logs:
they carry the count of people dropped for want of a record, and they are what
explains a quiet morning.

One judgement call worth knowing about: you *can* supersede a worker's STOP by
re-attesting consent, because latest-wins and `whatsapp_opt_in_at` is writable by
the tenant. That is deliberate — "põe o Zé outra vez a receber" runs through you
on a crew this size — and both timestamps are kept, so the sequence stays
readable. It is also why the tools are guarded.

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
