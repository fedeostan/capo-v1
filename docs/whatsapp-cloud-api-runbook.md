# WhatsApp manager channel — Meta Cloud API runbook

One-time, manual operator setup for the WhatsApp channel
(`apps/web/app/api/whatsapp/route.ts`). Everything here happens in Meta's
dashboards; the code is already deployed and waits on the four env vars at the
end.

Model: **one shared business number for everyone.** Senders are identified by
phone (`profiles.phone`, unique E.164) → `company_id` → that company's
perpetual thread with `channel='whatsapp'`. Unknown numbers are silently
ignored.

> **Status: production.** Meta business verification is complete and the
> production number is **+351 911 097 383** (registered on the WABA 2026-08-11).
> The free test tier — its test number, its five-recipient allow-list, and its
> zero bill — is gone, and three things follow that are easy to miss:
>
> - **The allow-list was the de-facto consent gate.** Nothing stops a send now
>   except the opt-in record — see "Opt-in and opt-out" below. That section is
>   not optional reading.
> - **Sends are billed.** Roughly €0.04 per Portuguese utility template.
> - **The business number can never message itself.** Any `workers.phone` or
>   `profiles.phone` equal to the business number is permanently undeliverable
>   (**131021**), and a duplicate `workers.phone` additionally makes inbound
>   replies from that handset silent, via the ambiguity guard. Check any
>   candidate against both columns *before* registering it — the first pick,
>   +351913621087, was already on two `workers` rows and was the manager's own
>   Portuguese handset.
>
> Registering a number requires it to have **no existing WhatsApp account** —
> not consumer, not the Business app. Portuguese mobile numbers get recycled, so
> a number you have never used can still carry the previous holder's
> registration; the fix is to put the SIM in a phone, register it in the normal
> WhatsApp app (possession of the SIM *is* ownership), then **Settings → Account
> → Delete my account**. Uninstalling the app is not enough and leaves the
> registration alive.

## 1. Meta app + WhatsApp product

1. https://developers.facebook.com → **Create App** → type *Business*.
2. Add the **WhatsApp** product to the app.
3. **Get the Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`. This is the only
   env var that is per-number; everything else is per-app or derived.

   **Ask the API, not the dashboard:**

   ```
   pnpm whatsapp-template numbers
   ```

   Meta has renamed and restructured this page twice — it was **API Setup**, it
   is now **Step 1: Try it out** inside a Quickstart flow (*"Paso 1. Pruébalo"*
   in Spanish), and the sidebar is localized on top of that. The command above
   asks the WABA directly and prints each number with its id, so it does not
   care what the page is called this quarter.

   > ⚠ The Phone number ID is **not** the phone number, and it is **not** the
   > WhatsApp Business Account ID — those last two are both opaque ~15-digit
   > strings shown side by side in the dashboard. Pasting the WABA id gives a
   > 404 on every send and no other symptom. Nothing needs the WABA id in an env
   > var; it is discovered from the token.

   If you do want the dashboard: WhatsApp → **Step 1: Try it out** → the **From**
   dropdown → select the production number → **Phone number ID** underneath.
   Registering a new number and the webhook both live under **Step 2: Production
   setup**.
4. **Templates live on the WABA, not on the number**, and there is very likely
   more than one WABA. Registering a production number through the Quickstart
   flow creates a *separate* WhatsApp Business Account from the sandbox one that
   came with the app — that is what happened here, and it caught us out.

   Consequences, all of which look like unrelated bugs:
   - The approved templates on the old WABA **do not come with the number**.
     Both must be submitted again on the new account.
   - The System User token must have the **new** WABA added as an asset
     (Business Settings → System users → *Add assets* → WhatsApp accounts →
     Full control), or sends fail on permissions with a correct Phone number ID.
   - `discoverWabaId()` reads the token's granular scope, so it returns whichever
     account the token is granted — pass `WHATSAPP_WABA_ID` to point the script
     at the other one.

   `pnpm whatsapp-template numbers` on each WABA id is how you tell them apart:
   the sandbox one answers with a `+1 555…` "Test Number", the real one with your
   number and its verified display name.

## 2. Webhook

1. WhatsApp → Configuration → Webhook → **Edit**:
   - Callback URL: `https://<production-domain>/api/whatsapp`
   - Verify token: invent a long random string → `WHATSAPP_VERIFY_TOKEN`.
