# Test automation proposal — what to automate first, and why

This is a **recommendation, not a commitment**. It ranks the next automated
checks worth building by the silent-failure cost each one prevents (the
currency defined in `docs/risk-list.md`), says roughly what each costs to
build, and names what it deliberately does NOT recommend yet. Nothing in this
document has been built.

## The pattern we already have, and why it works

Capo has no conventional test suite, but it is not untested. It has a family
of **check scripts** — small standalone programs in `scripts/`, one per risk
area, each of which runs a long list of assertions and answers only
pass/fail. As of the August runs there were over a thousand individual
assertions across ten of them. They share four properties, and the properties
are the point:

1. **Credential-free.** They need no passwords, no database, no network — so
   they can run in **CI** (continuous integration: the automatic gate that
   runs on every proposed change and blocks the merge if anything fails).
   A check that needs a secret cannot run there, and becomes a chore.
2. **Deterministic.** Same input, same answer, every time. No flakiness, so a
   red result always means something.
3. **No framework.** Each is a plain script. Nothing to install, learn or
   maintain beyond the file itself.
4. **Each one was written against a specific silent failure**, usually one
   that already happened or nearly did. They are smoke detectors placed where
   there was smoke.

Two more exist that DO need credentials, so they run only when a person
remembers: `rls-matrix` (attacks the walls between companies — the most
important check in the product) and `agent-smoke` (drives a real conversation
against a throwaway account). Plus `migration-check` (is the live database up
to date with the repo), also manual.

## The two honest gaps

**Gap 1 — every CI check tests a calculation; every real failure lived in a
journey or in configuration.** The five failures that actually happened
(risk list, Part 1) were: a drifting clock meeting a strict gate, a skipped
migration, a message template missing a language *in Meta's dashboard*,
an exhausted AI credit balance, and a webhook pointed at a redirecting
address *in Stripe's dashboard*. Three of those five lived entirely outside
the repo. No conceivable test of the code would have caught them, because
the code was correct.

**Gap 2 — the strongest tests we have are on the honour system.** The tenant
-isolation attack suite exists, is sharp, and runs only when someone
remembers to type `pnpm rls-matrix`.

These two gaps, not "more unit tests", are what the next automation money
should buy. Hence the ranking below.

---

## Recommendation 1 — a morning-after production watchdog (build this first)

**What it is:** one small scheduled script that asks the live system, once a
day, "did yesterday actually happen?" — and tells you only when the answer is
no. Concretely, four questions:

1. **Did the daily sends run and reach people?** Read the run log
   (`cron_runs`): a company with eligible crew and no briefing run, or a run
   whose exclusion counts swallowed everybody, is an alert. This is failure
   H1's class.
2. **Did any send fail per-recipient?** Read the send ledger
   (`notification_log`) for rows carrying a delivery error — this is exactly
   where H3 (the missing template language) sat, failing daily, recorded,
   read by nobody.
3. **Is the AI alive?** Compare yesterday's inbound messages against
   yesterday's cost-ledger rows. Messages without model calls = H4, the
   credit-exhaustion silence, caught the next morning instead of whenever a
   human notices.
4. **Is Stripe reaching us?** Ask Stripe's API for recent webhook delivery
   failures. Any failure = H5's class, caught in a day instead of at a
   customer lockout.

**Why first:** it is the only item on this list that addresses **four of the
five failures that actually happened**. Everything it reads already exists —
the run log, the send ledger, the cost ledger were all built precisely to
make these questions answerable; today nothing asks them.

**What it costs:** small. One script in the existing style plus a scheduled
runner (GitHub Actions — the same machinery CI uses — can run a script on a
timer, not just on code changes). It needs credentials (the database service
key, a Stripe read key) stored as GitHub secrets, which is a decision for
you: those keys living in GitHub is a real, if standard, trade-off. The
alerting channel can start as "it opens a GitHub issue when red".

**What it is not:** a test. It is monitoring. That distinction matters — it
proves yesterday worked, not that tomorrow's code is correct — and it is
still the highest value-per-effort item here, because our actual history says
production configuration fails more often than merged code does.

---

## Recommendation 2 — put `rls-matrix` on a schedule (do this in the same breath)

**What it is:** no new test at all. The existing tenant-isolation attack
suite, run automatically — weekly, or nightly — from the same scheduled
runner as Recommendation 1, opening an issue on any red.

**Why second:** risk #1 (one company seeing another's data) is the most
expensive failure the product can have, it already has the best test in the
repo, and that test's only weakness is that a human must remember it. The
check-script pattern's whole lesson is that "somebody remembers" eventually
fails. This closes the honour-system gap for the top of the risk list at
almost zero build cost.

