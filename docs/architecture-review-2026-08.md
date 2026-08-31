# Architecture review — August 2026

*Written for issue #110. This is a survey, not a refactor proposal. It answers six
questions: what the system is, where its load-bearing walls are, where it is
fragile, what it costs to run, what would break first as it grows, and what is
worth doing about any of that.*

*Everything in here was checked against the actual code, the actual database
rules, and the actual live data — not just against what `AGENTS.md` (the
project's accumulated design notebook) says. Where the notebook and the code
disagree, that disagreement is recorded as a finding, because the whole premise
of this review is that prose goes stale and code does not.*

*Terms are explained the first time they appear. Company names from the live
database are anonymised — "Company B", "the pilot tenant" — and no phone
numbers, message contents, or secrets appear anywhere in this document.*

---

## 1. What the system actually is

### The one-paragraph version

Capo is a WhatsApp-first assistant for small Portuguese construction companies.
A manager talks to it — by chat in a web app or by WhatsApp message — and it
keeps the company's obras, tarefas and crew organised in a database. Every
morning at 07:00 it messages each crew member their day's work on WhatsApp;
every late afternoon it asks whether they finished; and the crew can talk back
to a second, deliberately limited assistant. Everything the assistant wants to
*change* on the manager's behalf normally becomes an approval card the manager
taps, rather than a silent action.

### The pieces

**Two web applications, one database.**

- **The tenant app** (`apps/web`, at construcapo.com) is what managers use:
  the chat, the task board, the obras screen, materials, the team screen,
  settings. It is also where every WhatsApp message physically arrives, because
  it hosts the *webhook* — an address Meta calls whenever someone messages the
  business number.
- **The operator app** (`apps/operator`) is an internal mission-control screen
  for the person running the business (Federico). It can see across all
  companies — signups, conversations, and a cost dashboard. It is deployed
  separately and must never be reachable by customers.

Both talk to **one shared Supabase database** (Supabase is a hosted Postgres —
an industrial-strength database — plus login handling and file storage). Every
company's data lives in the same tables, separated not by app code but by rules
inside the database itself (section 2).

The database's shape is changed only by **migrations** — numbered instruction
files (`supabase/migrations/0001` through `0039`), each applied once to the
live database and never edited afterwards. Think of them as a build log: you
can reconstruct the whole building by replaying the log, and you never rewrite
an old page of it.

**Two AI assistants, deliberately separate.**

- **The manager's agent** is the full Capo: it can read everything in the
  company and propose or make changes through roughly two dozen tools (a tool
  is a single well-defined action the model may request — "create a task",
  "list workers").
- **The worker's agent** is a second, much smaller assistant with exactly four
  tools: see my tasks, search the knowledge base, declare a task finished
  (photo required), and set my language. It cannot create approval cards,
  cannot touch anyone else's tasks, and its conversations are stored in
  entirely different tables from the manager's.

The separation is not a setting — it is enforced by the programming language's
type checker, so mixing the two is a build error, not a runtime surprise.
Section 2 explains why this matters so much.

**Three proactive WhatsApp sends.** "Proactive" means Capo speaks first, which
under Meta's rules requires a pre-approved *template* (a fixed message shape
Meta has reviewed) and costs money per delivery — unlike replies inside the
24-hour window a person's own message opens, which are free.

| Send | When | Who gets it |
|---|---|---|
| Morning briefing | 07:00 Lisbon (per-company adjustable) | Everyone on today's tasks, plus managers |
| Afternoon check-in | 16:00 Lisbon (adjustable) | Only the *lead* on each task — "did you finish?" with two tap buttons |
| Welcome | Once ever, 09:00–19:59 | Anyone newly allowed to be messaged — confirms consent and states how to opt out |

Nobody is messaged without a recorded opt-in, and a database rule (a *unique
constraint* — the database refusing a second identical row) makes it physically
impossible to send the same person the same daily message twice in one day.

**Five scheduled jobs.** A *cron* is a timer that calls a web address on a
schedule. Vercel (the hosting platform) fires five of them at the tenant app:

| Job | Schedule | What it does |
|---|---|---|
| `/api/cron/reminders` | every hour | Morning briefing, when a company's chosen hour comes up |
| `/api/cron/checkin` | every hour | Afternoon check-in, same pattern |
| `/api/cron/push` | every 10 min | Delivers in-app notification badges to phones (web push) |
| `/api/cron/welcome` | every 15 min | Sweeps for people who may now legally be welcomed |
| `/api/cron/consolidate` | every hour (acts 02:00–04:59) | The nightly memory review — a model reads the day's manager conversation and writes at most five durable "memories" |

The hourly heartbeat looks wasteful but is deliberate: Vercel's timers drift by
up to ~49 measured minutes, and the send hour is now per-company data, so each
route wakes hourly, asks "is it anyone's hour?", and exits cheaply if not.

**How a worker's message physically travels.** The full round trip, because it
is the least obvious part:

1. A crew member sends a WhatsApp message to Capo's one business number.
2. Meta's servers call the webhook address in `apps/web` with the message in
   the request body, signed so forgeries can be detected.
3. The route verifies the signature, then works out *who is talking* — four
   lookups against the database, phone number first, then WhatsApp's internal
   user ID as a fallback. If the number matches crews in two different
   companies, Capo deliberately stays silent rather than guess.
4. It immediately answers Meta "received" (so Meta does not re-deliver), and
   does the real work afterwards in a deferred step.
5. Cheap deterministic answers go first, with no AI involved at all: language
   keywords ("ES"), menu taps, check-in button taps.
6. Only if nothing deterministic matched does the *worker agent* run — up to
   six model steps — reading only that worker's own tasks.
7. The reply is sent back through Meta to the worker's phone; the turn is
   recorded in the worker-only conversation tables; a token-count row lands in
   the cost ledger.

The manager's path is the same shape with a bigger agent (up to twelve model
steps), and with one extra rule at the end: anything that writes normally comes
back as an approval card, not as an action.

**Billing.** Stripe (the payments provider) charges €45/month after a 14-day
trial that lives in Capo's database and is handed to Stripe at checkout. A
Stripe *webhook* — same idea as Meta's, Stripe calling us — is the only thing
that can flip a company's subscription status, because the tenants' own right
to edit that column was revoked at the database level.

### Where this lives (for reference, skippable)

`apps/web` and `apps/operator` (the two apps) · `packages/core` (both agents,
tools, WhatsApp channel) · `packages/db` (database clients) · `packages/i18n`
(user-facing copy in PT/ES/EN) · `supabase/migrations/0001–0039` (the database
build log) · `apps/web/app/api/whatsapp/route.ts` (the webhook) ·
`apps/web/app/api/cron/*` (the five jobs) · `apps/web/vercel.json` (their
schedules).

---

## 2. Where the load-bearing walls are

A load-bearing wall here means: a place where a wrong change does not crash —
it *quietly* does the wrong thing, possibly for weeks. Each wall below was
verified against the live code and migrations, not just against the notebook.

### Wall 1 — The company boundary (verified)

**What it protects:** one construction company must never see another's obras,
tasks, crew, photos, or messages.

**How it actually works:** Row-Level Security (*RLS*) — rules attached to each
database table saying which rows a logged-in person may see or touch. Every
tenant table's rules boil down to "your company's rows only", where "your
company" is derived from your login inside the database itself
(`current_company_id()`), out of reach of app code. The app has two database
identities: a *service role* key that bypasses RLS (allowed only in system
code — crons, webhooks) and a per-user client that is always subject to it.
The rule "RLS is the boundary, never app code or prompts" holds everywhere a
user is logged in.

**The verified exceptions** — places where RLS is *not* the boundary, each
with its own wall:

- A handful of database functions run with elevated rights (*SECURITY
  DEFINER* — the function acts as its owner, not the caller), so their own
  internal company check is the entire boundary. All five in production are
  safe against the historical trap: the 0015-era bug used the SQL comparison
  `<>`, which silently answers "unknown" (not "different") when one side is
  missing, letting a person with no company slip through. Every live function
  now uses the null-safe comparison or checks for a missing login first.