2. Click **Verify and save** — Meta calls `GET /api/whatsapp` with the
   challenge; the route answers it once the env var is deployed, so set the
   env vars (step 4) *before* verifying.
3. Webhook fields: subscribe to **messages** (only).

## 3. Permanent token (System User) — solves token expiry

1. https://business.facebook.com → Business Settings → Users → **System
   users** → Add: name e.g. `capo-whatsapp`, role *Admin* (or Employee with
   asset access below).
2. System user → **Add assets** → Apps → select the Meta app → **Full
   control**.
3. **Also grant the WhatsApp Business Account itself** — Business Settings →
   **Accounts → WhatsApp accounts** → select the WABA → **Add people** → the
   system user → **Full control**.

   This step is separate from the App grant above and easy to miss, because
   sending messages does not need it: `POST /{phone-number-id}/messages` is
   authorized by the App grant alone, so the webhook and the daily crons all
   work without it. What breaks is anything addressing the **WABA** —
   `/{waba-id}/message_templates`, i.e. all of `pnpm whatsapp-template`.

   The symptom is not a permissions error. `debug_token` reports the
   `whatsapp_business_management` scope as present but with an empty
   `target_ids`, so the script reports *"this token carries no
   whatsapp_business_management target"*.
4. System user → **Generate token**:
   - App: the Meta app.
   - Expiration: **Never**.
   - Scopes: `whatsapp_business_messaging` + `whatsapp_business_management`.

   **Generate the token AFTER the asset grants**, not before. Granular scopes
   are resolved when the token is issued, so a token minted earlier keeps an
   empty `target_ids` no matter what you grant afterwards — re-granting fixes
   nothing until you mint a new token.
5. The generated token → `WHATSAPP_ACCESS_TOKEN`. It is shown once — store it
   somewhere you can retrieve it (a password manager). It is **not** enough to
   put it only in Vercel: the vars there are marked *Sensitive*, which makes
   them write-only, so `vercel env pull` returns the literal string
   `[SENSITIVE]` and the dashboard will not show it either. A token that exists
   only in Vercel cannot be used by `pnpm whatsapp-template`, `pnpm
   agent-smoke`, or anything else local.