**What it costs:** trivial once Recommendation 1's runner exists — the script
already works; it needs the same class of secrets. One caveat to respect: the
suite seeds and cleans up test data in the live database. It was written to
do that safely (it always has been run against production by hand), but
"automatically, at 03:00, unattended" deserves one careful review of its
cleanup paths first.

**Also fold in:** `pnpm migration-check` (risk #8 — the skipped-migration
class, which burned us twice). Same runner, same cadence, near-zero cost.

---

## Recommendation 3 — a billing-journey check, credential-free, in CI

**What it is:** extend the existing `billing-check` from "the trial
arithmetic is right" to "the webhook handler does the right thing with each
event". Hand-write the three Stripe event shapes we subscribe to (a checkout
completing, a subscription updating, a subscription being deleted — as fixed
sample payloads, the same way `cost-check` pins hand-written provider
payloads), drive the real handler code against a stubbed database recorder,
and assert: the right company gets the right status; an event matching no
company logs its orphan event instead of vanishing; the recovery path
re-links a customer by the identity stored for exactly that purpose; a
zero-row update is detected rather than treated as success.

**Why third:** risk #2 is the most expensive per-person failure on the list,
and today its handler logic has no check at all — `billing-check` covers only
the date arithmetic. This cannot catch H5 itself (a wrong URL in Stripe's
dashboard — Recommendation 1's job), but it catches the code half of the same
disaster: the delivery arriving and being mishandled.

**What it costs:** medium-small. It follows the established pattern exactly
(deterministic, credential-free, no framework, runs in CI), so it is a
matter of writing the fixtures and the stub — comparable to what
`cache-check` already does with a stubbed network.

---

## Recommendation 4 — a briefing-composition check, credential-free, in CI

**What it is:** the 07:00 pipeline's decision-making, checked end to end
with a stubbed database: given a fixture company (workers with and without
consent, tasks in every status, helpers and leads, three languages, a task
in review, an overdue task), assert exactly **who** gets a message, **which
kind** (free text, tappable list, or paid template), **in which language**,
saying **what** — including the things that must be absent: no nagging about
a task already declared finished, no paid template to somebody inside their
free-reply window, no day-link on the template path, helper wording never
reading as ownership.

**Why fourth:** risk #3 (the briefing failing) and risk #5 (a claim lost in
the journey) both pass through this composition. Its pieces are individually
checked today (`scheduler-check` does the clock, `whatsapp-check` does the
message shapes), but the *composition* — who is included, who is excluded and
why — is checked by nothing, and "everyone was silently excluded" has
already happened once in production as a data problem that looked like a
code problem.

**What it costs:** medium. The loader touches the database in a few places,
so the stub is more work than Recommendation 3's — but the render half is
already pure and partially covered, and the fixture company doubles as
documentation of what the briefing is supposed to do.

---

## Explicitly NOT recommended yet, and why

- **A browser end-to-end framework (Playwright or similar), simulating a
  user through the real UI.** The most expensive kind of test to build and
  keep green, famously flaky, and aimed at the class of bug (visible UI
  journeys) that our history says gets caught fastest by humans anyway. The
  manual QA script covers this ground at the right price for the product's
  current size. Revisit when there is a team, not before.
- **AI-quality evaluations (scoring whether Capo's answers are good).**
  Genuinely valuable, genuinely a research project: non-deterministic,
  needs paid model calls per run, and needs careful judgment about what
  "good" means. `agent-smoke` already covers "does the machinery work".
  Keep it manual for now.
- **A conventional unit-test framework (Jest/Vitest) migration.** The check
  scripts ARE unit tests, with less machinery and a perfect track record of
  running. Migrating them buys tooling familiarity for future engineers at
  the cost of a churny rewrite now. Do it, if ever, when hiring makes it
  matter.
- **Testing the frozen SMS path.** It is switched off and kept byte-frozen
  on purpose; a test would be testing a museum piece.

## The decision being asked of you

Recommendations 1 and 2 need one thing only you can give: **the go-ahead to
store production credentials (database service key, Stripe read key, the
Supabase access token) as GitHub Actions secrets**, so scheduled runs can use
them. Everything else about them is small and reversible. Recommendations 3
and 4 need no decision at all — they follow the established pattern and can
be picked up as ordinary issues whenever there is a free evening.

If only one thing gets built from this document, build Recommendation 1. Our
own history — five real silent failures, four of them invisible to any test
of the code — is the argument.