- On the WhatsApp path there is no login at all (Meta is the caller), so
  three boundaries are TypeScript code rather than database rules: the guided
  menu's task lookup, the worker agent's task scope, and the filter keeping a
  colleague's private memories out of a manager's prompt. Each is attacked by
  the isolation test suite — except the memory filter, see the finding below.

**The proof:** `scripts/rls-isolation-matrix.mjs` — 2,878 lines of adversarial
tests that seed two throwaway companies plus a colleague and an orphan, then
try every cross-tenant read, write, forgery and escalation the team has thought
of, including against the file-storage layer and the elevated functions. It is
real and thorough. Its two structural limits are honestly stated in the file:
it proves *refusals* (a database that denied everyone would pass), and it needs
live credentials, so it runs only when a human remembers to run it — never
automatically (section 3, item 1).

### Wall 2 — Manager AI vs worker AI (verified)

**What it protects:** a crew member's words must never become evidence the
manager's agent trusts. The specific escalation: the manager's agent may
execute a write *directly* when it can quote the manager's own recent words
back; those "recent words" are read from the `messages` table; so anyone who
could write a row into `messages` would not be persuading the AI — they would
be forging its authorisation evidence.

**How it actually works:** separate tables, not a filter. Worker conversations
live in `worker_conversations`/`worker_messages`; the query that could leak
simply does not exist. On top of that, the two agents' *context types* (the
bundle of facts a tool receives) are mutually incompatible — each requires
fields the other lacks (five in one direction, six in the other) — so a worker
tool physically cannot call the functions that create approval cards or
manager-level writes; the build fails. The worker's "declare task done"
requires at least one photo at the input-schema level, not as a prompt
instruction — because a prompt rule is negotiable by exactly the person on the
other end. And the nightly memory review reads only `messages`; there is no
code path from a worker's words into long-term memory. All verified in code.

### Wall 3 — The approval-card rule (verified)

**What it protects:** Capo *asks* before changing things. Two mechanisms stack:

1. **Posture.** Every manager defaults to `always_ask`: every guarded write
   becomes a card, and the model's quote of the manager is not even consulted.
   The older `trust_quote` behaviour (execute directly when the model can
   quote the manager verbatim from the last three *user* messages) survives as
   an opt-in. The decision function is three lines of pure code, and a CI
   check (`guard-check` — CI being the robot that runs checks on every code
   change) exercises the entire matrix, including that system-written "event"
   rows in the thread can never count as the manager's words.
2. **Absent appliers.** The four irreversible actions — apply a plan, apply a
   bulk translation, apply a schedule cascade, pause an obra and clear its
   dates — are not in the model's toolbox at all. The model can only *propose*
   them; the applier is reachable solely through an approved card. This
   matters because a guarded tool in the roster executes directly whenever the
   model can quote the manager — and for "traduz tudo" or "pausa a obra" it
   always can.

**One gap found:** nothing in CI asserts that those four appliers *stay* out of
the toolbox. The rule holds today because nobody has written the import; a
future session adding a tool file could wire one in and no check would fire.
Same for the service-role/user-client split — it is a convention with no
automated gate. Both are cheap to close (section 6).

### Wall 4 — The one-send-per-day locks (verified)

**What it protects:** nobody gets the same paid message twice, even though
every send route deliberately runs more than once per window (the hourly
heartbeat puts two ticks inside every two-hour send window, by design).

**How it actually works:** the send ledger `notification_log` carries a
uniqueness rule — one row per person, per message kind, per day — and every
send *claims* its row before talking to Meta. A second tick's claim collides,
the database answers with error code 23505 ("already exists"), and the code
treats that as "not mine to send", silently and correctly. The welcome has the
same lock minus the date (once ever). The hour gate is a two-hour window that
never wraps past midnight (wrapping would roll the date over and make the lock
see a fresh day — the one bug that would double-message everyone). All
verified, including the check that the schedule file keeps every entry at
minute `:00` — a `:30` entry once shipped and never sent a single message,
because timer drift pushed it past the hour gate.

### Wall 5 — Two lines of SQL in the review function (verified)

