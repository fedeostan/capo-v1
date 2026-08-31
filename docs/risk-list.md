# Risk list — the ways Capo can fail silently, ranked by what silence costs

A **silent failure** is one that produces no error, no crash and no red light
anywhere — the product simply behaves wrongly, or stops doing something, and
the only way to find out is to notice the absence. Capo is unusually exposed
to this class of failure because so much of it is *proactive*: messages that
go out on a clock, decisions recorded in the background, walls between
companies that hold invisibly. When a screen breaks, someone sees it within
the hour. When a 07:00 message stops going out, the first symptom is a crew
member quietly deciding Capo is dead.

This list is ranked by **silent-failure cost**: roughly, *how long the
failure would go unnoticed* multiplied by *who it hurts while it lasts*. That
is deliberately not the same as how likely each one is. A rare failure that
runs for weeks and hurts a paying customer outranks a common one that a
manager spots in a minute.

Each entry says what guards it **today**, honestly — including "nothing" and
"a person remembering", because those are the entries this list exists for.

---

## Part 1 — Five silent failures that actually happened

These are not hypotheticals. Each one ran in production for hours to weeks
with no error anywhere. They calibrate the ranking below: when an entry says
"this class has burned us", it points here.

| # | What happened | How long it was silent | The lesson |
|---|---|---|---|
| H1 | **The cron drifted 49 minutes** (2026-08-13). The scheduled tasks that send the daily messages fired late, and the code only accepted the exact hour — 11 more minutes of drift and BOTH daily WhatsApp sends would have been skipped, answering "success" with nothing sent, no record, no error. | Caught with 11 minutes of margin left | A schedule can be healthy in the code and dead in the world. The fix (a 2-hour acceptance window + a run log) reduced the cliff; it did not remove it. |
| H2 | **A migration sat merged and unapplied for three weeks** (0038). The code half of a feature deployed itself; the database half needed a hand and never got one. A paused obra simply vanished from the Obras screen — no row, no badge, no error. Earlier, two other migrations (0026/0027) were skipped the same way. | ~3 weeks | A skipped migration presents as a feature quietly not working, never as an error. `pnpm migration-check` now exists to ask — but a person must run it. |
| H3 | **The morning briefing failed every single day for one language.** The WhatsApp template (pre-approved message wording) existed only in Portuguese; every 07:00 send to the English-speaking manager failed with "template does not exist in en_US" — recorded in a table nobody reads, surfaced nowhere. | Daily, until someone read the ledger | Configuration living OUTSIDE the repo (Meta's template approvals) can fail per-language, per-template, silently. No code review can see it. |
| H4 | **The AI provider ran out of credit and Capo just went quiet on WhatsApp.** Messages kept arriving and being stored; every model call failed; the sender got nothing and no one was told. The tell: the incoming-messages table kept growing while the cost ledger stopped. | Until a human noticed the silence | The product's most important dependency (the model) can fail in a way only visible as a *gap between two tables*. |
| H5 | **Stripe webhook deliveries were failing 100%** because the endpoint was the bare domain, which answers with a redirect — and Stripe counts ANY redirect as failure. Since the webhook is the only thing that marks a customer as paid, every paying customer would have stayed "trialing" and been locked out when their trial expired. | Until the cutover audit found it | Payment truth lives in a third party's delivery log. Our own codebase contains no error for this at all. |

Common thread: **three of the five lived in configuration outside the repo**
(Meta, Supabase, Stripe). No amount of testing the code would have caught
H2, H3 or H5.

---

## Part 2 — The ranked list

### 1. One company sees another company's data

- **What it looks like:** a manager's board, chat, photos or briefing carries
  a name, task or obra belonging to a different company. Or — worse, because
  it is invisible — a technically-minded stranger can *query* another
  company's data without any screen showing it.
- **Why it is silent:** the victim cannot see their data being read. The only
  visible form is the accidental one (wrong name on a screen); the deliberate
  form has no symptom at all, ever.
- **Cost:** unbounded duration × every customer at once. Existential — this
  is the failure that ends the product's credibility in one screenshot.
- **Guarded today by:** the database's row-level security ("RLS" — rules
  inside the database itself that decide, per row, who may see it; the walls
  hold even if the app code is wrong), plus `pnpm rls-matrix`, a script that
  actively attacks those walls from a second tenant. **But that script needs
  credentials, so it does not run automatically — it runs when a person
  remembers.** Every change to database rules is supposed to be followed by a
  run; nothing enforces that.
- **Check right now:** run `pnpm rls-matrix` (needs the service keys). Green
  means every attack was refused *and* the owner's own access still works.

### 2. A paying customer is locked out because Stripe never told us they paid

- **What it looks like:** the customer paid; Stripe shows an active
  subscription; Capo still says "trialing"; on trial-end day the app locks
  them out. They experience paying and then being thrown out.