6. App secret: developers.facebook.com → the app → App settings → Basic →
   **App secret** → `WHATSAPP_APP_SECRET` (signs `X-Hub-Signature-256`; the
   webhook rejects any POST that doesn't verify).

## 4. Env vars (server-only, read lazily — never NEXT_PUBLIC)

Add to the **web** Vercel project (Production + Preview) and to
`apps/web/.env.local`:

```
WHATSAPP_VERIFY_TOKEN=<long random string you invented>
WHATSAPP_APP_SECRET=<app secret>
WHATSAPP_ACCESS_TOKEN=<never-expiring system user token>
WHATSAPP_PHONE_NUMBER_ID=<phone number id>
```

## 5. Verify end-to-end

1. From the manager's own WhatsApp, message the production number
   (e.g. "que tarefas tenho hoje?").
2. Expect: agent reply from the shared number within ~10–30s; the exchange
   appears in that company's thread (operator app → Conversations) with
   `channel='whatsapp'`.
3. From a phone NOT in `profiles.phone`: expect no reply, nothing persisted
   (check the operator app), and a `whatsapp: inbound from unknown number`
   line in the Vercel function logs.
4. Ask for something Capo will propose (e.g. "cria a obra Casa do Paco na Rua
   5"). Expect the approval card as a message with two tappable buttons; tap
   **Aprovar**; expect the confirmation reply and the row on the Tarefas
   board. `whatsapp.button_reply` then `whatsapp.proposal_resolved` in the
   logs.

## 6. Message templates

Two of them, both Utility, both in pt_PT + es_ES + en_US. Every proactive send
goes through one: they are the only way to reach someone outside the 24-hour
window.

`pnpm whatsapp-template` manages them from the repo:

```
pnpm whatsapp-template numbers  every phone number + its Phone number ID (§1)
pnpm whatsapp-template list     every template on the WABA, with status
pnpm whatsapp-template status   the ones we manage: PASS/FAIL + exit code
pnpm whatsapp-template create   submit scripts/whatsapp-templates.ts
```

It needs `WHATSAPP_ACCESS_TOKEN`, which lives in Vercel and **not** in
`apps/web/.env.local`. Export it for the one command:

```
vercel env pull /tmp/vercel.env --environment=production
set -a; . /tmp/vercel.env; set +a; pnpm whatsapp-template status
```

> ⚠ Never `vercel env pull` **over `apps/web/.env.local`**. It rewrites its
> target file wholesale, and that file holds local-only keys that are not in
> Vercel (`GOOGLE_GENERATIVE_AI_API_KEY`, `SUPABASE_PASSWORD`, `TWILIO_*`,
> `VERIFIED_TEST_PHONE`). It is also a symlink into the main checkout, so the
> loss would not be confined to a worktree.

> ⚠ The WhatsApp secrets are marked **Sensitive** in Vercel, which makes them
> write-only: `vercel env pull` returns the literal string `[SENSITIVE]` for
> them and the dashboard will not show them either. If you no longer hold the
> System User token outside Vercel, generating a fresh one (§3) is the only way
> to run this script — and it has to be updated in Vercel at the same time.

The WABA id is discovered from the token itself (`GET /debug_token` →
`granular_scopes` → `whatsapp_business_management.target_ids`), so there is no
env var to keep in sync. `WHATSAPP_WABA_ID` overrides if one token ever covers
several accounts.

Template copy lives in `scripts/whatsapp-templates.ts`, and the button labels in
`@capo/i18n` (`whatsapp.checkinDoneButton` / `checkinNotDoneButton`) so there is
one home for user-facing strings. `status` diffs the live buttons against the
catalog — editing a label in the catalog does **not** change the approved
template, and that diff is what tells you so.

### 6a. `capo_daily_briefing`

Needed by the 07:00 reminder cron (`apps/web/app/api/cron/reminders`), which
messages workers who have never written to Capo and so is always outside the
24-hour window.

It **now has a definition in the repo** (`capoDailyBriefing()` in
`scripts/whatsapp-templates.ts`), added after its pt_PT-only, hand-made approval
turned into a daily failure: every 07:00 run wrote a `notification_log` row
reading `template name (capo_daily_briefing) does not exist in en_US`, because
the manager's `profiles.language` is `en-US` and only Portuguese was ever
created. es_ES was missing too.

Because pt_PT was approved before that definition existed, the live pt_PT body
may not match the repo's. `status` prints a **WARN** (not a FAIL — an approved
template still delivers) when they differ. Meta has no API to rewrite an
approved name+language pair and `create` answers **2388023** for one that
exists, so the fix is to edit the live template in WhatsApp Manager to match.

Submitting the missing languages:

```
pnpm whatsapp-template create   # fills es_ES + en_US; pt_PT answers 2388023
pnpm whatsapp-template status   # until every line is PASS
```

If you are creating it from scratch instead:

1. WhatsApp Manager → **Message templates** → Create template.
   - Name: `capo_daily_briefing` (must match `TEMPLATE_NAME` in the route).
   - Category: **Utility**. Not Marketing — this is transactional, and Utility
     gets better delivery and a lower per-message price.
   - Languages: create the SAME template in **Portuguese (PT)**, **Spanish
     (ES)** and **English (US)**. The route picks one per recipient from
     `reminders.templateLanguage` in `packages/i18n`, which sends Meta's
     underscore codes `pt_PT` / `es_ES` / `en_US`.
2. Body: exactly **two** parameters, in this order — `{{1}}` the recipient's
   name, `{{2}}` the one-line summary. For example:
   `Bom dia {{1}}. Hoje: {{2}}. Responde PT, ES ou EN para mudar de idioma.`
   Meta rejects a body that starts or ends with a parameter, and requires
   sample values for each.
3. Approval usually takes minutes; the send fails with **132001** until it
   lands.

### 6b. `capo_task_checkin`

The late-afternoon check-in (`apps/web/app/api/cron/checkin`): "did you finish
today's tasks?", answered by tapping one of two quick-reply buttons. Submit it
with `pnpm whatsapp-template create`; the definition is
`capoTaskCheckin()` in `scripts/whatsapp-templates.ts`.

> ⚠ **This send used to fire at 16:30 and never once ran.** `worker_checkins`
> was empty and `notification_log` held zero `task_checkin` rows, while
> `daily_briefing` rows existed for the same workers on the same days.
>
> The cause was thirty minutes. **Vercel's cron dispatch drifts** — every
> briefing row was stamped 06:45 UTC for an entry scheduled at 06:00, about 45
> minutes late, reproducibly. Both routes gate on `lisbon_hour()` being exactly
> the send hour. A `:00` schedule has a full hour of headroom before the Lisbon
> hour rolls over; the check-in's `:30` schedule had thirty minutes, so both its
> entries drifted past the boundary and were rejected. The 07:00 briefing
> survived the identical drift purely because it was scheduled at `:00`.
>
> `apps/web/vercel.json` now uses `0 15` / `0 16` UTC, and the send lands
> somewhere in **16:00–16:59 Lisbon**. Do not "tidy" it back to a nicer
> wall-clock time. Both routes now also `logEvent` when the gate rejects them —
> before that, a rejection wrote no row and raised no error, which is exactly
> why this was invisible for days.

- Name `capo_task_checkin`, category **Utility**, `parameter_format`
  **POSITIONAL**, three languages.
- Body: two parameters, same order as the briefing — `{{1}}` the worker's name,
  `{{2}}` the task list. Both rendered by `renderWorkerBriefing`, the same
  function the 07:00 briefing uses, so the two messages cannot drift about what
  "your tasks today" means.
- **Two `QUICK_REPLY` buttons**, and their ORDER IS A CONTRACT: index 0 is
  "done", index 1 is "not_done". `/api/cron/checkin` mints its payloads in that
  order. Reordering them in WhatsApp Manager inverts every answer and the Graph
  API answers the send with a cheerful **200**.

**Outbound** — the button payload is set per-send, not at creation:

```json
{ "type": "button", "sub_type": "quick_reply", "index": "0",
  "parameters": [{ "type": "payload", "payload": "capo:checkin:done:<uuid>" }] }
```

`index` is a **string**. The uuid is the `notification_log` row of the ask —
not the worker, not the date — which is what lets a tap arriving hours later
still be recorded against the day it was asked about, and gives the webhook
exactly one row to check ownership against.

**Inbound** — `messages[].type === 'button'` with `button: { payload, text }`,
handled in `handleWorkerReply` → `handleCheckinTap`. No model, in either
direction.

Two ways this fails that do not look like failures:

- **Buttons approved, button component omitted on send.** Meta returns **200**,
  the worker sees the buttons, and their tap comes back with
  `payload: "Sim, terminei"` — the button's own LABEL. `parseCheckinPayload`
  returns null, the tap falls through to the ordinary `workerAck`, and the only
  evidence anywhere is a `whatsapp.unknown_checkin_payload` log line. This is
  the single most likely silent failure in the feature.
- **A button component for an index the approved template does not declare** →
  **132000** on every send. So the template must be approved *with* its buttons
  before the first send; a body-only approval is not enough.

Four things that fail silently or confusingly:

- **A template does NOT open the 24-hour window.** Only the recipient's reply
  does. Until a worker replies, every briefing is a paid template send — which
  is why the webhook acknowledges worker replies (`handleWorkerReply`): the ack
  is what converts them into free session messages.
  Be honest about the arithmetic for workers, though: a worker who never taps
  costs **two** paid templates a day (07:00 and late afternoon), and a worker who *does*
  tap in the afternoon opens a window that has closed again by the next morning's
  briefing 14½ hours later. The check-in acks are worth sending for the UX and
  because a tap is what makes PRD 4's conversational reply legal — not because
  they save money on the briefing.
- **Parameters may not contain newlines, tabs, or runs of 4+ spaces.** Meta
  rejects the whole send with **132000**. `toTemplateParam()` in
  `packages/core/src/channels/whatsapp.ts` flattens whitespace for exactly this
  reason; never bypass it.
- **Changing the parameter count means re-submitting the template.** Body
  params are positional and validated on send.
- **Task titles inside the message are NOT translated.** They are stored in
  `companies.language` and nothing retranslates existing rows, so a worker on
  `es-ES` gets a Spanish sentence around Portuguese titles. Deliberate.

## Opt-in and opt-out (migration `0025`)

**Nothing proactive is sent to anyone without a recorded opt-in.** Meta's
business-messaging policy requires one before a template send, and requires
opt-outs to be honoured. On the test tier Meta's five-number allow-list enforced
this by accident — an unconfirmed number simply could not be reached. The
production number has no allow-list, so the record is the gate.

Two nullable timestamps on **both** `workers` and `profiles`:
`whatsapp_opt_in_at` and `whatsapp_opt_out_at`. **Latest wins** —

```
opted in  ⟺  opt_in_at is not null and (opt_out_at is null or opt_out_at < opt_in_at)
```

Nothing is ever cleared, matching the schema's no-DELETE posture: a withdrawal
marks, and the pair stays readable as the audit trail.

`hasWhatsAppConsent()` in `packages/core/src/channels/whatsapp.ts` is the single
implementation. It **fails closed** on a missing opt-in, an unparseable
timestamp, a tie, or a row from a deploy that landed before its migration.
`scripts/whatsapp-check.mts` pins the whole truth table in CI — that assertion
already caught one fail-open branch.

The gate itself is applied in exactly one place, `loadCompanyBriefing()` in
`apps/web/app/notifications/briefing.ts`, which **both** proactive sends read.
The manager's own briefing is gated separately in `/api/cron/reminders`, because
managers come from `profiles` rather than that function.

How consent is recorded:

| Who | Where | Notes |
|---|---|---|
| Manager, for themselves | `/perfil` → **Mensagens no WhatsApp** | Radio pair + save, never a bare checkbox — a mis-tap must not withdraw consent |
| Manager, for a worker | chat → `add_worker` / `update_worker` (`whatsapp_opt_in`) | Both **guarded**, so it needs their verbatim instruction, never a model inference |
| Worker, for themselves | replying **STOP** / **START** | Deterministic, no model — see "Worker replies" |

> ⚠ **Existing rows were deliberately NOT backfilled.** Every worker and profile
> starts with a null `opt_in_at`, so after this migration lands *all proactive
> sends stop* until consent is actually recorded. That is the correct behaviour
> and the whole reason the requirement exists — writing a consent record nobody
> gave would be a lie told in SQL. Expect "Capo has gone quiet" to be the first
> symptom; `reminders.workers_no_consent` in the logs is what explains it.
>
> Once the crew has genuinely been asked:
> `update workers set whatsapp_opt_in_at = now() where company_id = '…' and active and phone is not null;`

A manager *can* supersede a worker's STOP by re-attesting consent, because
`whatsapp_opt_in_at` is grantable to `authenticated` and latest wins. That is
deliberate — on a six-person crew "põe o Zé outra vez a receber" runs through the
manager, not a self-service portal the crew does not have — and it is why both
timestamps are kept and why the tools are guarded. Withholding the opt-out column
from the grant would *not* have prevented it, since a fresh opt-in supersedes
anyway; it would only have stopped a manager from recording a withdrawal a worker
told them about in person.

## Phone formats, and the Argentine trap that is now gone

Storage is E.164 with the `+` (`profiles.phone`, `workers.phone`). Meta's
`wa_id` is the same digits without it, so `toSendTarget()` is a `+` strip and
nothing more.

It used to be more. Meta's **test-tier** allow-list stored Buenos Aires mobiles
in the legacy domestic form (`54 11 15 XXXXXXXX`) rather than the wa_id's modern
form (`549 11 XXXXXXXX`), and sending to the wa_id was rejected as **131030**.
`testTierArSendTarget()` rewrote every `+549…` number into the legacy shape to
compensate.

Older notes in this repo said that helper "becomes a no-op once verified — leave
the code". **That was wrong**, and it is worth knowing why, because the same
mistake is easy to repeat: the regex matched the *modern* format and converted it
*to* the legacy one, so it fired on every send to an Argentine number, and the
only manager on the system has one. Off the test tier there is no allow-list to
accept the legacy form, so keeping it would have addressed every reply to the
manager to a string that is not a valid wa_id. The helper is deleted. If a
**131030** ever appears again, it means something else entirely.

### Worker replies

Inbound senders are matched against `profiles.phone` first (the manager, full
agent loop) and then `workers.phone` (a worker). A worker's text **never**
reaches the model and is never persisted to `messages` — it is answered
deterministically. Three whole-message keyword families, in this order:

1. **`STOP` / `PARAR` / `BAJA` / `SAIR` / `CANCELAR` / `UNSUBSCRIBE`** → records
   `whatsapp_opt_out_at` and confirms. **`START` / `COMEÇAR` / `ALTA` /
   `SUBSCRIBE`** → records a fresh `whatsapp_opt_in_at`. A withdrawal that fails
   to save is **not** acked — an "you're unsubscribed" followed by tomorrow's
   briefing is worse than silence, and Meta redelivers the webhook on a non-200.
2. **`PT` / `ES` / `EN`** (or `português`/`español`/`english`) → switches
   `workers.language`.
3. Anything else → the canned ack.

All three match the **whole message**, never a substring: "stop, o Zé não vem
hoje" is a sentence, not a withdrawal of consent, and "es que não percebi" must
not be read as "switch to Spanish".

The opt-out ack is free-form text and that is legal — the worker's own message
opened the 24-hour window a moment earlier. It is also why opting out does not
suppress its own confirmation.

`workers.phone` has no unique constraint, so a number on two companies' crews is
logged as `whatsapp.worker_ambiguous` and answered with silence rather than a
guessed tenant.

A **check-in button tap** (§6b) is handled on this same path, in
`handleCheckinTap`, above the language check and below the ambiguity guard.
Three consequences of that placement, all deliberate:

- **A shared phone number can never check in.** The ambiguity guard returns
  first, so the tap is dropped in silence. Better than recording an answer
  against a guessed tenant, but invisible unless someone reads the logs.
- **A worker deactivated between the ask and their tap** no longer matches
  `.eq('active', true)`, so they become `whatsapp.unknown_sender` — total
  silence, by design, though it looks like the button is broken.
- **A malformed or unowned payload falls through to the ordinary ack** rather
  than to silence. Silence after a tap reads as "Capo is broken", and the ack
  also refreshes the 24h window.

The ack after a tap goes out in `workers.language ?? companies.language` — the
same locale the card itself was sent in.

## Limits & follow-ups (known, deliberate)

- **24-hour window**: the sink only replies to inbound messages, so it is
  always inside the window and free-form text is allowed. Interactive
  reply-button messages (the approval cards, below) are service messages too
  and are equally free-form inside the window — **no template needed**.
  Proactive sends (outside 24h) go through `sendWhatsAppTemplate` and the
  approved `capo_daily_briefing` template above.
- **Production limits and cost**: the business is verified and the number is
  live. A newly registered number starts on the **250 unique recipients / 24h**
  messaging tier and climbs with volume and quality rating — far above what a
  six-person crew needs. Sends are **billed**: about €0.04 per Portuguese
  utility template, so two sends a day to six workers is roughly €0.50/day.
  `NOTIFY_IDLE_WORKERS` in `/api/cron/reminders` is the dial that decides
  whether workers with nothing on today cost anything at all.
  (The old note here said graduating needed "no code changes". That turned out
  to be wrong twice over — see the Argentine wa_id note under "Phone formats"
  and the consent gate below.)
- **Retries/dedupe**: Meta redelivers on non-200 or timeout. The webhook acks
  fast (agent runs via `after()`), which makes duplicates rare; a
  provider-message-id dedupe store is a follow-up if duplicates are observed.
- **Voice notes are handled** (since the multilingual/audio change). `type:
  'audio'` — both push-to-talk voice notes (`audio.voice === true`) and
  uploaded audio files — is downloaded from the Graph media API, transcribed
  via `@capo/core/transcription`, and fed to the agent as plain text. See
  "Inbound media" below.
- **Images, documents, stickers and reactions** are still acked and ignored,
  but they now emit a `whatsapp.unsupported_message` log line with the message
  type. Previously they were dropped with no trace at all.
- **Button replies are handled** (see "Approval cards" below).
  `type: 'interactive'` with `interactive.type === 'button_reply'` resolves a
  proposal; other interactive subtypes (`list_reply`, `nfm_reply`) are acked
  and logged as `whatsapp.unsupported_interactive`.

## Approval cards (interactive reply buttons)

An approval card is a **tool output part**, not text. The sink used to flatten
the turn to `type === 'text'` parts, so every card was silently dropped — and
because the prompt forbids the model from restating a card in its own words,
the manager was told a card had appeared and handed nothing. Cards now travel
as native WhatsApp interactive reply buttons.

**No Meta dashboard change is required.** Button replies arrive on the
`messages` webhook field, which is already the only subscription (§2 step 3).

**Outbound** (`sendInteractive`, `packages/core/src/channels/whatsapp.ts`):

```json
{ "messaging_product": "whatsapp", "to": "<wa_id>", "type": "interactive",
  "interactive": { "type": "button", "body": { "text": "…" },
    "action": { "buttons": [
      { "type": "reply", "reply": { "id": "capo:approve:<uuid>", "title": "Aprovar" } },
      { "type": "reply", "reply": { "id": "capo:reject:<uuid>",  "title": "Rejeitar" } } ] } } }
```

Meta's limits, all clamped in code rather than trusted to a comment:

| field | limit | ours |
|---|---|---|
| `action.buttons` | 3 | we send 2 |
| `reply.title` | 20 chars, must be unique | clamped with `.slice()` |
| `reply.id` | 256 chars | ~52 |
| `interactive.body.text` | 1024 chars | clamped |
| `header` / `footer` | 60 chars, header is plain-text only | unused |
| plain `text.body` | 4096 chars | split at 4000 |

**Two strategies**, decided by `planAssistantMessages`:

- Card ≤ 1024 chars → a single interactive message whose body **is** the card.
- Card > 1024 (every real plan card) → the card goes as plain text
  message(s) first, then a short interactive carrying
  `Catalog.whatsapp.approvalPrompt` and the buttons.

`rendered_text` is sent **byte-identical** — never markdown-converted, never
reworded. It is the persisted approval artifact: `resolveProposal` embeds the
same string in the `role='event'` thread message, the web card renders it, and
the operator app reads the same column. What the manager approved and the audit
record of it must not differ. (Side benefit: a plan's `1. …` rows render as a
native WhatsApp numbered list precisely because nothing touches them.)

**Inbound**: `messages[].type === 'interactive'` with
`interactive.button_reply.{id,title}`. The button id is the *only* thing
carrying the decision — no model in the approval loop, and no outbound
message-id bookkeeping.

> ⚠ **Two different button shapes arrive on this webhook and they are easy to
> conflate.**
>
> `messages[].type === 'interactive'` with `interactive.button_reply.{id,title}`
> is an **approval card**, always from a MANAGER, resolved on the manager path
> above.
>
> `messages[].type === 'button'` with `button: { payload, text }` is a
> **template quick reply** — the late-afternoon check-in (§6b) — and only ever comes from
> a WORKER. It is handled in `handleWorkerReply` → `handleCheckinTap`, never on
> the manager path, where a `type: 'button'` still correctly falls to
> `whatsapp.unsupported_message`.
>
> The two codecs are deliberately non-overlapping: `parseProposalButtonId`
> rejects a check-in payload and `parseCheckinPayload` rejects a proposal id,
> both asserted in `scripts/whatsapp-check.mts`.
>
> (This note used to say the template shape was intentionally unhandled and to
> not "fix" it by adding it. That was true only while Capo sent no templates at
> all — it stopped being true when the 07:00 briefing shipped.)

**Tenant boundary.** `resolveProposal` runs on the **service-role** client
here, and `finalize_proposal` is `SECURITY DEFINER` scoped by

```sql
where id = p_id and (auth.uid() is null or company_id = private.current_company_id())
```

With the service role `auth.uid()` **is** null, so that predicate
short-circuits to true and enforces nothing. The route therefore reads
`proposals` filtered by `company_id` before resolving. That read is the only
tenant boundary on this path — do not remove it as redundant.

**Duplicate delivery** (Meta redelivers on non-200/timeout, and managers
double-tap) is safe: the compare-and-set in `resolveProposal` means the second
press is a no-op answering `proposalNotPending`.

**If the interactive send fails**, the manager gets
`Catalog.whatsapp.approvalFallback` as plain text — the proposal row exists and
is still resolvable in the web chat.

## Markdown → WhatsApp

Capo's persona and prompts are authored in markdown, so its prose comes out of
the model as markdown — and WhatsApp's bold delimiter is a **single** asterisk,
so `**Casa de Paco**` used to reach the manager with literal asterisks around
it. `toWhatsAppMarkdown` in
`packages/core/src/channels/whatsapp-markdown.ts` converts deterministically at
the channel edge (a prompt instruction would be unverifiable and one edit away
from regressing).

| markdown | WhatsApp |
|---|---|
| `**bold**`, `__bold__` | `*bold*` |
| `***both***`, `___both___` | `*_both_*` |
| `# Heading` … `###### ` | `*Heading*` (inner `*`/`_` stripped) |
| `[text](url)` | `text (url)` — bare URLs auto-link |
| `![alt](url)` | `alt (url)` |
| `* item`, `+ item` | `- item` |
| `---` / `***` rules | dropped |
| `` `code` ``, ```` ```block``` ```` | untouched (native) |
| `- item`, `1. item`, `> quote` | untouched (native) |

Documented non-goals: there is **no** single-`*` → `_` italic pass (it would
undo the bold pass it follows, and a literal asterisk is indistinguishable from
a markdown italic); `snake_case` renders italic and cannot be escaped (WhatsApp
has no escape character); markdown tables degrade to pipe rows.

Card text is exempt — see the previous section.

## Inbound media (voice notes)

`packages/core/src/channels/whatsapp-media.ts` — `downloadMedia(mediaId, config)`.
Four things that fail silently if you get them wrong:

1. **Two hops.** `GET {base}/{media-id}` returns metadata including a `url`;
   the bytes come from a second `GET` on that url.
2. **The CDN url also requires `Authorization: Bearer`.** A plain
   `fetch(url)` returns 401. An explicit `User-Agent` is set too — Meta's CDN
   400s on some defaults.
3. **The url is short-lived (~5 min) and effectively single-use.** It is
   consumed inside the same `after()` block and never persisted.
4. **MIME parameters must be stripped.** WhatsApp voice notes arrive as
   `audio/ogg; codecs=opus`; the AI SDK file part needs the bare `audio/ogg`.

`file_size` from hop 1 is checked against `MAX_AUDIO_BYTES` (15 MiB, shared
with the web mic path) before the download, and the downloaded length is
re-checked after.

On any failure — download, transcription, or an empty transcript — the manager
gets a canned apology in his own language (`Catalog.whatsapp.voiceNoteFailed` /
`voiceNoteEmpty`) sent directly via `sendWhatsAppText`. Silence on a voice note
reads as "Capo is broken", so this path must never no-op.

`export const maxDuration = 300` on the route: media download + Gemini
transcription now precede a 12-step agent loop and the outbound send, all
inside `after()`. The route previously declared none at all.