**What it protects:** every approval, rejection or dismissal of a completion
claim. When a worker says "finished", the task enters a waiting state; the
manager's decision runs through one database function that must update the
review row *first* and the task row *second*. A trigger (code the database
runs automatically after certain changes) watches tasks leaving the waiting
state and marks any still-open review "superseded" — that trigger fires on the
function's own second statement too, and only stays harmless because the first
statement has already moved the review out of "pending". **Reorder the two
statements and every legitimate decision overwrites itself as "superseded",
silently, while reporting success.** Verified in the SQL: the order is correct,
and a loud comment sits between the two statements saying exactly this.

### Findings: where the notebook and the code disagree

The audit's premise was that prose-only knowledge is a trap. Seven
disagreements were found. None is a live vulnerability; three are worth fixing
because in this project the prose *is* an operating instruction for future AI
sessions, and wrong prose gets faithfully obeyed.

1. **The null-guard rationale is stated wrongly in three places** —
   `AGENTS.md` (the send-history section), a comment in migration 0036, and a
   comment in the isolation matrix. All three attach the historical "fails
   open" bug to the *shape* `if auth.uid() is not null and <company check>`,
   and two of them literally quote the safe null-proof comparison while
   claiming it is exploitable. The actual 0021 bug was the `<>` comparison,
   not the shape. The live functions are safe; the danger is a future session
   "fixing" a safe guard, or writing a new function to the wrong rule.
