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
4. Ask for something Capo will propose (e.g. "cria a obra Casa do Paco na Rua
   5"). Expect the approval card as a message with two tappable buttons; tap
   **Aprovar**; expect the confirmation reply and the row on the Tarefas
   board. `whatsapp.button_reply` then `whatsapp.proposal_resolved` in the
   logs.

## Limits & follow-ups (known, deliberate)

- **24-hour window**: the sink only replies to inbound messages, so it is
  always inside the window and free-form text is allowed. Interactive
  reply-button messages (the approval cards, below) are service messages too
  and are equally free-form inside the window — **no template needed**.
  Proactive sends (outside 24h) require an approved **template** — implement a
  template path only when a real need appears.
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

> ⚠ `messages[].type === 'button'` with `button: { payload, text }` is the
> **template** quick-reply shape. We send no templates; it is intentionally
> not handled. Do not "fix" the handler by adding it.

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
