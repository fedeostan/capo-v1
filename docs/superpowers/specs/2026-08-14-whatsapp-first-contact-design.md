# First contact on WhatsApp (issue #84)

**Date:** 2026-08-14
**Issue:** [#84](https://github.com/fedeostan/capo-v1/issues/84) — Onboarding
improvement: WhatsApp first message
**Migration:** none — this feature adds no columns and no policies
**New env var:** `WHATSAPP_BUSINESS_NUMBER` (added and deployed 2026-08-14)

---

## 1. What this is about, in plain language

A manager signs up to Capo today and never learns that Capo lives on WhatsApp.
The signup flow ends by asking them to add the app to their home screen, and
that is the last word on the subject. The WhatsApp channel — which is where
Capo is actually meant to be used, and where the crew already lives — is
discovered by accident or not at all.

After this change, signup gains one screen between *your details* and *install
the app*: **talk to Capo on WhatsApp**. On a phone it is a button that opens
WhatsApp with a message already typed. On a computer it is a QR code that does
the same thing when scanned. The manager sends the message, Capo answers, and
the screen — which has been quietly watching — confirms the message landed and
moves them along.

The reply itself is not new work. Capo already has a standing instruction
(`firstUse` in `packages/core/src/i18n/prompt-blocks.*.ts`) that fires whenever
a company has no jobs, no crew and no tasks: introduce yourself once, then walk
the manager through setup **one question at a time, never a full form** — first
job, then crew, then first tasks. A freshly signed-up company is by definition
in that state. The missing half was never the answer; it was the invitation.

## 2. The flow, before and after

| Step | Before | After |
|---|---|---|
| 1 | `/registar` — email + password | unchanged |
| 2 | `/onboarding` — company, name, phone, language | unchanged |
| 3 | — | **`/whatsapp` — send the first message** |
| 4 | `/instalar` — add to home screen | unchanged |
| 5 | `/` — the app | unchanged |

The new screen sits **after** the details form, and that ordering is
load-bearing rather than cosmetic. Capo identifies an inbound WhatsApp message
by matching the sender against `profiles.phone`; that row is created by
`complete_onboarding()` at step 2. A WhatsApp screen placed any earlier would
invite the manager to message a Capo that structurally cannot recognise them.

## 3. What the screen contains

1. **A permission tick-box**, pre-ticked: *"Send me a summary of the day at
   07:00 on WhatsApp"*, with a line noting it can be changed on `/perfil`.
2. **The action**, which depends on the device:
   - **mobile** — one button, *Open WhatsApp*, linking to the `wa.me` URL.
   - **desktop** — a QR code encoding the same URL, plus a smaller *Open
     WhatsApp Web* link beneath it as a fallback.
3. **A live status line**, which is the point of the whole screen:
   - waiting → *"Waiting for your message…"*
   - arrived → *"✅ Capo got your message"*. Polling stops, and after a **1.5 s
     beat** the screen replaces itself with `/instalar`. The beat exists so the
     confirmation is actually read; `router.replace`, not `push`, so the back
     button does not return them to a screen whose job is done.
   - 90 s of silence → *"Still nothing. Is `+351…` the number your WhatsApp
     runs on?"* with a link to `/perfil`, which is where the phone is edited
     (`apps/web/app/(app)/perfil/actions.ts:71`). Polling stops here too — a
     screen left open in a background tab must not poll forever.
4. **A skip link** — *do this later* → `/instalar`.

While `useFormFactor()` is still `'detecting'` (the server pass and the moment
before hydration), the screen renders **the link alone** — no QR. The link is
the branch that works on every device, so the pre-detection state is the safe
one, and a QR never flashes onto a phone that will not need it.

### The prefilled text

Chosen by Federico, 2026-08-14. Follows `profiles.language`, set one screen
earlier:

| Locale | Text |
|---|---|
| `pt-PT` | Olá Capo! Acabei de me registar. Ajudas-me a começar? |
| `es-ES` | ¡Hola Capo! Acabo de registrarme. ¿Me ayudas a empezar? |
| `en-US` | Hi Capo! I just signed up. Can you help me get started? |

It greets **and** states an intent. The greeting-only variant was considered and
rejected: it opens with small talk that Capo must answer before it can steer
towards setup, wasting the one turn where the manager's attention is highest.
The "name the first job" variant was rejected as presuming what the manager
wants to do first — it reads like a form, which is precisely what `firstUse`
exists to avoid.

WhatsApp always lets the sender edit a prefilled message before sending. This
text is an opening offer, not a submission.

## 4. How the confirmation works

### The signal already exists

`profiles.last_inbound_at` (migration `0030`) is stamped by the WhatsApp webhook
on **every** inbound manager message, on the service-role client, via
`stampLastInbound` in `apps/web/app/api/whatsapp/route.ts`. It was added for an
unrelated reason — deciding whether an outbound message to that person is free
or costs a paid template — but it answers this question exactly: *has this
manager ever written to us, and when.*

Reusing it means **no migration, no new column, and no second source of truth**
about the same event.

### Why a null stamp is honest evidence of failure

Only one thing writes that column: a webhook delivery whose sender Capo
successfully resolved to this profile. So the stamp appearing is proof of a
working round trip — the right number, reaching the right account. Its continued
absence after 90 seconds is the only evidence we can have that something is
wrong, and it is fair evidence: on a healthy path the stamp lands within a
second or two of the manager pressing send.

This is what replaces the identity-code scheme proposed during brainstorming and
rejected by Federico. We do not detect a *bad* number; we detect the *absence of
a good one*, and we say so out loud instead of leaving the manager in the
silence that is today's behaviour.

### The polling contract

A server action, `checkWhatsAppArrival(optIn: boolean)`, called from the client
every 3 s for at most 90 s. It runs on the **user-scoped client** (RLS), reads
`last_inbound_at` off the caller's own profile row, and returns
`{ arrived: boolean }`.

`arrived` is `last_inbound_at !== null` — "has this manager ever written to us",
not "since this page loaded". Deliberate: a manager who sends the message and
then reloads the page must not be told to send it again.

## 5. The permission tick-box

`whatsapp_opt_in_at` / `whatsapp_opt_out_at` on `profiles` are the recorded
consent that `hasWhatsAppConsent()` reads and that the 07:00 briefing
(`apps/web/app/api/cron/reminders/route.ts:474`) fails **closed** on. Migration
`0025` — re-granted by `0031` — already lets a manager write both columns on
their own row, and `/perfil` already does exactly this. **No schema work.**

**The write happens once, at the moment arrival is detected**, using the
tick-box's state at that moment. `checkWhatsAppArrival` is the one place it
happens, which is why the action takes `optIn` at all.

Tying the write to arrival rather than to page load or to the button tap is a
consent decision, not a convenience:

- **Not on page load.** A pre-ticked box that no one has looked at is not an
  act. Recording it would be manufacturing consent from a default.
- **Not on the button tap.** The tap exists only on the mobile path; the desktop
  QR path has no tap at all, so a tap-based rule would silently leave every
  desktop signup without a morning briefing.
- **On arrival** the manager has demonstrably opened a WhatsApp thread with
  Capo, from their own device, of their own accord. That is the strongest
  evidence available on this screen, and it is the same event for both devices.

A manager who leaves before the poll registers records nothing, and gets no
briefing until they tick the box on `/perfil`. That is the fail-closed direction
and matches `0025`'s posture throughout.

## 6. Files

### New

| Path | What |
|---|---|
| `apps/web/app/(public)/whatsapp/page.tsx` | Server component. Session gate, env read, wa.me URL, QR geometry. |
| `apps/web/app/(public)/whatsapp/handshake.tsx` | Client component. Device branch, tick-box, polling, status line. |
| `apps/web/app/(public)/whatsapp/actions.ts` | `checkWhatsAppArrival(optIn)`. |
| `apps/web/lib/whatsapp-handshake.ts` | **Pure**: build the `wa.me` URL from a number + text. No env, no network — so `pnpm whatsapp-check` can assert it. |
| `apps/web/lib/qr.ts` | Wraps `qrcode-generator` into `{ count, path }` — an SVG path string, not markup. |

### Modified

| Path | Change |
|---|---|
| `apps/web/app/(public)/onboarding/actions.ts` | Both success redirects `/instalar` → `/whatsapp`. |
| `apps/web/app/platform.ts` | Add `detectFormFactor()` / `useFormFactor()`, returning `'detecting' \| 'mobile' \| 'desktop'`. A **separate** function from `detectPlatform()`, which answers a different question (is this Apple, is this installed) and whose comment says so; folding a form-factor test into it would make one function answer two questions for two callers. |
| `packages/i18n/src/catalog.ts` + 3 dictionaries | New `whatsappHandshake` section. |
| `scripts/whatsapp-check.mts` | Assertions over the pure link builder. |
| `apps/web/package.json` | `qrcode-generator` ^2.0.4. |

### The dependency

`qrcode-generator` 2.0.4, MIT, **zero runtime dependencies**, ships its own
TypeScript definitions (`dist/qrcode.d.ts` — no `@types` package needed).
Verified against the public registry, 2026-08-14. Nothing in the repo can draw a
QR code today and hand-rolling a QR encoder is ~300 lines of bit-twiddling with
no test suite to catch a mistake.

It is used **on the server only**. `apps/web/lib/qr.ts` returns a plain SVG path
string and the client renders `<svg><path d={…}/></svg>`, so the encoder never
enters the browser bundle and no `dangerouslySetInnerHTML` is needed anywhere.

## 7. Invariants

- **The env var is read inside the request, never at module scope.** Repo rule
  (AGENTS.md): a module-scope read breaks `next build` in CI, where secrets are
  absent. `page.tsx` is `force-dynamic`.
- **A missing or unparseable `WHATSAPP_BUSINESS_NUMBER` skips the screen.** The
  page `logEvent`s and redirects to `/instalar`. A broken button on the last
  screen of signup is worse than no screen; a silent skip that leaves no trace
  is worse than both, hence the log line.
- **The screen is never mandatory.** A manager without WhatsApp on that device,
  or with a wrong number, must always be able to reach the app.
- **Route protection is inherited, not written.** `/whatsapp` is absent from
  `PUBLIC_PATHS` in `packages/db/src/proxy-session.ts`, so the proxy requires a
  session. The page additionally redirects `unauthenticated` → `/login` and
  `needs-onboarding` → `/onboarding`, because a profile row is a precondition
  for the whole screen, not merely for its polling.
- **The tenant boundary on the poll is RLS.** `checkWhatsAppArrival` uses
  `createUserClient()`, never `getDb()`. It reads and writes one row —
  the caller's own — under `profiles_select_own` / `profiles_update_own`.
- **`handleInbound` is not touched.** The reply is the existing agent, driven by
  the existing `firstUse` block. If this feature ever needs to change what Capo
  says, that is a signal the design went wrong.

## 8. Risks, stated plainly

### Migration `0030` — ✅ VERIFIED APPLIED IN PRODUCTION (2026-08-14)

This was the one thing that could have made the feature look broken while every
line of it was correct. The whole confirmation reads
`profiles.last_inbound_at`, added by `0030_last_inbound_at.sql`, and the
production migration ledger is known to have gaps — `0026` and `0027` were never
applied while `0028` was. Had `0030` been among them, `stampLastInbound` would
have been failing silently all along (it logs `whatsapp.last_inbound_stamp_failed`
and swallows), and **every manager would have seen the "still nothing" warning
even when their message arrived perfectly.**

Settled by Federico in the Supabase SQL editor against project `capo`, branch
`main`, PRODUCTION:

```sql
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'profiles'
   and column_name = 'last_inbound_at';
```

→ **1 row, `last_inbound_at`.** The column exists. The confirmation has a real
signal to read.

Checked against the live database rather than read off the migration file, per
the standing rule that prose about schema state goes stale silently. Note what
this does **not** prove: that the column is being *written*. Nothing has stamped
it unless a manager has actually WhatsApped Capo since `0030` landed. The first
end-to-end run of this screen is also the first honest test of that write.

### Device detection is a guess, and both guesses degrade to something usable

`useFormFactor()` is a heuristic (coarse pointer + touch points). A touchscreen
laptop misread as mobile still gets a working button — `wa.me` opens WhatsApp
Desktop or Web. A tablet misread as desktop gets a QR it cannot scan **plus**
the link underneath. Neither misdetection produces a dead end, which is why the
desktop branch carries a link at all rather than a QR alone.

### The 90-second threshold is a judgement call

Too short and a manager on a slow connection is told something is wrong when it
is not; too long and the screen wastes their time. 90 s is generous against a
real path that completes in ~2 s. The copy is a **question**, not an error —
*"Is `+351…` the number your WhatsApp runs on?"* — precisely because the
threshold can be wrong.

### Out of scope, deliberately

- **No claim code in the message.** Rejected by Federico. The consequence is
  that a manager whose typed phone differs from their real WhatsApp number is
  *told* rather than *repaired*; fixing the number stays a manual trip to
  `/perfil`.
- **No change to Capo's reply.** `firstUse` is verified, not edited.
- **No new WhatsApp template.** Every message on this path is the manager
  writing to us and Capo replying inside the 24-hour window their message opens.
  Nothing here is billable.
