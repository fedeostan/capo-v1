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

## Limits & follow-ups (known, deliberate)

- **24-hour window**: the sink only replies to inbound messages, so it is
  always inside the window and free-form text is allowed. Proactive sends
  (outside 24h) require an approved **template** — implement a template path
  only when a real need appears.
- **Test number limits**: 5 recipients, unverified business. Post-pilot:
  Meta **Business Verification** → register a production number → higher
  messaging tier. No code changes needed.
- **Retries/dedupe**: Meta redelivers on non-200 or timeout. The webhook acks
  fast (agent runs via `after()`), which makes duplicates rare; a
  provider-message-id dedupe store is a follow-up if duplicates are observed.
- **Non-text messages** (voice notes, images) are acked and ignored for now.
  Voice notes are the obvious next step (transcription already exists in the
  web app).
