# WhatsApp manager channel — Meta Cloud API runbook

One-time, manual operator setup for the WhatsApp channel
(`apps/web/app/api/whatsapp/route.ts`). Everything here happens in Meta's
dashboards; the code is already deployed and waits on the four env vars at the
end.

Model: **one shared business number for everyone.** Senders are identified by
phone (`profiles.phone`, unique E.164) → `company_id` → that company's
perpetual thread with `channel='whatsapp'`. Unknown numbers are silently
ignored.

## 1. Meta app + WhatsApp product

1. https://developers.facebook.com → **Create App** → type *Business*.
2. Add the **WhatsApp** product to the app.
3. On the WhatsApp → API Setup page you get:
   - a free **test number** (this is the pilot's shared Capo number),
   - its **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`,
   - the **WhatsApp Business Account ID** (note it down),
   - a *temporary* access token — ignore it; see step 3.
4. **Add test recipients** (up to 5): WhatsApp → API Setup → "To" → manage
   phone number list. Every pilot manager's phone must be added here and must
   confirm the opt-in code on their WhatsApp. Their number must equal
   `profiles.phone` (same E.164 digits).

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
3. System user → **Generate token**:
   - App: the Meta app.
   - Expiration: **Never**.
   - Scopes: `whatsapp_business_messaging` + `whatsapp_business_management`.
4. The generated token → `WHATSAPP_ACCESS_TOKEN`. It is shown once — store it
   in the env vars and nowhere else.
5. App secret: developers.facebook.com → the app → App settings → Basic →
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

1. From a registered test recipient's WhatsApp, message the test number
   (e.g. "que tarefas tenho hoje?").
2. Expect: agent reply from the shared number within ~10–30s; the exchange
   appears in that company's thread (operator app → Conversations) with
   `channel='whatsapp'`.
3. From a phone NOT in `profiles.phone`: expect no reply, nothing persisted
   (check the operator app), and a `whatsapp: inbound from unknown number`
   line in the Vercel function logs.

## 6. Message template — `capo_daily_briefing`

Needed by the 07:00 reminder cron (`apps/web/app/api/cron/reminders`), which
messages workers who have never written to Capo and so is always outside the
24-hour window.

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

Four things that fail silently or confusingly:

- **A template does NOT open the 24-hour window.** Only the recipient's reply
  does. Until a worker replies, every briefing is a paid template send — which
  is why the webhook acknowledges worker replies (`handleWorkerReply`): the ack
  is what converts them into free session messages.
- **Parameters may not contain newlines, tabs, or runs of 4+ spaces.** Meta
  rejects the whole send with **132000**. `toTemplateParam()` in
  `packages/core/src/channels/whatsapp.ts` flattens whitespace for exactly this
  reason; never bypass it.
- **Changing the parameter count means re-submitting the template.** Body
  params are positional and validated on send.
- **Task titles inside the message are NOT translated.** They are stored in
  `companies.language` and nothing retranslates existing rows, so a worker on
  `es-ES` gets a Spanish sentence around Portuguese titles. Deliberate.

### Worker replies

Inbound senders are matched against `profiles.phone` first (the manager, full
agent loop) and then `workers.phone` (a worker). A worker's text **never**
reaches the model and is never persisted to `messages` — it is answered
deterministically: a lone `PT`/`ES`/`EN` (or `português`/`español`/`english`)
switches `workers.language`, anything else gets a canned ack. `workers.phone`
has no unique constraint, so a number on two companies' crews is logged as
`whatsapp.worker_ambiguous` and answered with silence rather than a guessed
tenant.

## Limits & follow-ups (known, deliberate)

- **24-hour window**: the sink only replies to inbound messages, so it is
  always inside the window and free-form text is allowed. Proactive sends
  (outside 24h) go through `sendWhatsAppTemplate` and the approved template
  above.
- **Test number limits**: 5 recipients, unverified business. Post-pilot:
  Meta **Business Verification** → register a production number → higher
  messaging tier. No code changes needed.
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