2. **`AGENTS.md` contradicts itself about the cron schedules** — one paragraph
   still describes "three UTC Vercel Cron entries targeting 07:00" (the
   pre-#51 design, with the hour as a constant); seventy lines later it
   correctly describes the hourly heartbeat with the hour as per-company data.
   The stale half is the kind of sentence a future session would code against.
3. **The deny-all inventory is undercounted** — the notebook says the
   isolation matrix deny-all-checks "the two send ledgers"; it actually covers
   five locked-down tables, including `worker_day_links`, whose rows are live
   bearer credentials (the most safety-critical of the five) and which the
   bullet never mentions.
4. **Migration history is misdescribed at its own sites** — 0018 as committed
   already contains the fixes the notebook attributes to 0019 (they were
   folded in place — the one documented exception to "never edit a
   migration"), and comments in 0019/0020 cite "0017" where they mean 0018,
   residue of two work streams landing out of order on one day.
5. **No automated gate on two structural rules** — absent-from-roster
   appliers, and the service-role/user-client split (described under Wall 3).
6. **Small stale field lists** — two files still name four (or three) fields
   as the manager-context-only set where there are five (`confirmPosture` was
   added later); a comment says "nine tool modules" where there are ten; the
   guard-check header says "four things" and lists five.
7. **The migration count in issue #110 itself** — "38 migrations" was already
   stale when written: there are 39, numbered 0001–0039 with no gaps. (A
   reminder of how fast counts rot; the notebook wisely never states one.)

### Where this lives (for reference, skippable)

Wall 1: `supabase/migrations/0007` (`private.current_company_id()`, the
three-policy loop), `packages/db/src/client.ts` + `user-client.ts`,
`scripts/rls-isolation-matrix.mjs`. Wall 2: `0027_worker_agent.sql`,
`packages/core/src/capabilities/types.ts` vs `capabilities/worker/types.ts`,
`worker/complete.ts` (photo `.min(1)`), `agent/memory/consolidate.ts`.
Wall 3: `capabilities/guard.ts` (`decideGuard`), `0031_confirm_posture.sql`,
`capabilities/index.ts` vs `propose.ts`, `scripts/guard-check.mts`.
Wall 4: `0016_worker_notifications.sql:74-76`, `0033_welcome_once.sql:38-41`,
`apps/web/lib/cron.ts` (`claimNotification`, `withinSendWindow`),
`apps/web/vercel.json`. Wall 5: `0020_task_review_supersede.sql:127-163`.
Finding 1: `AGENTS.md` §send-history, `0036_cron_schedules.sql:277-282`,
`rls-isolation-matrix.mjs:2787-2791`.

---

## 3. Where it is fragile

Honest list, worst first. "Fragile" means: works today, and the failure mode
when it stops working is silence rather than an error.

**1. The three highest-consequence checks only run when a human remembers.**
CI runs ten checks on every change — but all ten are the credential-free ones.
The tenant-isolation matrix (the only proof one company cannot see another's
data), the migration-drift check (the only thing that asks "did the live
database actually get every migration?"), and the agent smoke test all need
live credentials and are manual. This is not theoretical: migration 0038 sat
merged-but-unapplied in production for **three weeks** while the app half of
its feature was live — the symptom was a paused obra silently missing from a
screen, not an error. The drift check now exists *because* of that incident,
but it still only runs when remembered, and the isolation matrix has the same
status. These checks also run against the production database (there is no
staging environment), seeding throwaway tenants into it.

**2. Approval cards never expire, and the chat screen reads all of them,
forever.** The "expired" status has existed since migration 0001 and has never
once been written. With every manager defaulting to always-ask, pending cards
accumulate; the chat page then selects *every proposal the company has ever
had* — no limit, no date filter — and stacks every stale pending card above
the conversation. The same query also discards its own error, so a failed read
renders as "no cards at all". Two of the four appliers re-verify dates before
acting (so a stale card changes nothing), but ordinary guarded writes apply
their stored arguments whenever tapped, however old.

**3. Observability is `console.log` and a promise to grep.** The entire
monitoring stack is one three-line helper printing JSON to the platform log.
Roughly 35 seams deliberately swallow their own failures into a single
greppable line — the cost ledger write, the thread-event write, the schedule
read (whose failure silently ignores *every* company's chosen send hour), the
day-link mint, the unread badge, and more. Worse, sixteen outbound-send
fallbacks catch errors with *no log line at all* — including the one where an
approval card's interactive send fails, the text fallback also fails, and the
manager simply never sees the card while the proposal sits pending. Every one
of these is a documented decision ("recording must never break a send") and
each is defensible alone; together they mean the system's failure mode is a
dashboard that looks quiet. Nothing alerts. Every diagnosis starts with a
human already suspecting the answer.

**4. The daily send loops are sequential, uncapped, and truncate silently.**
Each cron tick walks every due company one at a time, and every recipient one
at a time — one Meta round-trip plus three database writes each — inside a
300-second execution ceiling. If the ceiling kills the run, companies at the
tail simply never get processed: no claim row, no run-log row, no "ran out of
time" line anywhere (the code has no clock check — the translation runner is
the only loop in the codebase that watches its own deadline). Within a window
the next hourly tick picks up the leftovers via the claim lock, which papers
over the problem exactly until a full window's work no longer fits in two
ticks. The morning-silence failure has already happened once from a different
cause (timer drift eating the old one-hour gate), so this class is proven.

**5. Everything rides one WhatsApp number, one database, one deploy.** One
Meta business number for every tenant (shared rate limits and messaging tier;
one tenant's spam report risk is everyone's), one Supabase project (no
staging), one Vercel project, one shared cron secret. A consequence already in
production: a phone number can belong to only one company across the whole
estate — a crew member on two companies' books gets permanent silence, by
design of the ambiguity guard.

**6. The conversation history is re-sent at full price on every model step.**
Prompt caching (Anthropic's discount for re-sent identical prompt prefixes) is
on and working — 46.6% of all prompt tokens are served from cache, saving
$3.54 of a would-be $9.63 all-time bill — but it covers only the tools and the
stable half of the system prompt. The message history, the largest and
fastest-growing block, carries no cache marker, so a twelve-step manager turn
re-bills the whole thread twelve times. Known, stated in the code, and left
out for a real reason (the moving-marker/20-block-lookback trap). At today's
spend this is cents; it is the first dial to turn when it is not.

**7. The pilot-foreman dead end.** A person who is both a manager and an
active crew member gets *silence* on every menu and check-in tap — sender
resolution finds their manager profile first, and the manager path has no
handler for those button shapes. Known, documented, unfixed — and it is the
most likely configuration for exactly the kind of small company Capo pilots
with.

**8. Assorted known sharp edges**, each documented in place: a failed WhatsApp
send burns that person's daily claim (no retry — recovery is manually deleting
the row); the Stripe webhook must point at the `www` host because the apex
domain answers a redirect and Stripe counts any redirect as failure — one env
edit away from every subscription state change silently failing; the web-push
immediate path has a documented, open double-send race; a worker consented
overnight gets their first briefing before their welcome; a deliberately
paused obra still paints all its tasks amber as "at risk". The worker agent
has daily turn caps (20/worker, 120/company) but **managers have no cap at
all** — one manager's runaway day is unbounded model spend.

---

## 4. What it costs to run

*Method: read-only queries against the live database's two ledgers —
`ai_usage` (one row per model API request, with token counts split into four
disjoint buckets) and `notification_log` (one row per proactive WhatsApp send
claim) — priced with the repo's own rate card. Numbers below are US dollars
because that is what Anthropic, Google and Meta bill in; no exchange rate is
applied anywhere, following the repo's own rule. Caveats: the AI ledger opened
2026-08-14 (18 days of data at time of writing) and the send ledger 2026-08-09,
so "per month" is August's observed figures, not a full-month average; the
WhatsApp rate ($0.03/template, Portugal utility) is the repo's own estimate,
unverified against a Meta bill; and the send count treats every delivered
message as paid even though some briefings go out as free session messages
inside a worker's 24-hour reply window — so the WhatsApp figure is a ceiling.*

### The headline

**An actively used company costs roughly $1–4 a month in metered costs today.
The busiest tenant — a manager chatting most days, briefings going out to a
small crew — cost $3.96 in August ($3.30 of AI + $0.66 of WhatsApp). That is
under a tenth of the €45 subscription.** Extrapolating 18 days of AI data to a
steady full month, an engaged tenant lands around **$3–6/month**; a quiet one
under $1.

### Per company, August 2026 (observed)

Nine companies exist; six have any recorded spend. Labels are anonymised in
creation order.

| Company (anonymised) | Profile | AI | WhatsApp (sent × $0.03) | Total |
|---|---|---|---|---|
| B — the pilot tenant | 1 manager, small crew, daily use | $3.30 | $0.66 (22) | **$3.96** |
| H | 1 manager, 3 active workers | $1.85 | $0.54 (18) | **$2.39** |
| G | 1 manager, briefings only | $0.27 | $0.54 (18) | **$0.81** |
| I | 1 manager, 2 workers, new | $0.63 | $0.12 (4) | **$0.75** |
| F | canceled; briefings ran | $0.01 | $0.42 (14) | $0.43 |
| A | dormant test | $0.03 | $0 | $0.03 |

Estate-wide, everything ever recorded in both ledgers totals **$8.37** — $6.09
of AI (121 model requests) plus $2.28 of WhatsApp (76 delivered sends out of
172 claims; the rest were skipped for lack of consent or nothing to say, or
failed).

### Where the AI money goes

| Surface | Share | Notes |
|---|---|---|
| Manager chat | $5.73 (94%) | 99 requests, Sonnet. The product's cost centre. |
| Plan generation | $0.18 | 4 plans |
| Nightly memory review | $0.14 | 9 runs, Sonnet, uncached by design |
| Summariser + voice notes | $0.04 | Haiku + Gemini; negligible |

Prompt caching is doing its job: 46.6% of all prompt tokens were served from
cache, cutting the all-time AI bill from a would-be $9.63 to $6.09. The
remaining big lever is the uncached conversation history (section 3, item 6).
Usage is bursty, not flat — three heavy days account for most of the total —
so per-month cost scales with manager engagement, not with company existence.

### The other two lines

**Stripe.** Standard EU pricing on a €45 charge: 1.5% + €0.25 = **€0.93 per
company per month** (≈2.1% of revenue) for a standard European consumer card;
€1.38 for UK/premium cards, €1.71 for non-European ones. If the account is on
a paid Stripe Billing tier for subscriptions, add ~0.5–0.7% (€0.23–0.32) —
worth one look at the actual Stripe statement to pin down.

**Hosting.** One flat Vercel bill and one flat Supabase bill for the whole
estate. Nothing meters either per tenant, so — as the repo itself insists — no
per-company hosting number is stated here, and any document that invents one
should be distrusted. For context only: the public list prices for the plans
this workload plausibly sits on are $20/month (Vercel Pro, per seat) and
$25/month (Supabase Pro); read the real figures off the two dashboards before
using them anywhere. At today's scale these flat bills are comfortably the
*largest* cost line — bigger than all metered AI and WhatsApp combined — which
is normal for a product with four active tenants and stops being true somewhere
around a dozen.

### What this means (the input #111 asked for)

Per paying company per month, steady state, today's shape:

- **AI: $1–6** depending almost entirely on how much the manager chats.
- **WhatsApp: $0.50–2** at current crew sizes ($0.03 × ~1–2 sends/day ×
  reachable people; a fully-consented 5-person crew could reach ~$5–7 ceiling).
- **Stripe: ~€0.93** per charge.
- **Hosting: €0 marginal** — flat bills that new tenants dilute, not increase.

Variable cost is **5–10% of the €45 price** for an engaged tenant; gross
margin on each additional company is above 90% before the flat bills. The
number to watch is manager-chat tokens: it is 94% of metered spend, is the
only uncapped meter in the product, and grows with exactly the behaviour the
product wants to encourage.

### Where this lives (for reference, skippable)

Rates: `packages/core/src/agent/pricing.ts`. Ledgers: `ai_usage` (migration
0032), `notification_log` (0016). The live equivalent of this section:
`/cost` in `apps/operator` (`apps/operator/app/data.ts`, `loadCostReport`).
The queries behind these figures were plain read-only SELECTs over those two
tables plus `companies`/`workers`/`profiles` head-counts.

---

## 5. What would break first at scale

The estate today is 9 companies (~4 meaningfully active). The walls below are
ordered by when they arrive, with the specific mechanism named — every one is
a *silent* wall, in keeping with the house failure mode.

**At 10 companies: nothing.** Every loop finishes in seconds; the nightly
memory review needs one of its three ticks; flat platform bills dominate cost.
The genuinely binding constraint at this size is operational: the manual
checks (section 3, item 1) and grep-based observability rely on one person's
attention, and that person is also building the product.

**At ~100 companies, four walls arrive roughly together:**

1. **The nightly memory review hits its ceiling.** 25 companies per tick × 3
   ticks = 75 companies a night. Beyond that, the remainder is silently not
   reviewed (the watermark makes it lateness, not loss — but permanent
   lateness once demand exceeds 75 nightly). First wall to *touch*, easiest to
   move: the batch size and window are constants.
2. **The 300-second morning ceiling.** Sends are sequential, ~0.5–1s per
   recipient; roughly 300–600 recipients per tick fits. Two ticks per window
   doubles that, then the tail of the estate silently gets no briefing — the
   truncation writes no log line and leaves no run row, so it looks identical
   to "nothing was due".
3. **The single WhatsApp number.** Meta rate-limits per number and tiers
   proactive reach per 24h (250 → 1,000 → 10,000 unique recipients, upgraded
   on quality history). A hundred companies × a few crew each sits right at a
   tier boundary, and one tenant's spam reports degrade quality for everyone.
   Multi-number support touches sender resolution, which currently assumes the
   estate shares one number.
4. **The operator's own screens.** The cost report pages through its ledgers
   properly, but most operator reads use flat 500–1000-row selects; they start
   quietly understating.

**At ~1000 companies, the architecture itself is the wall:**

- `billableCompanies` — the query every send route starts with — has no limit
  or paging, and the database API layer caps unpaged responses at 1,000 rows.
  Past that, **cron routes silently process a prefix of the estate**, every
  hour, forever. This is the hardest wall in the building because it fails
  without any symptom at all.
- The hourly-heartbeat-plus-sequential-loop pattern cannot traverse the estate
  inside any single invocation; the fix is a real queue or fan-out (per-company
  jobs), which is a structural change, not a constant.
- The chat page's read-every-proposal-ever query becomes a per-pageload scan
  for the largest tenants (fixable long before this point; section 6).
- One shared Postgres remains fine for *data volume* at this scale (these are
  small rows), but every safety property that is "verified by a script a human
  runs against production" is by now unverifiable in practice.

**The per-turn model spend scales differently — per manager, not per
company.** Twelve steps × uncached history × no daily cap means cost tracks
engagement linearly with a long tail; at 100 engaged managers the AI line is
~$300–600/month, still small against ~€4,500 of revenue. Spend is not the
scale wall; delivery is.

---

## 6. What to do about it

Ranked. Each has a cost and a consequence-of-not-doing. Everything not listed
here is named as accepted risk below — deliberately accepted, not forgotten.

**1. Put the credentialed checks on a timer.** A scheduled GitHub Actions run
(nightly isolation matrix; migration-drift check after every deploy that
carries a migration) with the credentials stored as repository secrets — or,
given the Vercel-Sensitive-env constraint, a scheduled Claude Code routine
that runs them and reports. *Cost: about a day, mostly secrets plumbing. Not
doing it: the tenant boundary and the migration ledger are verified only by
memory; the 0038 incident (three weeks of a silently missing feature) recurs,
and the next one may be an RLS regression — invisible until a customer sees
another company's data, which is the one failure this product cannot have.*

**2. Expire approval cards and bound the chat-page read.** A tiny migration
(write `expired` on pending proposals older than N days — the status has
waited since 0001 to be used) plus a `limit` + status filter on the chat
page's proposals query, and stop discarding its error. *Cost: half a day.
Not doing it: the busiest tenants' chat screens degrade steadily; a months-old
card can be tapped and apply stale arguments; and the pending pile makes the
"needs your decision" signal — the product's core interaction — meaningless.*

**3. Give every cron loop a clock and a voice.** Copy the translation runner's
deadline pattern into reminders/checkin/welcome/consolidate: check elapsed time
each iteration, stop cleanly before the ceiling, and write one "stopped early,
N companies unprocessed" log line — plus a `.limit()` with paging on
`billableCompanies` so the 1,000-row API cap can never silently truncate the
estate. *Cost: a day. Not doing it: the section-5 walls at ~100 companies
arrive as silence — the exact class of failure (a morning nobody was messaged,
no error anywhere) that has already happened once and cost a debugging day; at
1,000 companies it becomes a permanent, invisible partial outage.*

**4. Fix the prose that future sessions will obey.** Correct the three copies
of the wrong null-guard rationale, the "three UTC cron entries" self-
contradiction, and the deny-all undercount; add the two missing cheap gates
(a CI assertion that the four appliers stay out of the roster; a lint rule
against `getDb()` on request paths). *Cost: hours. Not doing it: in most
repos stale docs waste time; in this one, where AI sessions treat `AGENTS.md`
as operating instructions, a wrong security rationale is an instruction to
build the next boundary wrong.*

**Accepted risk — named, not forgotten:** the uncached conversation history
(cents today; revisit when the AI line matters, and the 20-block-lookback
complexity is real); the single WhatsApp number (fine below ~100 companies;
multi-number is a project, start it when tier limits appear in Meta's quality
dashboard); `console.log` observability (adequate while one person can hold
the grep list; revisit alongside item 1's scheduler, which can also grep);
the pilot-foreman dual-role silence (a product decision about sender
precedence, not a bug fix); the push double-send race (bounded and cosmetic);
the welcome-before-briefing overnight gap; the paused-obra amber noise; no
manager daily turn cap (add one only if a real runaway day ever appears in
`ai_usage`); no staging environment (defensible at this size; becomes item 1's
problem to flag).

### The verdict

The architecture is sound, and — more unusually — it is sound in a *checkable*
way: the walls that matter are types, grants, unique constraints and statement
ordering, not prompts or good intentions, and most of them have a purpose-built
check. The system's real weakness is not design but operations: its safety
story leans on scripts a human must remember to run, its failure mode is
near-universally silence, and its design record — which in this project is
executable documentation — has started to drift from the code in exactly the
way issue #110 feared. All four recommendations are about closing that gap;
none is a rewrite.