- **Why it is silent:** the webhook (Stripe's automated call to our server)
  is the *only* writer of the paid status. A failing delivery raises no error
  in our code — the failure log lives in Stripe's dashboard. This is H5, and
  it was real.
- **Cost:** days-to-weeks × paying customers, at the exact moment they
  chose to pay. The most expensive per-person failure on the list.
- **Guarded today by:** `pnpm billing-check` covers the trial-date
  arithmetic only. Delivery itself: nothing automated. The webhook handler
  logs `billing.company_not_found` / `billing.subscription_orphan` when a
  delivery matches no company — greppable, read by nobody on a schedule.
- **Check right now:** Stripe dashboard → the webhook endpoint → recent
  deliveries, all 2xx. In the app: does a just-paid account show active?

### 3. The 07:00 briefing (or 16:00 check-in) stops going out

- **What it looks like:** the crew hears nothing in the morning. No error —
  the send either never ran, ran outside its window and skipped, was refused
  per-recipient (H3's missing template language), or excluded everyone
  (missing consent — which once meant *zero* crew members were eligible and
  it looked like a code bug).
- **Why it is silent:** a skipped window answers "success, skipped"; a
  per-recipient refusal writes a row in a ledger nobody reads; an exclusion
  is working-as-designed. H1 + H3 both happened.
- **Cost:** days × every crew member — and it erodes the core habit the
  product is built on. The manager usually finds out from a worker's shrug.
- **Guarded today by:** `pnpm scheduler-check` (the window/clock arithmetic,
  in CI), the `cron_runs` run log with its due-hour vs ran-hour columns and
  exclusion counts (visible on Perfil → Automações), and the idempotency
  lock that prevents the double-send version. The remaining silent shapes:
  Vercel simply not invoking the route, and per-recipient template failures.
- **Check right now:** Perfil → Automações shows the last runs; the
  `cron_runs` table answers "did it run, when, and who was excluded".

### 4. Capo acts on something it should only have asked about

- **What it looks like:** the manager muses "maybe we should cancel that
  obra" and the obra is cancelled — no card, no confirmation. Or the inverse
  decay: every direct order silently degrades into a card (pure friction, and
  the documented failure mode if the model ever translates the quote it
  authorizes against).
- **Why it is silent:** both directions produce zero errors. Acting-without
  -asking looks like obedience; asking-always looks like caution. Only a
  human comparing behaviour to the setting notices.
- **Cost:** hours-to-days × one company's live schedule and crew messages —
  wrong dates reach real workers' phones at 07:00. Trust in the assistant, once
  lost here, does not come back.
- **Guarded today by:** the default posture (ask always, a database column
  every manager starts with), `pnpm guard-check` in CI over the whole
  decision matrix, and the structural rule that the destructive appliers are
  reachable only through an approved card. The watch item: pending proposals
  accumulating (nothing expires them — a known gap).
- **Check right now:** QA tests CHAT-2..5; count `proposals` stuck at
  `pending`.

### 5. A completion claim is lost between worker and manager

- **What it looks like:** the worker tapped "Sim, terminei" and believes the
  job is reported; the board still says pending; the manager, and Capo, agree
  with the board. Three parties, three beliefs, nothing recording the
  disagreement — this exact state was the product's founding bug (#54).
- **Why it is silent:** each party's view is locally consistent. Only holding
  two phones side by side reveals it.
- **Cost:** days × worker trust — a crew that learns the button does nothing
  stops tapping it, permanently, and the manager reads that as laziness.
- **Guarded today by:** structure — the tap now files a claim per task, the
  board keeps a claimed task visible (a denylist, so it cannot vanish), the
  inbox + push + thread note all fire from database triggers rather than app
  code. `pnpm whatsapp-check` pins the tap-handling arithmetic. No automated
  check walks the full journey phone-to-phone.
- **Check right now:** QA CHECKIN-2 then APPR-1 — one claim, three surfaces,
  all agreeing.

### 6. A worker's words reach the manager's AI as if the manager had said them

- **What it looks like:** nothing, until it is exploited: a crew member's
  message becomes "evidence" the assistant is allowed to act on — the
  escalation from "worker can text" to "worker can authorize manager-level
  writes".
- **Why it is silent:** the failure is an *architecture* eroding, not an
  event. One convenience feature copying worker text into the wrong table
  would open it with no visible symptom.
- **Cost:** unbounded × the manager's authority. Ranked below #1 only because
  exploiting it takes intent and knowledge.
- **Guarded today by:** separate tables for worker conversations (the unsafe
  query does not exist to write), a worker toolset separated at the type
  level, and `checkWorkerTextIsolation` inside `pnpm rls-matrix` — which
  sweeps for a planted tracer, but again only runs when a person remembers.
- **Check right now:** `pnpm rls-matrix`; QA FAIL-3.

### 7. Model calls fail and WhatsApp just goes quiet

- **What it looks like:** workers and the manager write to Capo on WhatsApp
  and get nothing back. Web chat may error visibly; WhatsApp does not. H4 —
  the credit ran out and only table-watching found it.
- **Why it is silent:** the webhook stores the inbound message, calls the
  model, fails, and has nobody to tell. The sender sees blue ticks (their
  message *was* read) and then silence.
- **Cost:** hours-to-days × every WhatsApp user — and it reads as the product
  being dead rather than broken.
- **Guarded today by:** nothing automated. The diagnostic is a gap between
  two tables: `messages` growing while `ai_usage` (the cost ledger, written
  on every model call) stays flat.
- **Check right now:** operator Cost tab against message volume; check the
  provider account's credit balance.

### 8. A merged migration never reaches the live database

- **What it looks like:** a feature that shipped simply does not work — or
  worse, half-works, code reading columns that exist and skipping rules that
  do not. H2, twice.
- **Why it is silent:** deploying code is automatic; applying a migration is
  a human step. Nothing fails when the second half is skipped — the code was
  deliberately written to degrade rather than error when a column is missing.
- **Cost:** weeks × whichever feature it was — and if the skipped migration
  is a *security* rule, this silently becomes risk #1.
- **Guarded today by:** `pnpm migration-check` compares the repo against the
  live database's applied history — but it needs an access token, so it is a
  manual, after-deploy ritual, not a gate.
- **Check right now:** `pnpm migration-check` after any deploy that carried a
  migration.

### 9. The background ledgers quietly stop filling up

- **What it looks like:** nothing — that is the point. By design, a dozen
  background writes *swallow* their own failures so they can never break the
  user-facing action they ride on: the cost ledger, the thread event notes,
  the run log, the day-link minting, the Home widgets, the delivery statuses.
  Each failure is one greppable log line (`ai_usage.write_failed`,
  `thread.event_failed`, `schedule.read_failed`, `day_link.mint_failed`,
  `home.*_failed`, `billing.company_not_found`…).
- **Why it is silent:** deliberately. The design trades visibility for
  resilience — correctly — but the debt is that a revoked permission or a
  schema mismatch presents as a table that stops growing.
- **Cost:** weeks × our own ability to answer questions — every one of these
  ledgers exists to make some *other* silent failure diagnosable, so losing
  one quietly removes a smoke detector.
- **Guarded today by:** the convention that every swallow logs one named
  event. Nobody and nothing reads those logs on a schedule.
- **Check right now:** grep the deploy logs for the event names above before
  concluding any quiet table means quiet traffic.

### 10. A stored phone number stops matching WhatsApp

- **What it looks like:** one person's messages to Capo stop being
  recognised — treated as a stranger, which by design means total silence,
  not even read receipts. The known trigger: re-saving a number in a format
  WhatsApp does not use (an Argentine number without its extra `9`). Same
  family: a person's WhatsApp identity rotating when they change numbers,
  which arrives as an easy-to-drop notification.
- **Why it is silent:** unknown senders get silence *on purpose* (a reply
  would confirm a live system to strangers), so the safety feature masks the
  data bug perfectly.
- **Cost:** days × one person — but that person concludes Capo is broken and
  says so to the others.
- **Guarded today by:** `pnpm whatsapp-check` pins the identity-resolution
  order; the rotation path logs an orphan event when it matches nobody.
  Number *format* on entry: nothing.
- **Check right now:** if a specific person gets silence, compare their
  stored number character-by-character with their WhatsApp profile.

### 11. Push notifications die per-device

- **What it looks like:** a manager who used to get banners stops getting
  them — permission was one-shot and denied, the home-screen install was
  removed (iOS requires it), or the registration died. They notice days
  later, as "I missed a claim".
- **Why it is silent:** push has no delivery receipt the user sees, and the
  inbox still fills up correctly — the difference is only *promptness*.
- **Cost:** days × per manager, degrading the "Capo tells me when it
  matters" promise. Lowest on this list because the inbox is a working
  fallback.
- **Guarded today by:** `pnpm push-check` (the retry/cleanup rules), the
  10-minute sweep (a forgotten immediate send costs lateness, not silence),
  and the Perfil card that enumerates every device state instead of showing a
  dead button.
- **Check right now:** QA SHELL-3 on a real phone.

---

## Part 3 — How to read this list

Three patterns worth noticing, because they say where the next testing money
should go (that argument is made properly in
`docs/test-automation-proposal.md`):

1. **The two most serious risks (#1, #6) have strong tests that nobody is
   forced to run.** The gap is not test-writing, it is *scheduling*.
2. **The risks that actually burned us (#2, #3, #7, #8) live mostly in
   configuration and third parties** — Meta approvals, Stripe delivery,
   applied migrations, provider credit. They are invisible to any test of the
   code, and visible to a daily question asked of production.
3. **The middle of the list is guarded by structure** (triggers, denylists,
   separate tables, type-level walls) **plus pure-function checks in CI.**
   That combination has held well; the QA script exists to walk the journeys
   that connect the structures.
