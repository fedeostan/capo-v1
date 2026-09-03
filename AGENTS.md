<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## How to talk to the person you are working with

**This rule applies to every session in this repository, without exception, and
it outranks any default habit of writing terse engineer-to-engineer summaries.**

The owner of this project — the person reading your messages — **is not a
software engineer and does not read code**. He is the product owner: he knows
the business (Portuguese construction crews, WhatsApp, managers, tarefas,
obras) better than you ever will, and he decides what gets built. He does not
know what a "view", a "migration", a "trigger", "RLS", or a "denylist" is
unless you teach him, and he wants to learn as you go.

**Never assume he knows a technical term. Always explain. Always teach.**

This rule governs your *messages in the conversation*. It does not change how
you write code, code comments, commit messages, or the rest of this file —
those stay precise and technical.

### The four rules

1. **Lead with the human meaning, never the mechanism.** The first sentence of
   any explanation says what changes for a manager or a worker using Capo.
   The code detail comes after, as support — never as the opening.
   - No: "Added a `pending_review` status gated by an allowlist in `BRIEFABLE`."
   - Yes: "When a worker says they finished a job, Capo now waits for your
     approval before treating it as done — and it stops nagging that worker
     about it in the morning message."

2. **Explain every technical word the first time you use it, every session.**
   Do not assume a term was learned in a previous conversation. Write it as
   *plain word → short definition → why it matters here*. Never leave an
   abbreviation unexpanded (RLS, RPC, PR, API, cron, view, migration, index,
   trigger, enum, cache, deploy, env var, schema).
   - Example: "a *migration* — a numbered instruction file that changes the
     shape of the database, applied once and never edited afterwards".

3. **Teach one idea per explanation.** When you touch something worth
   understanding, spend two or three sentences teaching the concept behind it,
   with a real-world comparison. The goal is that he understands the system a
   little better after every task, not just that the task is finished. Prefer
   analogies drawn from his world (a building site, a crew, a checklist, a
   locked door, a form) over programming analogies.

4. **Code references go at the end, clearly labelled as optional.** File paths
   and function names are useful as a receipt, not as the explanation. Put them
   under a heading like "Where this lives (for reference)" so he can skip them
   without losing the meaning.

### Shape of a "what changed" summary

When you finish a task, do not write a changelog. Write it in this order:

1. **What you asked for** — one sentence, in his own words, so he can confirm
   you understood correctly.
2. **What is different now** — what a manager or worker will actually see,
   feel, or be able to do that they could not before. Concrete and observable.
3. **How it works, in plain language** — the mechanism, taught, with any new
   terms explained. This is the part he is meant to learn from.
4. **What you did not do, and anything to watch** — honestly stated: skipped
   scope, known risks, things that still need his decision.
5. **Where this lives (for reference)** — the file paths and technical names,
   last, marked as skippable.

Keep it readable. Short paragraphs, plain words, tables when comparing things.
Length is fine if it teaches; density and jargon are not.

### Shape of a plan

Same principle, before the work instead of after. A plan describes **outcomes
in the product**, in the order they will happen, and what each step will let a
user do. Technical steps get one plain-language line each explaining *why* that
step is needed. If a step carries a real risk or a trade-off, say so plainly
and say what the alternative would be — he is the one who decides.

### Things not to do

- Do not open with a file path, a function name, or a symbol like
  `resolve_task_review()`.
- Do not use an abbreviation and move on.
- Do not say "as you know", "as expected", "simply", or "just" — they signal
  knowledge he may not have and make an unfamiliar thing sound obvious.
- Do not paste a diff or a block of code as the explanation of what changed.
- Do not flatten a genuine risk into reassuring language to keep the summary
  short. Plain language means *clearer*, never *vaguer* — the honesty rules
  about failures, skipped work, and uncertainty are unchanged.

## Repository layout (pnpm workspaces + Turborepo)

- `apps/web` — the tenant-facing Next 16 App Router PWA (RLS, publishable key).
- `apps/operator` — internal mission-control Next app (service-role,
  cross-tenant, separate deploy; must never be reachable by tenants).
- `packages/core` (`@capo/core`) — agent core, capabilities, guard/render,
  models, channels, persona/prompts (bundled TS modules, not files on disk).
  Two agents live here, not one: the manager's (`agent/core.ts` +
  `capabilities/`) and the restricted worker one (`agent/worker-core.ts` +
  `capabilities/worker/`). They share a model provider and the knowledge-base
  retrieval function; everything else — tool type, context type, conversation
  store, persona, policy — is deliberately separate. See the worker invariants
  below before touching either.
- `packages/db` (`@capo/db`) — Supabase clients (system + user), generated
  types, session helpers, proxy session.
- `packages/ui` (`@capo/ui`) — shared presentational components.
- `packages/i18n` (`@capo/i18n`) — locale primitives (`Locale`, `LocaleContext`,
  `coerceLocale`) and the user-facing copy catalogs (pt-PT / es-ES / en-US).
  A zero-dependency leaf: `i18n ← db ← core ← {web, operator}`, `i18n ← ui`.
  Model-facing prompt copy lives in `packages/core/src/i18n` instead —
  deliberately separate, so UI strings never enter the agent bundle.
- `packages/config` (`@capo/config`) — shared tsconfig/eslint presets.
- `supabase/migrations` — single shared DB; migrations stay at the root.
- `scripts/rls-isolation-matrix.mjs` — the two-tenant RLS isolation matrix: a
  per-tenant visibility sweep over every relation carrying `company_id`, a
  deny-all check on the two send ledgers, and a set of adversarial cross-tenant
  attacks (cross-company FKs, billing self-upgrade, forging a translation undo
  snapshot, forging a worker check-in answer, claiming another tenant's worker's
  BSUID, the two task-review RPCs, the guided menu's read
  (`checkWorkerMenuScope`, #49 — the one boundary in the file that is a
  TypeScript filter rather than a Postgres policy, hand-copied here because this
  file is plain `.mjs`, so change one and change the other), the run-history
  reader (`checkSendHistoryScope`, #51 — the only tenant window into
  `notification_log`, SECURITY DEFINER, attacked cross-tenant AND from the
  orphan for the 0021 null-guard trap, with a positive control), the schedule
  (`company_schedules`: writing another company's, switching off their
  briefing, forging `updated_by`, plus an owner-can-still-save control), the
  run log (`cron_runs`: forging or rewriting a run), memory scope
  (`checkMemoryScope`, #48 — the SECOND per-profile relation: a colleague's
  personal memory read, forgotten or forged, plus the cross-company
  `profile_id`, the column grant, the nightly ledger, and a positive control,
  because a policy that hid every COMPANY memory would pass every refusal in
  this file while making Capo forget the business), and the
  Supabase Storage surface — signing, downloading, listing and writing another
  tenant's task photos, and the worker thread a tenant may read but never
  write). Since #22 it also carries `checkWorkerTextIsolation`, the one check in
  the file that is not about tenants at all: a service-role sweep proving
  worker-authored text never lands in `messages`, `conversation_summaries`,
  `memories` or `proposals` (since #120 the tracer is seeded through a worker
  problem report too, and the report tables get their own deny-all reads,
  reporter-forgery attacks and a no-`.select()` positive control on the app
  path's INSERT). Run with `pnpm rls-matrix` after any change that
  touches auth, RLS, Storage, or the DB clients; it must stay green.
  Needs credentials, so it does not run in CI.
  Note what it does NOT prove: every check asserts a REFUSAL, so a policy that
  denied everyone would pass all of them. After adding a policy, verify the
  owner's own path still works too.
  Two traps when WRITING a check here, both of which shipped red once and were
  fixed in the same pass:
  - **"The tenant sees nothing" has two legitimate shapes.** A table that keeps
    its SELECT grant and has no policy answers `0 rows, no error`
    (`dispatch_log`, `notification_log`); a table that also `revoke all`s
    answers **42501** before RLS is consulted (`ai_usage`,
    `checkin_photo_requests`) — strictly stronger. Assert through
    `readIsDenied`, never on `!error && rows === 0`, or the safest tables in the
    schema report as failures. It deliberately rejects **42P01**: a dropped
    table must never read as secure.
  - **A positive control on a WRITE-ONLY table must not chain `.select()`.**
    supabase-js only asks for the inserted row back when you chain it, and that
    RETURNING clause needs SELECT — so `.insert(...).select('id')` is refused
    42501 on `ai_usage` while the write itself succeeds. Mirror the call site
    exactly (`const { error } = await db.from(t).insert({...})`) and confirm the
    row landed on the **service role**, which is the only actor that can read it.
- `scripts/scheduler-check.mts` — deterministic checks over the plan
  scheduler and the Portuguese working-day calendar. Since #51 it also covers
  the *other* schedule in the product: the cron send window
  (`withinSendWindow`) and the UTC entries in `apps/web/vercel.json` that feed
  it, which it reads and asserts season by season. Since #45 it also asserts the
  welcome sweep's much wider window (Lisbon 09–19) and that it opens only after
  the 07:00 briefing's window has closed. Needs **no credentials
  and no network**, so it runs in CI on every PR (`pnpm scheduler-check`).
- `scripts/cache-check.mts` — provider prompt caching (#58). Asserts the
  system-prompt split is byte-identical to the single string it replaced, that
  the breakpoint sits ABOVE the daily date line, that exactly one tool
  definition carries one, and — by driving the real `@ai-sdk/anthropic`
  provider through a stubbed global `fetch` — that `cache_control` lands on the
  wire where we think it does. Credential-free, so it runs in CI
  (`pnpm cache-check`).
- `scripts/memory-check.mts` — the gate between the nightly memory review's
  model output and the database (#48): the name guard, deduplication against
  both stored history and the run itself, the per-run write cap, and the length
  cap. Everything that gets through is injected into every future system prompt
  for that company and is never re-checked, so a defect there is a wrong answer
  for ever rather than once. Credential-free, in CI (`pnpm memory-check`). The
  READ-side cap and the per-profile visibility filter live in `cache-check`
  instead, beside the prompt they bound.
- `scripts/cost-check.mts` — the token ledger and the rate card (#53). Pins the
  provider-payload → four-bucket mapping against hand-written
  `LanguageModelV4Usage` shapes (the double-counting bug is silent and
  plausible), asserts every model in `MODEL_IDS` has a price, checks the
  cache multipliers against the 1.25×/0.1× `cache.ts` argues from, and reads
  the NEWEST migration that declares `ai_usage`'s `surface` CHECK (0032,
  redefined by 0037) to assert it matches the `UsageSurface` union — reading
  0032 alone would be an assertion about history rather than about the live
  schema. Credential-free, so it runs in CI (`pnpm cost-check`).
- `scripts/activity-check.mts` — the activity feed's pure half: every event
  kind in all three languages, the anonymous-claim branch (a claim with no
  worker is the manager's own, and must never render "null says…"), photo
  pluralisation, day-grouping order, and the Lisbon-vs-UTC day boundary.
  Credential-free, in CI (`pnpm activity-check`). It covers the render half
  only; the three database reads in `loadActivity` need credentials and are
  outside the gate by construction.
- `scripts/phone-check.mts` — the ONE phone normalizer
  (`packages/core/src/channels/phone.ts`): the country picker's arithmetic, the
  Argentine 9, the legacy `15`, the trunk zero, the split/compose round trip,
  idempotency, and the refusal of junk. It exists because this is the quietest
  failure in the product: a number stored in a shape WhatsApp does not use
  raises nothing anywhere, it just means that person is never reached and never
  recognised. Credential-free, in CI (`pnpm phone-check`).
- `scripts/voice-check.mts` — the static half of Capo's tone. Keeps every
  MODEL-FACING file (personas, policies, prompt blocks) at ZERO long dashes in
  its string literals, and ratchets the user-facing copy catalogs downward from
  a per-file budget. It exists because of a finding, not a preference: Capo was
  not disobeying its instructions about tone, it was IMITATING them — the
  orchestration policy alone carried forty em dashes — so the loudest machine
  tell in the product was coming from the document meant to prevent it. Whole-
  line comments are stripped before counting, exactly as `design-check` does
  and for the same reason: an explanation of why a dash was wrong necessarily
  contains one. Credential-free, in CI (`pnpm voice-check`).
  The budget is a NUMBER per file rather than `design-check`'s list of exempt
  FILES, and the difference is forced: those files are being converted wholesale
  and will leave the list entire, whereas the copy catalogs go on receiving new
  copy forever, so a file-level exemption would leave every sentence added for
  the next two years ungated. A new violation exceeds the budget and fails; a
  budget nobody lowered after a cleanup fails as STALE.
  Deliberately NOT scanned: tool descriptions in `capabilities/*.ts`. They are
  model-facing too, across some thirty files, and folding them in now would make
  the table stop reading as a to-do list. Widening it is a decision, not a
  cleanup.
- `scripts/agent-smoke.mts` — drives `handleInbound()` against a throwaway
  seeded tenant. Needs real API keys, so it is a manual gate
  (`pnpm agent-smoke`).
- `scripts/migration-drift.mts` — asks the one question no other check asks:
  does the LIVE database carry every migration this repo has written? It exists
  because 0038 sat merged and unapplied for three weeks while the app half of
  the same feature was live, and the symptom was not an error but a paused obra
  quietly missing from the Obras screen. Reads the applied history through the
  Management API (`supabase_migrations` is not a PostgREST-exposed schema, and
  neither widening the exposed schemas nor adding a SECURITY DEFINER reader in
  `public` is worth a permanent piece of tenant-facing surface for a check).
  Needs `SUPABASE_ACCESS_TOKEN`, so it is a manual gate, not CI
  (`pnpm migration-check`) — run it after any deploy carrying a migration:
  merge → deploy → apply → check.
  It is a SET comparison, deliberately: the applied order does not match the
  repo's numbering and never has (0017 landed after 0018–0020, two streams of
  work on one day), so a positional check would have cried wolf on a healthy
  database from its first run. What it does NOT prove: that an applied
  migration did what its file now says — a file edited after being applied
  still reads as applied, which is why the never-edit-a-migration rule stays
  load-bearing.

Three language dials (do not collapse them into one):

- `profiles.language` — **per user**. What Capo speaks, the deterministic
  approval cards, the transcription instruction, the rolling summary, the web
  UI. Changeable from chat via the `set_language` tool.
- `companies.language` — **per tenant**. What Capo *stores*: task titles, job
  names, memories, generated plan titles.
- `workers.language` — **per crew member**, and the only one a worker controls
  themselves, by replying `PT`/`ES`/`EN` to their 07:00 WhatsApp briefing. It
  is nullable and the null means "inherit `companies.language`" — do not give
  it a default. See the structural invariant below.

Both dials live on **`/perfil/definicoes`** — one of the five rooms `/perfil`
split into when the profile drawer landed. `/perfil` itself is now a five-row
index (Informação pessoal, Equipa, Faturação, Privacidade, Definições) rather
than a settings screen, reachable both from the drawer in the persistent top
bar and as an ordinary page; Faturação points at the pre-existing
`/subscricao`. The primary control moves both dials together and offers to
translate the existing rows; the bare per-dial forms are demoted into an
"advanced" disclosure for the case that actually needs them — a manager who
does not share the crew's language.

`LanguageDriftNote` sits at the top of that Language card, ABOVE the control
and never inside the disclosure, for the reason in #55: a manager who does not
know the split exists will never open a disclosure about it.

Moving `companies.language` **alone** still retranslates nothing, and that is
why no path offers it casually. The paths that move it together with the data:

- `/perfil/definicoes` → the Language card with "also translate what already
  exists".
- chat → `translate_company_data`, which only ever *proposes*. Its applier,
  `apply_company_translation`, is deliberately **absent from the roster** and
  reachable solely through an approved card — same shape as
  `generate_plan`/`apply_plan`, and for the same reason: a *guarded* tool in the
  roster would be executed directly whenever the model can quote the manager,
  which for "traduz tudo para inglês" is always.

**Two dials that disagree are a legal state, and the product now SAYS SO**
(issue #55). Federico read English while the board filled with Portuguese
titles, and every part of the system was behaving exactly as designed — the two
dials had drifted apart and nothing anywhere told him, so he had to infer a
setting he did not know existed from its output. The fix is a signal, never a
collapse of the two dials: collapsing them breaks the case the split exists for.
It is said in three places, and the redundancy is deliberate because the third
is model-mediated:

- `/perfil`, at the top of the Language card, above the control that fixes it
  (`LanguageDriftNote`) — not inside the "advanced" disclosure, because a
  manager who does not know the split exists will never open a disclosure
  about it.
- `/tarefas`, above the board (`LanguageDriftStrip`) — the board is where a
  title is READ, so it is where a title in the wrong language is noticed.
  Styled quieter than the amber materials banner next to it: this is a
  standing fact about a setting, not something to act on today.
- In chat, by Capo itself: a bullet inside `buildLanguageDirective`'s
  `user !== company` branch tells it to say once, on its first write of the
  conversation, what it stored and in which language. It sits BEFORE the
  `translate_company_data` line and therefore far above the
  `manager_instruction` carve-out, which stays last and unreworded.

Both components render **nothing** when the dials agree, which is every tenant
that never split them, and neither ever moves a dial — they only point at the
one control that moves both together. The copy must not read as an error: it
names the case in which the split is correct.

Translation invariants (`packages/core/src/translation`, migration `0015`):

- **Collect from base tables, never `task_board`.** The view filters by
  `lisbon_today()`, so collecting through it would silently skip rows and couple
  translation to the calendar. Translate every status, `done` included.
- **Undo marks, it never deletes** — uniform with the schema's no-DELETE-policy
  posture. `old_value` is immutable at the *grant* layer, so the bytes the undo
  replays cannot be forged even by the tenant that owns them.
- **Write the domain row before recording the item.** Dying in between
  re-translates one value on resume; the reverse order loses a write silently.
- **Never zip a translator response by position** — match on the returned ids.
  A dropped item would otherwise land every later translation on the wrong row,
  with no error and a snapshot that faithfully records the mistake.
- Translating `tasks.title` / `jobs.name` changes what the 07:00 crew WhatsApp
  briefing says. `dispatch_tasks_today` is untouched structurally, but its
  *content* switches language — which is why the approval card says so out loud.

The single highest-risk regression in this area: the guard
(`packages/core/src/capabilities/guard.ts`) authorizes a direct write by
substring-matching the model's `manager_instruction` quote against what the
manager actually typed. If the model ever translates that quote, **every direct
write silently degrades into an approval card** — no error, just friction.
`buildLanguageDirective` carries an emphatic carve-out; keep it there, and watch
`proposals` with `status='pending'` after any prompt change.

Edit that carve-out by **appending only**, never by rewording it, and keep it
the last bullet about translating — the `translate_company_data` line was
deliberately placed before it. The risk is highest in exactly the conversation
where the manager is asking for a translation, which is why the carve-out now
ends by saying so. `translate_company_data` being unguarded is the structural
backstop: `toAiTools` never gives it a `manager_instruction` field at all.

Structural invariants (do not regress):

- **The guard now has two postures, and the default is the cautious one**
  (`profiles.confirm_posture`, migration `0031`, issues #57/#64). `always_ask`
  — the column default, so every existing and future manager — makes
  `runGuarded` skip the direct-execute branch entirely: the quote is not
  consulted at all and every guarded write becomes an approval card.
  `trust_quote` is the pre-0031 behaviour, preserved byte-for-byte.
  Three things about it are load-bearing:
  - **`ToolContext.confirmPosture` is REQUIRED, not optional-with-a-default.**
    A default would make "new call site, forgot the posture" fall back to the
    riskier behaviour silently; required makes it a `tsc` error. `WorkerContext`
    must never gain the field — it is one of the five properties `tsc` now names
    when refusing `WorkerContext → ToolContext`.
  - **The guard stays pure and synchronous in its decision.** The posture is
    resolved on the request path, off the profile row the caller has already
    read (`getAuthState` on the web, `resolveManager` on WhatsApp) — never by a
    lookup inside `runGuarded`. `decideGuard` is the exported pure function and
    `pnpm guard-check` (credential-free, in CI) asserts the whole matrix.
  - **Both profile reads use `select('*')` for this column, deliberately.**
    Naming `confirm_posture` in either column list couples them to 0031, and a
    deploy landing first 42703s — which on `getAuthState` is every page in the
    app and on `resolveManager` is every manager becoming an unknown WhatsApp
    sender. `coerceConfirmPosture` reads an absent field as `always_ask`.
  - Known and NOT fixed: nothing expires `proposals`. The `'expired'` status has
    existed since `0001` and is never written by any code path. With always-ask
    as the default, `status='pending'` accumulates much faster. #124 blunted the
    two sharpest edges — `createProposalForCompany` refuses a card whose
    NORMALIZED args (sorted keys, case-folded strings, nothing else) match one
    already `pending` on the same conversation, answering the model
    `already_pending` instead of `proposed` so neither channel renders a second
    card; and the chat page stops stacking pending cards older than 14 days
    above the conversation (`STALE_CARD_DISPLAY_DAYS`, display-only: the rows
    stay `pending` and resolvable by id) — but a real expiry system remains
    open.
- **Billing runs on the LIVE Stripe account, and the webhook URL is the `www`
  host** (issue #85, cut over 2026-08-14). Live account `acct_1TtrERLIxn6Jugmn`,
  price `price_1U4J91LIxn6JugmnvZc5XN12` (€45/month EUR), endpoint
  `we_1U4JwCLIxn6JugmnMEnNNhDA` at
  `https://www.construcapo.com/api/stripe/webhook`, three events, portal
  configuration `bpc_1U4K5ALIxn6JugmnJTbCA060` (cancel at period end, no
  proration, no plan switching).
  **The apex `construcapo.com` answers `308`, and Stripe treats ANY 3xx reply to
  a delivery as a failure** — an apex endpoint fails 100% of deliveries with no
  error anywhere in this codebase. Since `0011` revoked the tenant's table-wide
  UPDATE on `companies` and re-granted `(name)` only, that webhook is the sole
  writer of `subscription_status`: no delivery means a paying customer keeps
  `trialing` and is locked out the day their trial expires. Four things follow:
  - **The 14-day trial lives in Capo's database and is handed to Stripe at
    checkout**, as `subscription_data.trial_end`. `resolveTrialEnd`
    (`apps/web/lib/billing-trial.ts`) is pure and lives OUTSIDE
    `subscricao/actions.ts` because that file is `'use server'`, where every
    export must be an async function compiled into a callable HTTP endpoint — a
    sync helper there is a build error and an async one publishes the rule as an
    endpoint. Stripe rejects an entire Checkout Session whose `trial_end` is
    nearer than 48 hours, which is the whole reason the function exists; the
    rule is *carry it across when comfortably clear of the floor, otherwise
    charge today*, and `TRIAL_CARRY_MARGIN_SECONDS` exists because the floor is
    evaluated when the request LANDS, so a trial ending at exactly 48:00:00
    would be refused for arriving two seconds late. `pnpm billing-check`
    (credential-free, in CI) asserts that no input can produce a value inside
    the floor — an invariant that survives a change of product mind, unlike the
    pinned cases beside it.
  - **A zero-row update is not an error.** Postgres reports a filter that
    matched nothing as a fully successful statement, so both webhook updates
    carry `.select('id')` and log `billing.company_not_found` /
    `billing.subscription_orphan` when nothing matched. Same posture as
    `loadCompanySnapshot` and `recordUsage`: swallowed, but greppable. Grep
    those events before concluding that a quiet billing table means quiet
    traffic.
  - **`subscription_data.metadata.company_id` is the SECOND identity, and the
    reason the recovery path can exist.** `client_reference_id` rides the
    Checkout Session only and is absent from every `customer.subscription.*`
    event, so without the metadata an unmatched subscription event can only be
    logged, never repaired. The recovery re-writes `stripe_customer_id`, and a
    `23505` there means another company already claims that customer — a data
    problem to look at, not a transient failure to retry.
  - **The live price carries `tax_behavior: 'unspecified'` and that is now
    frozen** — the field is immutable once a price has been used. Federico's
    decision (2026-08-14) is that Stripe computes no IVA and collects no NIF;
    invoicing happens outside Stripe. Adding IVA later means a NEW price object,
    leaving existing subscribers alone. It is never an edit to this one.
- **Capo sends its own account emails, and it builds its own confirmation
  link** (`apps/web/lib/auth-email.ts`, `apps/web/lib/emails/`, migration
  `0045`, W1). Signup confirmation, the resend and password recovery used to be
  `auth.signUp` / `auth.resend` / `resetPasswordForEmail`, with GoTrue mailing a
  Go template pasted into its dashboard. The paste was never done, so the
  DEFAULT template kept going out, and it routes the click through Supabase's
  own `/auth/v1/verify`: the token is consumed, the account IS confirmed, and
  the browser arrives at `/auth/confirm` with no `token_hash`. The app then told
  a person whose account had just been confirmed that their link had expired,
  while their password worked. Six things:
  - **`generateLink` mints, Resend delivers, and the split is the whole fix.**
    `auth.admin.generateLink()` on the SERVICE-ROLE client creates or finds the
    user and returns a token without sending anything; the message goes out over
    Resend's HTTP API with plain `fetch` (no `resend` npm package) from
    `Capo <ola@construcapo.com>`. GoTrue is still the only authority on
    identity; only the envelope moved. **Use `properties.hashed_token`, never
    `properties.action_link`** — `action_link` IS the `/auth/v1/verify` URL that
    caused the bug.
  - **The link shape is fixed**:
    `${siteUrl()}/auth/confirm?token_hash=<hashed_token>&type=<signup|magiclink|recovery>&next=</onboarding|/nova-password>`.
    The resend is a MAGIC LINK rather than a second signup token because there
    is no password at that point; verifying a magiclink token sets
    `email_confirmed_at`, which is the entire job. That was confirmed against
    the live project before it was written, not assumed.
  - **`/auth/confirm` also accepts `?code=`**, and that is load-bearing rather
    than tidy-up: it is what keeps the legacy fallback's links working. Do not
    delete it while that fallback exists.
  - **The no-key fallback is deliberate and is the ONLY place in `apps/` allowed
    to call `auth.signUp` / `auth.resend` / `resetPasswordForEmail`.** With
    neither `RESEND_API_KEY` nor `RESEND_SMTP_KEY` set, `sendAuthEmail` makes
    the exact pre-W1 call with the same `emailRedirectTo` and logs
    `auth_email.legacy_mailer` — because a deploy landing before the key would
    otherwise mean NO account emails at all: no signups, no password resets.
    `sendThroughLegacyMailer` is marked for deletion once the key is on Vercel;
    the built-in mailer must not be reintroduced anywhere else.
  - **`auth_email_sends` (0045) is the throttle, and it exists because GoTrue's
    rate limits left with GoTrue's mailer.** `/registar` and `/recuperar` are
    unauthenticated forms that cause mail to be delivered to an arbitrary
    address. **TWO bounds, and both are needed.** Per address,
    `AUTH_EMAIL_MAX_PER_WINDOW` (3) per hour, counted across ALL THREE kinds
    together — a limit spendable three times over by alternating doors is not a
    limit. Globally, `AUTH_EMAIL_MAX_GLOBAL_PER_WINDOW` (60) per hour across
    every address, because the per-address half bounds what one victim receives
    and NOT what our sending domain does: without it `/registar` could still
    mail unlimited distinct strangers, and `victim+1@`/`victim+2@` are distinct
    addresses to us but one inbox to Gmail. Deny-all posture
    (`notification_log`'s): RLS on, zero policies, every grant revoked, service
    role only. It carries NO `company_id`, so the RLS matrix's per-tenant sweep
    does not reach it and correctly should not. The row is inserted AFTER Resend
    accepts, never before.
  - **The throttle read FAILS CLOSED, with exactly one exception: a MISSING
    TABLE.** 0045 ships before it is applied, so "table absent" must still send
    or nobody could confirm an email between the deploy and the migration
    (`auth_email.throttle_unavailable`). Every other failure — a revoked grant,
    a network error, a broken service-role key — means the table exists and we
    cannot read it, so we do not know what already went out, and sending anyway
    would delete the throttle at exactly the moment something is wrong
    (`auth_email.throttle_failed`, answered `throttled`). ⚠ **A null count is a
    FAILURE, not a zero**, and PostgREST will not say so: a `head: true` count
    against a table that does not exist answers `204` with `count: null` and NO
    error, which `?? 0` turns into a throttle that reports healthy while being
    switched off. A real table answers `count: 0`. That null is what identifies
    the missing-table case; verified against the live project, and the same
    family of trap as the RLS matrix's `readIsDenied`.
  - **NOTHING the caller learns may distinguish one address from another.**
    `sendAuthEmail` returns `sent | throttled | skipped` and every value leads to
    the same screen: `skipped` is exactly the answer for "this address already
    has a confirmed account" and for "there is no such account", which are the
    two facts these flows are written not to leak. There was a fourth value,
    `signups-disabled` (`/registar?erro=fechado`), and it is GONE along with its
    copy in all three catalogs: on the Resend path accounts are created through
    the admin API, which IGNORES the dashboard's "Allow new users to sign up"
    toggle, so only the legacy fallback could ever produce it. **Closing signups
    now needs a Capo-side flag checked before `sendAuthEmail`** — do not
    reintroduce copy that describes a switch which no longer binds. The legacy
    path still logs `auth_email.signups_disabled` and then answers like every
    other non-send.
  - **The resend path sends NOTHING to a CONFIRMED account.** A resend mints a
    MAGIC LINK, and a magic link signs its holder in; GoTrue mints one happily
    for a confirmed user, whereas the old `auth.resend({type:'signup'})` errored.
    So this feature briefly let any visitor mail a working one-click login link
    to any registered address: submit `/registar` with somebody else's email
    (the pending-email cookie is set on every path, deliberately), then tap
    "Reenviar". `confirmedAccountExists` gates it and logs
    `auth_email.already_confirmed`. It **fails closed** — unknown means do not
    send — and it matches the address EXACTLY, because GoTrue's admin `filter`
    is a SUBSTRING search (`a@b.com` matches `xa@b.com`). supabase-js has no
    lookup by email, which is why that one call is raw REST.
  Copy lives in the catalogs under `auth.emails`, all three languages, and the
  READER's language is rendered in full with the other two as one line each —
  possible only because the app knows the visitor's locale, which a Go template
  inside GoTrue never could. `pnpm email-check` (credential-free, in CI) pins
  the link in both parts, the absence of template holes, and the presence of all
  three languages.
- **System-vs-user client split**: `getDb()` (service role) is system-only;
  `createUserClient()` (publishable key, RLS) is the client for everything on
  the tenant request path.
- **RLS is the tenant boundary** — never rely on prompts or app code for
  tenant isolation.
- Worker SMS dispatch (Twilio/n8n) is external and currently **PAUSED, not
  removed** — the n8n workflow is switched off outside this repo. Nothing here
  may break `dispatch_tasks_today` / `dispatch_log` semantics; they are kept
  byte-identical (baseline: `docs/plans/dispatch-viewdef-baseline.sql`) so SMS
  can be switched back on. **Do not write to `dispatch_log`** — the live daily
  briefing has its own ledger, `notification_log`, precisely because
  `dispatch_log`'s `unique (worker_id, dispatch_date)` would collide the day
  both channels run.
- **The worker briefing goes out over WhatsApp**, from
  `apps/web/app/api/cron/reminders` targeting 07:00 Europe/Lisbon (three UTC
  Vercel Cron entries, gated on `lisbon_hour()` through `withinSendWindow`). It
  reads `task_board` like everything else. Proactive sends need an approved Meta **template** — free-form text is
  only allowed inside the 24h window a recipient's own reply opens, which is
  why the webhook acknowledges worker replies.
- **WhatsApp feedback while a turn runs is a READ RECEIPT plus a TYPING
  INDICATOR, and both are free by SHAPE rather than by policy** (issue #50).
  **Message editing does not exist in the Cloud API** — there is one messages
  endpoint and it is send-only, so the "send a placeholder and edit it into the
  answer" design is unavailable, not merely unbuilt. Four invariants:
  - **A status update is not a message.** `buildReceiptBody` emits
    `status: 'read'` (+ optional `typing_indicator`) and **no `type`, no
    `template`, no `to`, no `recipient`** — addressed by the inbound
    `message_id`. Meta bills templates only, so a body that cannot name one
    cannot be billed; and with no recipient field it never touches
    `buildSendBody`, so the `to`-silently-wins BSUID hazard cannot reach it.
    `pnpm whatsapp-check` pins every one of those absences — that is the cost
    guarantee, so do not "tidy" the builder into an inline literal.
  - **The indicator lapses after 25s and there is NO keep-alive.** A repeating
    timer on a serverless function dies the instant the response flushes. The
    cover is ONE plain-text note at `PROGRESS_NOTE_AFTER_MS` (20s), from a
    single `setTimeout` created and always cleared inside one awaited call
    within `after()` (`withProgressNote`, `apps/web/lib/whatsapp-feedback.ts`).
  - **The 24h window is asserted, never assumed.** `mayNarrateProgress` is
    consulted before the note even though an inbound message opened the window
    seconds earlier: free-form outside the window is refused (131047) and the
    recovery path for that refusal is a PAID template.
  - **Unknown and ambiguous senders get nothing.** Blue ticks are an answer —
    they would confirm to a stranger that their message reached a live system,
    which is what the silent no-op exists to refuse. Every feedback call is
    below sender resolution and below the `.limit(2)` worker ambiguity guard,
    and every one of them swallows its own failure: feedback must never cost
    somebody their reply.
- **No proactive send goes out without a recorded opt-in** (migration `0025`).
  `whatsapp_opt_in_at` / `whatsapp_opt_out_at` on `workers` and `profiles`,
  latest-wins, evaluated by `hasWhatsAppConsent()` in
  `packages/core/src/channels/whatsapp.ts` and applied to the crew in exactly
  one place — `partitionCrew()` in `apps/web/app/notifications/briefing.ts`,
  which all THREE proactive sends read (the 07:00 briefing, the late-afternoon
  check-in, and #45's welcome). It was inline in `loadCompanyBriefing()` until
  the welcome needed the same three questions asked at a different time of day;
  copying the filter would have put a second copy of a consent rule in the
  codebase, and the symptom of two copies disagreeing is a person one send
  reaches and another silently skips. Managers are the documented exception —
  they have no `workers` row, so each route calls the same predicate directly on
  the profile, as `/api/cron/reminders` always has. It **fails closed** on a
  missing opt-in, an unparseable timestamp or a tie; do not add a branch that
  defaults either side. Meta's free test tier used to enforce this by accident
  through its five-number allow-list, and the production number has no
  allow-list, so this is now the only gate. Existing rows were deliberately not
  backfilled.

  **Recording consent for an EXISTING crew member has to RENDER, and until #157
  it did not.** `update_worker` accepts `whatsapp_opt_in`, and under
  `always_ask` (the default, so every manager) a guarded write becomes an
  approval card that must be drawn before it can be approved. The renderer's
  change list did not know the field, so a consent-only update produced an empty
  list and threw "empty change": the one sentence that turns a crew member from
  unreachable into reachable was the one sentence that failed. Two rules follow.
  The branch tests `!= null`, never truthiness, because `false` is the
  WITHDRAWAL and is usually the whole card. And it uses TWO strings
  (`workerChange.whatsappOptIn` / `whatsappOptOut`), never one with a value
  interpolated: granting permission and taking it back are different events and
  a card must not blur them. `pnpm guard-check` renders both, in all three
  languages, and still asserts that an update naming NO field is refused.
- **Cron schedules must fire at `:00`, never `:30`.** Vercel's cron dispatch
  drifts — 33 to 49 minutes, reproducibly, on this project — and both send routes
  gate on the Lisbon hour. A `:30` entry crosses the hour boundary and is
  rejected, which is precisely how the check-in shipped and then never sent a
  single message. Both routes `logEvent` when the gate rejects them, because a
  rejection writes no row and raises no error.
- **The hour gate is a WINDOW, not an equality check** (#51). `withinSendWindow`
  in `apps/web/lib/cron.ts` is the one seam both send routes ask, and it accepts
  `SEND_WINDOW_HOURS` (2) Lisbon hours starting at the company's chosen send
  hour — 7–8 for the briefing and 16–17 for the check-in by default, though
  since #51 part B those are defaults rather than constants. Four things:
  - **The equality check was 11 minutes from total silence.** It passes only
    while drift stays under 60 minutes and drift hit 49 on 2026-08-13. Past the
    hour the route answers 200 with `{skipped}`, writes no `notification_log`
    row and raises no error — the crew gets nothing on a morning that looks
    perfectly healthy. The window moves that cliff to 120 minutes; it does not
    remove it, and it does **not** retire the `:00` rule above.
  - **`notification_log`'s unique constraint is still the idempotency lock**, and
    is what makes widening safe: a second in-window invocation claims nothing
    (23505) and is a no-op by construction. The gate was never what stopped a
    double send. Do not "protect" the window with app-level state instead.
  - **The window never wraps past midnight** — `sendWindowEnd` clamps at 23. A
    wrapped run would roll `lisbon_today()` over and the lock would read it as a
    fresh unclaimed day, messaging everybody twice.
  - **`vercel.json` is an HOURLY HEARTBEAT for both hour-gated routes** —
    `0 * * * *` each — and no longer a hand-computed union of UTC hours. That
    changed with #51 part B: the send hour became DATA (see below), so a static
    file baked into the deployment cannot know what hour a tenant chose.
    `0 * * * *` covers every Lisbon hour in both seasons by construction, is at
    `:00` by construction, and puts TWO entries inside every window (the target
    hour and the one behind it). `pnpm scheduler-check` reads `vercel.json` and
    asserts exactly that, for every hour a manager may pick, season by season.
  - Consequence to remember: **two invocations pass the gate every day, and the
    route is now invoked 24 times.** Anything a route does outside a claim must
    be idempotent — which is why the briefing's chat-thread event note and its
    `cron_runs` row are written only by the invocation that won the claims. And
    the per-company window filter must stay AHEAD of `loadCompanyBriefing`: an
    out-of-window tick is meant to cost the clock, the company list and one
    schedule read, never a `task_board` read per company.
- **The schedule is DATA, in `company_schedules` (0036, #51 part B), and its
  ABSENCE is the default.** There is deliberately no backfill: a company with no
  row uses `DEFAULT_SEND_HOURS` in `apps/web/lib/schedule.ts` (7 and 16), which
  is byte-identical to the pre-0036 product. `readCompanySchedules` **degrades
  and never throws** — a deploy landing before the migration answers 42P01,
  logs `schedule.read_failed`, and every company falls back to the defaults.
  Neither route has a `SEND_HOUR` constant any more. Four things:
  - **`MIN_SEND_HOUR`/`MAX_SEND_HOUR` (5..21) bound a DOUBLE-BILLING risk, not
    a taste.** `sendWindowEnd` clamps at 23 and must never wrap; at 21 the
    window is 21–22 and cannot. The same pair is a CHECK constraint in 0036 and
    `pnpm scheduler-check` derives the no-wrap property from the constants.
  - **`enabled` may be switched off; a send may NOT be added.** A proactive
    send needs a Meta-approved template, so manager-authored wording cannot go
    out at all — and a *second* run of an existing kind on one day is refused by
    `notification_log`'s unique key `(kind, audience, worker_id, profile_id,
    notification_date)`, which would have to grow a `schedule_id` to allow it.
    That key is the only thing preventing a double-billed send; do not widen it
    to ship an "add a send" button. The screen says this out loud rather than
    greying out a control.
  - The tenant's INSERT/UPDATE grants are **column-scoped**; `updated_at` and
    `updated_by` are stamped by triggers from `auth.uid()`, so who moved the
    crew's morning is unforgeable at the grant layer.
- **`cron_runs` (0036) is the run log, and `notification_log` stays deny-all.**
  One row per company per job per day, carrying `due_hour` vs `ran_hour`/`ran_at`
  — the column that would have answered 2026-08-13 without a Vercel log — plus
  every exclusion count. It exists as its own table precisely because the
  interesting people have NO `notification_log` row: a worker without consent, an
  inactive crew row, a company with no manager account are never claimed, so no
  query over the send ledger can count them. Written by `recordCronRun`, which
  **swallows every failure** (it is a visibility record; a lost one must never
  cost a crew their morning) and rides the same `claims > 0` signal as the
  chat-thread note, with a `replace: false` write for the "nobody was claimable"
  case so estate-wide silence is recorded once.
  Tenants have SELECT and nothing else — a run row a tenant could write is not
  evidence of anything.
- **`company_send_history()` (0036) is the ONLY window into
  `notification_log`, and it is SECURITY DEFINER.** That table keeps its posture
  — RLS on, zero policies, direct `select` returns nothing to anybody — so the
  function's `auth.uid()`/company check is the ENTIRE tenant boundary, same
  shape as `open_task_review` and `set_task_collaborators`. **It checks the null
  case FIRST and RAISES**, never `if auth.uid() is not null and <company
  check>`, which fails OPEN on a null company and was exploit-confirmed against
  production (0021). For a READER, falling open hands an unonboarded stranger
  the whole estate's send ledger. `scripts/rls-isolation-matrix.mjs` carries
  `checkSendHistoryScope` — with a **positive control**, because every other
  check in that file asserts a refusal and a function returning nothing to
  anybody would pass all of them — plus the orphan attack on the null guard.
- **Meta's delivery statuses are persisted (0036, #51 B4), on a THIRD webhook
  shape.** `value.statuses` arrives on `field: 'messages'` with no `messages`
  array, which is why the pre-#51 router dropped every one silently and
  `status = 'sent'` could only ever mean "Meta accepted it".
  `routeWebhookChanges` now drains both arrays; `recordDeliveryStatuses` stamps
  `delivered_at` / `read_at` / `failed_at` / `delivery_error_code` on
  `notification_log`, **one column per callback and never derived from
  another** — Meta does not order them, so a `read` genuinely can precede its
  `delivered`. Those five columns are safe on that table for one specific
  reason: **they are never in `claimNotification`'s INSERT**, only in an UPDATE
  inside a catch, so a deploy landing before 0036 loses a status and sends
  nothing differently. Do not add any of them to the claim.
- **There is a second daily send: the late-afternoon check-in**, from
  `apps/web/app/api/cron/checkin`, same heartbeat/window/schedule shape. It asks
  "did you finish today's tasks?" as a template with two quick-reply buttons and
  records the tap in `worker_checkins`. Three things about it are load-bearing:
  it is **deterministic in both directions** (no model is called on this path at
  all); a tap is a **claim, never a completion** (see below); and it claims
  under `kind='task_checkin'` in `notification_log`, which is the only reason
  two sends can share a day under that table's unique constraint. Both routes
  share `apps/web/lib/cron.ts` for auth and the claim protocol — the parts where
  drift would be a correctness bug — and nothing else.

  **A "Sim, terminei" tap files a completion claim, one per task** (issue #54).
  This REPLACES the older promise that the check-in "records an answer and never
  writes `tasks.status`". It used to be literally true and it was the bug: the
  worker believed they had reported the job, the board still said pending, and
  Capo — which reads the board — agreed with the board. Three parties, three
  beliefs, nothing recording the disagreement.
  What changed and what did not:
  - `worker_checkins` still records the answer, unchanged, and is still the only
    thing "Ainda não" writes. **That branch files nothing. Keep it that way.**
  - The `done` branch calls `open_task_review` once **per task id in the ask's
    `notification_log.task_ids`**, on the SERVICE ROLE. So the task lands in
    `pending_review`, not `done` — a tap is not a verification, and
    `task_board.is_open` is a denylist so the task stays on the board and still
    goes overdue.
  - **The `notification_log` read in `handleCheckinTap` is the ENTIRE tenant
    boundary for that write.** `open_task_review` is SECURITY DEFINER and its
    guard is `if auth.uid() is not null and …`; there is no `auth.uid()` here,
    so the guard is skipped by design and the RPC will open a review on any uuid
    it is handed. The ownership read (`company_id` + `worker_id` + `kind`) is
    what proves the ids are this worker's. Do not move it, widen it, or add a
    caller that skips it.
  - **One task failing must never abort the others.** Already-`done` (0019) and
    already-pending (`task_reviews_one_pending_idx`) are ordinary outcomes for
    one row of a multi-task snapshot. The loop calls, catches and logs per task;
    `apps/web/lib/checkin-claim.ts` holds the pure classification and the
    acknowledgement choice, asserted by `pnpm whatsapp-check`.
  - **`p_note` is deliberately null.** A tap carries no worker text, so there is
    nothing to quote; a synthesised sentence would be app copy in a data column,
    in one language. `declared_by_worker_id` is the attribution.
  - `task_reviews_notify_pending` (0024) fires on this path with no edit — the
    trigger is `after insert on task_reviews` and its `is distinct from
    auth.uid()` means a service-role actor notifies every manager profile, which
    is also what sends the push (0026).
  - The acknowledgement **must never say "done"**. `checkinDoneAwaiting` /
    `checkinDoneNothing` / `checkinDoneProblem` in `@capo/i18n`; the old
    `checkinDone` is kept but unwired.
  The inbound tap is a **template quick reply** (`type: 'button'`, from a
  worker), a different shape from an approval card's **interactive reply
  button** (`type: 'interactive'`, from a manager). They are handled on
  different paths and their payload codecs are deliberately non-overlapping;
  conflating them is the mistake to watch for.

  **A tap now also ASKS FOR A PHOTO, and asking is all it does** (issue #52,
  migration `0034`). The button path filed claims with no proof while the worker
  agent's `declare_task_done` had required one at the schema level since #22 —
  two doors into `pending_review` disagreeing about evidence, with nothing
  telling the manager which door a claim came through. Six things:
  - **It is an INVITATION, never a requirement.** The claim is already filed and
    stands whether or not a photo arrives. Refusing to file one without proof
    would mean a worker who cannot photograph anything reports nothing at all,
    which is the state #54 exists to end. The copy says so out loud.
  - **`checkin_photo_requests` stages the EXPECTATION, never the BYTES.** There
    is no blob column and there must never be one. A photo's object key contains
    the task id, so bytes cannot be written until the task is known; the tap
    path knows it *before* the photo arrives, which is exactly what the agent
    path cannot do. The one-turn photo lifetime on the agent path is
    **unchanged**.
  - **ONE TASK AT A TIME.** An inbound image says nothing about which task it
    shows, so a three-task claim is asked three times, `next_index` walking the
    snapshot. A photo filed as proof of the wrong job is worse than no photo:
    it is evidence, it is wrong, and `0023` has no DELETE policy anywhere.
  - **A CAPTIONED photo is excluded and falls through to the agent.** A caption
    is words, and words can say something the deterministic branch cannot read.
    The bare-photo branch sits with the other taps, above the agent.
  - **Deny-all, like `notification_log` and not like `worker_checkins`.** RLS on,
    zero policies, every grant revoked. A tenant able to write one could redirect
    another crew member's next photo onto a task of their choosing.
    `scripts/rls-isolation-matrix.mjs` attacks insert, update and delete.
  - **The TTL is enforced by the READER and nothing sweeps the table.**
    `PHOTO_REQUEST_TTL_MS` is 3 hours: long enough for "I'll do it at the van",
    short enough that a request cannot survive to the next 07:00 briefing and
    file tomorrow's work as proof of yesterday's claim. It is deliberately
    **shorter** than Meta's free-form window, because the follow-up must never
    become a paid template. An unparseable `expires_at` reads as expired.

  **"Claimed without proof" is shown to the manager as a FACT, counted at read
  time.** `countTaskPhotos` (`apps/web/app/dashboard-data.ts`) feeds both the
  board's review control and the in-app inbox, so the two cannot disagree —
  the same reason push and inbox share one headline entry. Three things:
  - **Nothing is denormalised onto `task_reviews`.** A photo can arrive minutes
    after the claim, so anything stamped at insert time would say "no photo"
    forever and be wrong invisibly.
  - **The count is every photo on the task, no time filter and no source
    filter.** A time filter breaks the agent path, which writes photos *before*
    the review by design. The copy is correspondingly literal — "3 photos
    attached", a statement about the task.
  - **The PUSH deliberately carries none of it**, breaking the usual
    push/inbox symmetry on purpose: a push fires seconds after the claim, the
    one moment "no photo" is guaranteed true and guaranteed uninformative.
  `tasks.completion_proof` is still written, now by both crew paths as well as
  the sheet, and `0034` restates its comment: it answers "does this completion
  have photographic proof". NULL still means UNKNOWN, and only the manager,
  through the sheet, ever writes `'skipped'`.
- **Anything the manager or their crew is sent by the SYSTEM is written into the
  manager's chat thread, through ONE seam** (`recordThreadEvent` in
  `apps/web/app/notifications/thread.ts`, issue #47). Before it, the 07:00
  briefing route wrote a `role='event'` note inline and the late-afternoon
  check-in route wrote nothing — a habit rather than a rule, so the crew could
  be mid-conversation with Capo about a question Capo had no record of asking,
  and the manager had no way to tell which of the two was right. Five things:
  - **Five notes exist and that list is exhaustive**: the morning briefing
    (what today holds + who was actually messaged, by name), the check-in ask
    (who was asked), one note per crew member ANSWERING that check-in,
    since #45 the welcome (who Capo has just introduced itself to, crew only —
    a manager reads their own welcome on their own phone), and since #152 one
    note per crew REQUEST (who asked, when for, which task — never what they
    said).
    Renderers live beside the briefing renderers in `notifications/briefing.ts`
    because they need the user copy catalog, which must never enter the agent
    bundle — with one exception, `apps/web/lib/worker-request.ts`, which is
    there for the same reason (it needs the catalog and must stay out of the
    agent bundle) and additionally so `pnpm whatsapp-check` can pin the urgency
    arithmetic beside the two envelopes it feeds.
  - **What may be in a note is a SAFETY boundary, not a style question.** Our
    own copy, counts, crew names (typed by the MANAGER on `/perfil`) and which
    of two quick-reply buttons was tapped — an enum our own cron minted. Never
    worker-authored prose: not quoted, not summarised. `messages` is the table
    `loadWindow` → `toThread` → `thread.recentUserTexts` reads, and that is the
    evidence pool `runGuarded` matches a model quote against before executing a
    manager-level write directly. The `checkinAnswer` renderer takes exactly
    three inputs and the moment it grows a `note` parameter that boundary is
    gone. `scripts/rls-isolation-matrix.mjs` now seeds its worker tracer in
    `task_reviews.note` as well as in `worker_messages`, precisely because that
    column is where such a change would draw the text from.
  - **An event row is shown to the model but is NOT evidence.**
    `recentUserTexts` filters on `role === 'user'`; an event row is
    `role === 'event'` and reaches the model tagged `<system-event>`. That one
    clause is the whole protection and `pnpm guard-check` now asserts it in both
    directions — events excluded from evidence, and still present for the model.
  - **Idempotency is the CALLER's job, because `messages` has no lock.** Two
    invocations pass the send window every day (#51); `notification_log`'s
    unique constraint makes the sends safe but a thread note is a message. Both
    crons therefore gate the write on having WON at least one claim in that run.
    The check-in route gates on `claims > 0` **only** — deliberately no
    `targets === 0` branch, unlike the briefing: there it means a whole company
    is unreachable and is worth saying, here it means the crew had nothing on,
    which is most evenings. The webhook's answer note rides the existing
    `redelivery` gate, so a Meta retry cannot double-write it.
  - **Recording must never break a send.** `recordThreadEvent` swallows into one
    `thread.event_failed` line — same posture as `loadCompanySnapshot`. The cost
    is that a revoked grant presents as a thread that quietly stops filling up;
    grep that event before concluding a quiet thread means a quiet day.
  Known and NOT done: approval-card renderings and Web Push deliveries still
  have no note of their own. Cards are partly covered already (the assistant
  turn is persisted, and `finalize_proposal` writes the resolution event in the
  same transaction as the status flip), and a push is a delivery of a
  `notifications` row rather than a separate message.
- **`/dia` is the crew day page, and its whole authorisation is a bearer token
  in the URL** (`worker_day_links`, migration `0039`, issue #114). A crew member
  taps a link in their morning message and reads today's work — and the work
  that is already late — with nothing to install and nothing to log into. It is
  the only screen in the product a person with no `auth` identity ever reads,
  which is why almost everything about it is a boundary decision:
  - **It exists for the tasks the 07:00 message structurally CANNOT carry.**
    `task_board.active_today` is `today between window_start and
    coalesce(due_date, 'infinity')` (0013), so a task whose deadline has passed
    has `active_today = false` and is in NEITHER daily send. The manager sees it
    under Atrasadas; the person doing the work has never been told. The page's
    `overdue_tasks` bucket is the first surface that tells them, which is why it
    renders ABOVE today's work rather than as a badge inside it.
  - **ONE fan-out, two buckets.** `fanOutTasks` (`notifications/briefing.ts`) is
    extracted from `loadCompanyBriefing` and used by both, and the page renders
    through `taskHeadline` / `taskDetailLines` — the same functions the WhatsApp
    message uses. Two fan-outs or two renderers would let a helper read "a
    ajudar Miguel" in WhatsApp and "em equipa" on the page with no way to tell
    which was right. The CALLER decides which rows to fan out; the definition of
    a task is not re-derived anywhere.
  - **A row IS a credential, not a record of one**, which is what makes 0039
    unlike the other deny-all tables. RLS on, zero policies, every grant revoked
    from `anon` and `authenticated`: a tenant who could READ one would hold
    their crew's live tokens, and one who could WRITE one could mint a page
    credential that never goes over WhatsApp at all, so the crew member has no
    way to know it exists. `scripts/rls-isolation-matrix.mjs` attacks read,
    insert, update, delete, and the cross-company FK trigger.
  - **The expiry is a DAY BOUNDARY, never a duration.** The page reads the LIVE
    board (right: an afternoon reader needs the afternoon's truth), so a token
    that outlived its Lisbon day would go on exposing tomorrow's work — #114
    settles that a leaked link exposes today only. `lisbonDayEnd` computes it
    from `lisbon_today()`'s own answer, and `pnpm scheduler-check` pins both DST
    seasons plus both transition days, then derives the property that matters: a
    link is alive all evening and dead before the next briefing, every day of a
    year. Enforced by the READER, and **nothing sweeps the table** — a sweep
    that fails leaves live credentials behind and says nothing.
  - **The CTA is free-form ONLY, and the consequence is stated rather than
    hidden.** `toTemplateParam` flattens all whitespace and `capo_daily_briefing`
    is pinned to `{{1}}`/`{{2}}` with no button component, so a template cannot
    carry a link without a new template and a manual Meta approval. A crew
    member outside the 23-hour window therefore gets no link that morning — they
    are also, by definition, somebody who has never written to Capo, so it
    arrives the first time they do. Making it reachable from the template path
    is its own follow-up.
  - **The link is reserved from the character budget BEFORE the blocks are laid
    out**, never appended after the clamp. Appended after, a rich day truncates
    the URL into a dead string — a link that looks like a link, goes nowhere,
    and does so only for the busiest people on the crew. `pnpm whatsapp-check`
    asserts an intact URL on a pathological briefing in all three languages.
  - **`mintDayLinks` and the page's own writes never throw.** One upsert and one
    read per company, made idempotent by `worker_day_links_worker_date_idx`
    rather than by checking first (two invocations pass the send window every
    day, #51). Every failure is swallowed into `day_link.mint_failed` and the
    briefing goes out without the line. Grep that event before concluding
    nobody uses the page.
  - **`/dia` sits at the top level, not under `(public)`.** That group's layout
    renders `LanguageSwitch`, which writes the visitor's locale COOKIE; this
    page's language is `workers.language ?? companies.language`, the third dial.
    A switch there would silently disagree with every WhatsApp message the same
    person gets — the drift #55 exists to stop. `lang` is set on the page's own
    subtree because the root layout stamps the visitor's locale on `<html>`.
  - **The page has no control on it and says so.** Declaring a task finished
    goes through WhatsApp, where Capo can ask for a photo and file the claim
    against the right task; a button here would need a write path authorised by
    a token in a URL. `force-dynamic`, `noindex`/`nofollow`, and `/dia`
    disallowed in `robots.txt`.
  Known and NOT done: a link tapped after Lisbon midnight is dead and the next
  one does not arrive until 07:00 — a real gap for a night shift, and the price
  of the "today only" rule. Nothing lets a crew member request a fresh link, and
  the manager has no screen showing who has opened theirs (`opened_count` is
  recorded and read by nobody yet).
- **There is a THIRD proactive send: the welcome, and it is a SWEEP, not a
  hook** (`apps/web/app/api/cron/welcome`, migration `0033`, issue #45). Capo
  introduces itself to a person the first time it is legally allowed to message
  them, once, ever. Seven things are load-bearing:
  - **CONSENT COMES FIRST, AND THAT ORDER IS FORCED RATHER THAN CHOSEN.** The
    obvious design — make the welcome the message that ASKS to be allowed to
    write — is not available: a proactive template to somebody with no recorded
    opt-in is the exact violation `0025` exists to prevent, and Meta's policy
    says the opt-in is gathered through the business's own channels. So consent
    is collected off WhatsApp (manager asks on site → `update_worker`, or
    `/perfil` for their own number) and the welcome CONFIRMS it and states the
    opt-out. **No copy in `welcome.ts` or in the template may ask a yes/no
    question.** A worker with no consent is not "waiting for a welcome" — they
    are waiting for their manager, for as long as that takes.
  - **A sweep asks a question; a hook has to remember an event.** A number can
    enter the system through onboarding, `/perfil`, `add_worker`, `update_worker`
    or a `START` reply, and consent can be recorded weeks after the number. A
    hook on each door is a door somebody forgets, silently. The sweep asks "who
    may be messaged and has never been introduced?" every fifteen minutes, so
    every door leads to it and none has to know it exists. Same reasoning as
    `/api/cron/push`.
  - **Idempotency is `notification_log`, with the DATE removed.** `0033` adds a
    partial unique index `(worker_id, profile_id) nulls not distinct where kind
    = 'welcome'` — the daily lock's shape minus `notification_date` — and `0041`
    narrows it with `and status <> 'failed'` (issue #121): a FAILED welcome
    releases its once-ever claim so the sweep can try again, while `sent`,
    `skipped` and `pending` rows block forever. 0033's backfill rows are all
    `skipped`, so the mass-mail protection survives the narrowing BY
    CONSTRUCTION. The
    already-welcomed read in `loadPendingWelcomes` is an OPTIMISATION so the
    sweep does not attempt a doomed INSERT per person per run; the INDEX is the
    lock, through `claimNotification`'s 23505 → null. Do not trust the read and
    do not add app-level state beside it — with ONE exception, which is #121's
    retry policy (`apps/web/lib/welcome-retry.ts`, pinned by `pnpm
    whatsapp-check`): at most `WELCOME_MAX_ATTEMPTS` (3) failed rows per
    person, only while the NEWEST failure's Meta code classifies as retryable
    (132001 — template missing, a config error that becomes fixable; an
    invalid recipient and anything unclassifiable are permanent, failing
    CLOSED because a retry is a paid template), and at most one attempt per
    Lisbon day. The per-day bound is also 0016's daily unique key, but the CAP
    and the classification exist nowhere in the schema — that filter is
    policy, not optimisation, and removing it retries a dead number daily
    forever.
  - **The `0033` backfill was mandatory**, exactly as `0026`'s `pushed_at` one
    was: it marks every worker and profile that existed when it was applied as
    `skipped`, or the first deploy introduces Capo by paid template to everybody
    already using it. Any future feature that adds a "have we done this yet?"
    marker to a populated table needs the same.
  - **`welcome_ledger_ready()` is a DEPLOY GATE, and it fails closed.** A marker
    function `0033` creates and the route asks for before it sends anything —
    because on this project a migration has been skipped in production while a
    later one was applied, and the code shipping without its migration is
    precisely the mass-mailing failure. Missing function → 503, no sends.
  - **The hour gate is WIDE (Lisbon 09:00–19:59) and starts after the briefing
    window closes.** It exists for quiet hours, not for punctuality: a first-ever
    message from an unknown business number at 03:00 is how that number earns a
    block report. Eleven hours wide with a `*/15` schedule means cron drift costs
    lateness, never silence, which is also why the `:00`-not-`:30` rule does not
    bind here — it exists for one-hour windows. `pnpm scheduler-check` asserts
    the window, the schedule and the fact that 09 > the briefing's window end.
  - **ONE template, `capo_welcome`, two audiences, and the difference lives in
    `{{2}}`.** A template body is frozen at approval; `{{2}}` is ours. That is
    #49's lesson applied in advance. Its fixed halves are BUILT from
    `reminders.welcomeGreeting`/`welcomeStop`, because the same welcome goes out
    as free text to anybody already inside their 24h window, and two copies of
    an introduction would drift; `pnpm whatsapp-check` asserts the rejoin.
  Known and NOT fixed: a crew member added and consented between midnight and
  07:00 gets their first briefing BEFORE their welcome. Fixing it means the
  morning send reading the welcome ledger, which couples it to a feature it has
  nothing to do with.
- **The welcome now goes out AT ONCE, and the sweep is still the mechanism.**
  `runWelcomeSweep(db, { companyId?, window })` in
  `apps/web/app/notifications/welcome-sweep.ts` is the whole send, and the cron
  route is a shell over it. Four request paths call it from `after()` for their
  own company the moment a manager could have made somebody messageable: the
  chat turn, the WhatsApp manager turn, `/perfil` saving consent or a phone, and
  an approved card. Five things:
  - **The trigger is an OPTIMISATION, exactly as the immediate `dispatchPushes`
    call is.** It takes ONLY a company id and asks the sweep the same question
    the cron asks; it never remembers an event, never queues and never writes
    app state. Delete every call site and the product still welcomes everybody,
    at 09:00 at the latest. That is what lets a sixth door be added with no hook
    at all, and it is why `welcomeAnyoneNew` swallows every failure into one log
    line.
  - **The immediate gate is WIDER than the sweep's and the two must not be
    collapsed** (`apps/web/lib/welcome-window.ts`): Lisbon 08:00-21:59 against
    the sweep's 09:00-19:59. A manager adding somebody at 20:15 is standing next
    to them; making that person wait for 09:00 tomorrow is the complaint the
    feature answers. Outside the gate the trigger does NOTHING and logs
    `welcome.outside_send_hour`; the cron picks the person up. `pnpm
    scheduler-check` derives the containment property (every hour the sweep may
    send in, the trigger may too) rather than pinning it.
  - **Idempotency is UNCHANGED and is still 0033's partial unique index.** Four
    call sites racing each other inside one request, and a trigger racing the
    cron, all lose to `claimNotification`'s 23505. Nothing here is made safe by
    remembering anything.
  - **It runs on the SERVICE ROLE inside a tenant request**, which is the
    system-vs-user split's documented shape for a system job a request starts
    (`dispatchPushes` again): the welcome writes `notification_log`, which
    tenants hold no grant on. The company id comes from the caller's
    authenticated session AND is intersected with `billableCompanies`, so a
    wrong id reaches nobody.
  - **The crew welcome opens with WHO ADDED THEM**, from the most recently
    created named profile, read off the profiles list `loadPendingWelcomes`
    already orders. NULL is a real answer (no profile yet, a blank `full_name`)
    and the clause is then OMITTED, never filled with a placeholder naming
    nobody. It lives in `{{2}}`, so it needs no Meta re-approval.
    **The rule is `pickAccountOwnerName` in `@capo/db`, not in either app**
    (`posture.ts`'s slot and reasoning): the operator's "resend a failed
    welcome" button renders this message a SECOND time and apps may not import
    each other, so without one shared home the two would drift — and the people
    who would read the colder wording are exactly the people whose first
    welcome failed. It is pure and takes a created_at-ASCENDING list, which is
    what lets the sweep answer it from the profiles it already fetched.
    `pnpm whatsapp-check` asserts the two renderings are byte-identical, which
    is the ONE assertion in that file that reaches into apps/operator.
- **The welcome ends in a "Say hi" button, and `capo:hi` is the FOURTH tappable
  payload.** `capo_welcome_v2` is `capo_welcome`'s body byte for byte plus ONE
  quick reply; the free-form twin sends the same button as an interactive
  reply-buttons message. Five things:
  - **The template NAME and the BUTTON are decided together**, by one call to
    `welcomeTemplateFor` (`apps/web/lib/welcome-template.ts`,
    `BRIEFING_V2_APPROVED_LANGUAGES`' shape and reasoning). A button component
    against a template that declares none is a 132000 on every send; NO button
    component against one that does makes Meta accept the send and echo the
    button's own LABEL back as the payload, so the tap parses as nothing.
    `WELCOME_V2_APPROVED_LANGUAGES` holds every locale Meta has approved by hand
    (all three since 2026-09-03); an unapproved one keeps sending the
    button-less `capo_welcome`, and that fallback must stay for the language
    added to `@capo/i18n` ahead of its template.
  - **A quick-reply LABEL may hold no emoji**, no variable, no newline and no
    formatted character. Meta refuses the submission with `error_subcode`
    2388060, which is how this button lost the waving hand it was written with.
    Nothing in a build catches it, so `pnpm whatsapp-check` pins it for every
    buttoned template.
  - **`capo:hi` arrives on TWO envelope fields** — `button.payload` from the
    template and `interactive.button_reply.id` from the twin — and is one
    payload for both, because "the person said hello" is one fact. It carries no
    id, for `workerMenuRowId('manager')`'s reason, and is an exact whole-string
    match so no other parser can accept it. It is consulted FIRST on both sender
    paths: below the other handlers, every hello would log
    `whatsapp.unknown_checkin_payload` or `whatsapp.unknown_button`, which are
    the two lines that are supposed to mean a template lost its buttons.
    **`isHiTap` lives beside the payload in `channels/whatsapp.ts`**, not in the
    route, for `parseProposalButtonId`'s reason: it is the only place
    `pnpm whatsapp-check` can pin BOTH envelopes with no credentials, and the
    free-form half's failure is otherwise silent because the template half goes
    on working.
  - **A proactive send records its `provider_message_id`, whatever the
    envelope.** `sendWhatsAppButtons` returns it exactly as
    `sendWhatsAppText`/`sendWhatsAppTemplate`/`sendWhatsAppList` do, because
    `recordDeliveryStatuses` matches Meta's delivered/read/failed callbacks
    against `notification_log` by that column alone. A send that dropped it
    would look successful and be permanently un-stampable.
  - **The answer is deterministic, with zero model calls**
    (`apps/web/app/notifications/welcome-hi.ts`), and it renders the crew
    member's tasks through the SAME `loadWorkerBriefing` / `renderWorkerFreeForm`
    the 07:00 message uses. `WorkerFreeFormOptions.opening` exists only because
    that renderer's greeting is a GOOD MORNING and this tap can land at 20:00 —
    a second renderer would let the two surfaces describe one task differently.
  - **A failure is never answered with a template.** The tap opened the free
    window, so 131047 is logged and swallowed and the fallback is the greeting
    alone: a paid recovery send for a greeting is not worth it, and silence
    after a button we asked them to press is the thing to avoid.
- **Sender identity is the PHONE, with the BSUID as a fallback — in that order,
  and the order is the safety property.** WhatsApp usernames mean Meta omits
  `from` entirely for anyone who has adopted one and sends only `from_user_id`,
  a business-scoped user id (`PT.13491208655302741918`). The webhook therefore
  runs four lookups, stopping at the first hit: `profiles.phone`,
  `profiles.whatsapp_user_id`, `workers.phone`, `workers.whatsapp_user_id`
  (0022, migrations #27/#28). Phone-first is what makes steps 1 and 3
  byte-identical to what the route has always run, so nothing about reading a
  second key can regress traffic that already works. `readSender` in
  `packages/core/src/channels/whatsapp.ts` is where that preference lives —
  there rather than in the route so `pnpm whatsapp-check` can pin it, which is
  the only place it is checked at all. Four things follow:
  - **The BSUID lookups are SEPARATE QUERIES, never widened column lists on the
    phone lookups.** Adding `whatsapp_user_id` to the working `select` couples
    sender resolution to the migration: a deploy landing first 42703s and every
    manager becomes an unknown sender. As their own queries the same failure
    costs only the fallback. Same reasoning as `captureBsuid`.
  - **A BSUID is NOT a tenant boundary and does not weaken one.** It is scoped
    to our business PORTFOLIO, not to a customer company, so it is exactly as
    tenant-ambiguous as the phone it replaces. `company_id` still comes from the
    matched row; RLS is still the boundary. `workers.whatsapp_user_id` is
    non-unique for the same reason `workers.phone` is, so its lookup carries the
    same `.limit(2)` → `whatsapp.worker_ambiguous` → stay-silent guard.
    **Keep that guard, and do not tie-break it.** It was once the only thing
    standing between a forged crew row and a wrong-tenant answer: 0025 revoked
    the table-wide UPDATE and re-granted a column list excluding this one, but
    `authenticated` still held a table-wide INSERT while `workers_insert_company`
    constrains only `company_id`, so a tenant could CREATE a crew row carrying
    another company's worker's BSUID. **0028 closed that** with a column-scoped
    INSERT grant — the seven columns 0025 allows editing, plus `company_id`.
    The guard is now defence in depth rather than the boundary itself, and it
    still earns its place: `workers.whatsapp_user_id` carries no unique
    constraint, and the service role can produce a duplicate through a bug, a
    backfill, or a rotation racing an initial capture.
    `profiles.whatsapp_user_id` has no equivalent hole — but **not for the
    reason long recorded here.** It is `unique` and absent from the tenant's
    UPDATE grant, both true; its INSERT grant, however, *does* still include
    the column. What actually refuses the write is that `profiles` has **no
    INSERT policy at all**, and under RLS an INSERT with no permissive policy
    is refused outright (rows come from `complete_onboarding()`, SECURITY
    DEFINER). That protection is load-bearing and invisible: adding an INSERT
    policy to `profiles` for any reason reopens the stale grant on the side
    that has data behind it.
  - **BSUIDs ROTATE.** Changing a phone number regenerates one, and Meta
    announces it on a webhook change whose `field` is `user_id_update` and which
    carries NO `messages` array — so the pre-#28 parser dropped every rotation
    without a trace. `routeWebhookChanges` splits a batch into messages,
    rotations and unhandled fields; `applyBsuidRotation` rewrites `previous` →
    `current` on both tables and logs `whatsapp.bsuid_rotation_orphan` when it
    matches nothing, which is the only signal that we just lost somebody.
    **The app must be SUBSCRIBED to `user_id_update` in the Meta App
    Dashboard** — code alone makes none of these arrive
    (`docs/whatsapp-cloud-api-runbook.md`).
  - **Outbound, a BSUID goes in `recipient`, never in `to`.** Sending both is
    legal and `to` silently wins, so the wrong shape does not fail — it delivers
    to a stale number and reports success. `WhatsAppRecipient` is a discriminated
    union for that reason, `buildSendBody` emits one field xor the other, and
    `toSendTarget`'s phone-digit surgery is unexported so no BSUID can reach it.
  - **Parent BSUIDs (`US.ENT.…`) are deliberately unsupported.** They belong to
    multi-portfolio businesses; Capo is one portfolio. `isBsuid`'s single-dot
    rule rejects the shape, the same rule is a CHECK constraint on both columns,
    and `parent_user_id` is parsed and dropped wherever it appears. Storing one
    would look like an identity while belonging to nobody in particular.
- **A phone number is an IDENTITY, stored exactly as WhatsApp writes it, and
  there is ONE normalizer** (`packages/core/src/channels/phone.ts`, `pnpm
  phone-check`). Outbound, `toSendTarget()` strips the `+` and hands the rest to
  Meta as the wa_id; inbound, the webhook matches `+<wa_id>` against
  `profiles.phone` / `workers.phone` as an EXACT STRING. So a number in a shape
  WhatsApp does not use is not slightly wrong: that person receives nothing and
  is heard by nobody, with no error, no log line and no failed row, while every
  screen goes on showing the number as if it were fine. On 2026-08-12 the
  manager's own number was re-saved on `/perfil` without the Argentine 9 and
  inbound WhatsApp went totally silent. Five things:
  - **Argentina carries a 9 that nobody in Argentina writes.** WhatsApp knows an
    Argentine mobile as `+54 9 <area> <subscriber>`; people write
    `+54 11 7887 6189`, or locally `011 15 7887 6189` where the 0 is the trunk
    prefix and the `15` is the legacy mobile marker the 9 replaced. All three
    must land on `+5491178876189`, and `argentineNational()` is the only place
    that arithmetic exists.
  - **The two duplicated `normalizePhone` copies are GONE.** Both web forms and
    both crew chat tools now go through this file: the forms through
    `composeE164(iso, national)`, `add_worker`/`update_worker` through
    `canonicalizeE164` run AFTER zod. A second copy of this rule would drift,
    and the symptom of a drift is silence rather than an error.
  - **`splitE164` shows Argentina WITHOUT the 9**, because the 9 is not part of
    the number anybody there knows and seeing it invites a manager to "fix" it.
    Composing puts it back; the round trip is pinned. Getting this wrong is
    worse than getting `composeE164` wrong: it corrupts a number that was
    already correct, the moment somebody opens the form to change their NAME.
  - **Both functions PASS THROUGH what they cannot explain, never mangle it.**
    A country outside the five in `PHONE_COUNTRIES` typed in full with its `+`
    is stored verbatim (the picker must not become a wall), a `+54` number of an
    unexplainable length is left alone, and `canonicalizeE164` is idempotent.
    The accepted cost, stated rather than hidden: an Argentine LANDLINE would
    have a 9 inserted it does not want. WhatsApp is a mobile channel and that
    trade was made deliberately.
  - **The country picker is a native `<select>` with no client JavaScript**
    (`apps/web/app/_ui/phone-field.tsx`, no `'use client'`, no hooks), so the
    server-rendered onboarding form still posts before hydration. It submits two
    plain fields, `country` + the existing phone field name; a post with no
    `country` (older cached HTML) falls back to `defaultCountryFor(locale)`,
    which is the pre-picker behaviour.
- **Worker text NEVER reaches the MANAGER's agent context** (migration `0027`,
  issue #22). This REPLACES the older and stronger promise that a worker's text
  never reached a model at all. It does now: crew members talk to a second,
  restricted agent (`packages/core/src/agent/worker-core.ts`), which is the
  first place untrusted text enters a model in this codebase — and there is no
  `auth.uid()` on that path, so RLS backstops nothing.

  The mechanism is SEPARATE TABLES, not a filter. Worker turns live in
  `worker_conversations` / `worker_messages`; the manager's live in
  `conversations` / `messages`. The reason is one specific escalation:
  `messages` feeds `loadWindow` → `toThread` → `thread.recentUserTexts` (the
  last three user rows) → `ToolContext.recentUserTexts` → `runGuarded`, which
  authorizes a DIRECT manager-level write whenever the model can quote the
  manager. A worker with a row in `messages` would not be persuading the
  manager's agent of anything — they would be WRITING the evidence its
  authorization check reads. A nullable `worker_id` column would make that a
  filter every future read path has to remember; separate tables make it a
  query that does not exist.
  `scripts/rls-isolation-matrix.mjs`'s `checkWorkerTextIsolation` sweeps
  `messages`, `conversation_summaries`, `memories` and `proposals` for a seeded
  tracer on the service role — the only way to ask whether the text was ever
  WRITTEN there, rather than merely whether RLS hides it. The tracer is seeded
  in every column where crew prose legitimately lives, because those are the
  ones a well-meaning "let's also quote what they said" change would draw from:
  `worker_messages`, `task_reviews.note`, `problem_reports.text` (#120) and
  `worker_requests.text` (#152).

  `handleInbound` and the manager `roster` are **not modified** by this feature.
  If a change needs to touch either, the isolation design has gone wrong.
- **A problem report is MAIL TO THE OPERATOR, never conversation** (migration
  `0042`, issue #120). "Reportar um problema" on `/perfil` and the `bug` /
  `problema` / `erro` keyword on WhatsApp (both sender kinds) file free text
  into `problem_reports`, read ONLY in apps/operator — tenants hold no SELECT
  on it at all, because a crew member's report may be about the manager (#128).
  Five things are load-bearing:
  - **The keyword flow is deterministic and runs in FRONT of both agents**
    (`apps/web/lib/problem-report-flow.ts`): a report that Capo is misbehaving
    must never depend on Capo's model behaving (the 31 Aug outage, #126). On
    the manager branch it sits above `handleInbound`; on the worker branch it
    sits with the other keyword tables, below consent (STOP must always
    unsubscribe) and above everything else.
  - **`REPORT_KEYWORDS` is the fourth table in `worker-keywords.ts` and the
    ONE exception to the whole-message rule**: the keyword as FIRST WORD files
    the rest of the same message immediately. The accepted false positive
    ("problema resolvido" is filed, visibly acknowledged) is pinned in `pnpm
    whatsapp-check` along with every table pair's disjointness.
  - **A bare keyword arms `problem_report_requests`** — "your next message is
    the report", 0034's staging shape: stages the expectation never the text,
    deny-all, at most one open row per sender, TTL 30 min enforced by the
    READER, nothing sweeps it.
  - **Report text lands in `problem_reports.text` and NOWHERE else** — never
    `messages`, `worker_messages`, thread notes, summaries, memories,
    proposals, or logs. The manager's own report stays out of `messages` too:
    it is not conversation, and it keeps `checkWorkerTextIsolation`'s story
    uniform (the matrix seeds its worker tracer through a report).
  - **The app path writes on the tenant's own RLS client** through an INSERT
    policy + column-scoped grant (`company_id, profile_id, text, context` —
    `worker_id` and `channel` are withheld at the grant layer; channel defaults
    to `'app'`). Write-only, so the insert must never chain `.select()` (the
    ai_usage trap). Deliberately no status/triage columns — that is a later
    decision (#120), taken once reports actually arrive.
- **The crew can ASK FOR SOMETHING, and Capo gets it to the manager ranked by
  when it is needed** (`worker_requests`, migration `0043`, issue #152). This
  REVERSES a deliberate design: until it landed, "diz ao chefe que preciso de
  mais tinta" was answered with a refusal, written down in the crew persona's
  worked example and in the worker policy, and TRUE — the roster had four tools
  and none reached the manager. Six things:
  - **A request is its OWN record, never a `tasks` row.** `tasks` is crew work:
    it has an assignee and flows into `task_board`, the 07:00 briefing, the
    check-in and — through `materials` — the buy list. A manager to-do dropped
    in there appears in reads never meant to see it, and a request for paint
    arrives as a material on a task nobody is doing. Turning a request into a
    real task is a later tap and an ordinary `create_task`; nothing does it
    automatically.
  - **Urgency is a DATE and plain subtraction, never the model judging tone.**
    `ask_manager` captures `needed_by`; `describeUrgency` in
    `apps/web/lib/worker-request.ts` subtracts `lisbon_today()` from it. The
    null is UNDATED and is SHOWN as undated — Capo asks once, in one line, and
    never guesses. Guessing high cries wolf until the manager stops looking;
    guessing low buries the one that mattered. `pnpm whatsapp-check` pins every
    branch, both DST transitions included.
  - **`worker_requests.text` is the THIRD legitimate home for worker-authored
    prose**, after `worker_messages` (0027) and `task_reviews.note` (0018), and
    it inherits their rule: rendered to the manager as an ATTRIBUTED QUOTE on
    all three surfaces, and never copied into `messages`,
    `conversation_summaries`, `memories` or `proposals`. The manager's
    chat-thread note may SUMMARISE and never quote — `renderRequestEvent` takes
    a name, a date and a task title and has no parameter the words could go in,
    the same shape `renderCheckinAnswerEvent` keeps and for the same reason.
    `checkWorkerTextIsolation` seeds its tracer here too.
  - **The WhatsApp half is built for the FREE case only, deliberately.** Inside
    the manager's own 24-hour window (`withinFreeFormWindow`, plus
    `hasWhatsAppConsent`, both fail-closed) an ordinary free-form line goes out.
    OUTSIDE it, NOTHING is sent: free-form is refused 131047 and the only legal
    contact is a pre-approved template that does not exist —
    `capo_message_waiting` is NOT it (submitted for #123 B, aimed at a worker,
    and its code half does not exist). The manager still gets the request
    immediately and for free through the inbox and Web Push, which is why that
    path carries the weight.
  - **`manager_notified_at` is the queue, notifications.pushed_at's shape.** No
    outbound ledger, and deliberately NOT `notification_log` — that table is the
    PAID TEMPLATE ledger and its unique key is what prevents a double-billed
    send. The sweep runs after every crew agent turn off a partial index, so
    the cost on a turn with no request is one indexed miss.
  - **No resolution marker, and that is problem_reports' decision (0042).** A
    status column added before anything writes it is a promise the product does
    not make. Home therefore shows requests by FRESHNESS (seven days) and the
    inbox keeps them for ever with its own read state. The honest cost: a
    request for next month drops off Home while still unfulfilled. Closing the
    loop back DOWN to the crew member ("handled") is the flagged follow-up —
    it needs a manager action that produces a proactive send, which outside the
    window is a paid template that does not exist.
- **The worker roster is an ALLOWLIST in its own type system, never a filter
  over `roster`.** `packages/core/src/capabilities/worker/` holds five tools
  (`my_tasks`, `search_knowledge`, `declare_task_done`, `set_my_language`,
  `ask_manager`) in a separate array in a separate file. `roster.filter(...)` would be a denylist by
  accident: `capabilities/index.ts` is an array that grows, and the next tool
  appended there would land in a worker's hands silently, in a commit about
  something else.

  The separation is enforced by `tsc`, not by review. `WorkerTool` requires
  `audience: 'worker'` (absent from `CapoTool`) and an `execute` **property**
  — not a method, because TypeScript checks method parameters bivariantly even
  under `strictFunctionTypes` — taking a `WorkerContext`. `WorkerContext` and
  `ToolContext` are MUTUALLY UNASSIGNABLE: each requires fields the other lacks.
  Both directions have been verified to fail `tsc --noEmit`.

  Three absences carry weight. `WorkerTool` has **no `guarded` field at all**
  (not `guarded?: never`) — the guard authorizes against the manager's own
  words, and there is no manager in that loop. `WorkerContext` has **no
  `userId`, no `actor`, no `recentUserTexts`**, which is precisely why a worker
  tool cannot call `createProposal`: it cannot construct the `ToolContext` that
  function's signature demands, so the escalation to "manufacture an approval
  card for the manager to tap" is closed by the type checker.

  `declare_task_done` requires `photo_ids` with `.min(1)` **at the schema
  level**, never by prompt instruction: a prompt rule is negotiable by anyone
  who can write text, and that is exactly who is on the other end. It writes
  photos BEFORE filing the claim, because a claim with no proof is the state
  the requirement exists to prevent, while proof with no claim is merely untidy.
  Photos are **never shown to a model** — the agent learns only how many
  arrived.
  Known limit, stated rather than hidden: photos live for ONE turn **on this
  path**, because a task photo's object key contains the task id and the task is
  not known until the tool names it. "Photo, then a separate message saying
  which task" loses the photo. #52's `checkin_photo_requests` is a staging area
  keyed on the worker, but it stages the EXPECTATION rather than the bytes and
  only works because the check-in tap knows the task *before* the photo — so it
  does not lift this limit, and it is not a design to copy here without solving
  the byte problem too.
  Both crew paths share ONE writer, `storeWorkerTaskPhoto` /
  `markTaskProofPhotos` in `packages/core/src/media/task-photo-store.ts`: what a
  `source: 'worker'` row asserts is an ATTRIBUTION the grant layer makes
  unforgeable, and two copies of a claim like that would eventually disagree.
- **The crew channel is GUIDED FIRST and conversational second** (issue #49).
  Federico's complaint was three complaints and the fixes are independent, so
  they are recorded separately — but they share one shape: the cheap
  deterministic thing happens in front of the model, never instead of it.
  - **The 07:00 briefing shows the site ADDRESS and what a task waits on.**
    `job_address` (appended to `task_board` by 0027) and `depends_on_titles`
    were both in the view and read by nothing that spoke to a crew member. They
    render through `taskDetailLines` in `notifications/briefing.ts` — **one
    function, two surfaces**: the free-form briefing and the guided menu's task
    sheet. Two renderers would drift, and a crew member reading both would have
    no way to tell which was right. `BRIEFABLE` is **UNCHANGED**: still an
    allowlist of `pending`/`in_progress`, so both daily sends are untouched.
  - **The language line is CONDITIONAL, and half the fix is not in this repo.**
    "Responde PT, ES ou EN" lived in the approved template BODY, which is fixed
    at approval time — that is why it was on every message and why no code could
    stop it. It moved into the `{{2}}` parameter
    (`reminders.languageHint` + `renderWorkerBriefing`'s `languageHint` option),
    shown only when `!hasChosenLanguage && lastInboundAt === null`. Both facts
    were already loaded, so **no migration**. It can only ever appear on the
    TEMPLATE path, and that falls out of the same predicate rather than being
    enforced twice. ⚠ The live template still carries the old sentence until
    it is re-approved by hand in WhatsApp Manager; until then a first-contact
    worker reads it twice (runbook §6a).
  - **The guided menu is an interactive LIST, answered with zero model calls.**
    `notifications/worker-menu.ts` builds it; `handleWorkerMenuTap` answers a
    row. Reached by the `MENU_KEYWORDS` keyword or by tapping the 07:00
    briefing when it went out as a list. Five load-bearing things:
    - **It is the THIRD tappable shape and the SECOND under
      `type: 'interactive'`.** Nothing about the handler layout keeps it apart
      from a manager's approval card — only that `capo:wm:`, `capo:checkin:`
      and `capo:approve|reject:` are pairwise non-overlapping. `pnpm
      whatsapp-check` asserts all six directions; a fourth codec must extend
      them rather than assume them.
    - **The tenant boundary is a TypeScript filter, and RLS backstops nothing.**
      No `auth.uid()` on the webhook, so `findWorkerTask` reads this worker's
      own rows (company_id + assignee_worker_id, both phone-derived) and looks
      for the tapped id INSIDE that result. Never `.eq('id', tappedId)` — that
      would be an existence oracle. `checkWorkerMenuScope` in
      `scripts/rls-isolation-matrix.mjs` attacks it, including from a COLLEAGUE
      in the same company, which is the case only `assignee_worker_id` refuses.
      That check is a hand-copied duplicate of the real query (the matrix is
      plain `.mjs`); change one, change the other.
    - **`MAX_LIST_BODY` is the CONSERVATIVE 1024.** Meta's own reference page
      says 4096 and every third-party summary says 1024. Being wrong downward
      costs a briefing that degrades to plain text; being wrong upward is a 400
      at 07:00 and a crew that hears nothing. `listFits` exists so the send
      decides BEFORE building rather than catching a throw, and
      `buildListPayload` THROWS on structural overruns while CLAMPING cosmetic
      ones — the same split `toTemplateParam`/`assertQuickReplyPayload` make.
    - **An interactive message is a session message, so it is FREE** — and
      refused outright (131047) outside the 24h window, exactly like free-form
      text. `deliverBriefing` therefore falls back list → text → template, and
      only the out-of-window error reaches the paid template; any other list
      failure is a bug in OUR payload and must cost plain text, never silence.
    - **The menu reads `is_open` (a denylist) while the briefing reads
      `BRIEFABLE` (an allowlist)**, so a task already declared finished appears
      in the menu — marked as waiting on the manager — and in neither daily
      send. That asymmetry is the board's own and is deliberate.
  - The three keyword tables moved out of the route into
    `apps/web/lib/worker-keywords.ts` so `pnpm whatsapp-check` can assert they
    stay pairwise disjoint. **Only the location moved.** The ORDER still lives
    in `handleWorkerReply`, and it is the order that keeps the model last.
  - Known and NOT fixed: **a person who is BOTH a manager and an active crew row
    gets silence on a menu tap.** Sender resolution tries `profiles` first, so
    their `list_reply` lands on the manager's `interactive` branch, finds no
    `button_reply`, logs `whatsapp.unsupported_interactive` and stops. This is
    the same dead end the check-in's `type: 'button'` tap already has for that
    person, not a new class — but it is the configuration a pilot foreman is
    most likely to be in, and the symptom is a button that does nothing.
- **`workers.language` is the third dial** (see the top of this file).
  Nullable, and the null means "inherit `companies.language`" — do not give it
  a default. A worker sets it themselves by replying `PT`/`ES`/`EN` to their
  briefing. Since #22 they can also just ask in words (`set_my_language`), but
  the deterministic `LANGUAGE_KEYWORDS` lookup stays IN FRONT of the agent: `ES`
  must keep resolving with zero model calls. Since #49 the table lives in
  `apps/web/lib/worker-keywords.ts` beside the other two, and `pnpm
  whatsapp-check` asserts both halves — that a bare `ES` resolves to `es-ES`,
  and that neither of the other two tables claims the word.
- **`pending_review` is the completion claim, and the surfaces that see it
  split into denylists and allowlists on purpose.** A worker (PRD 4) or the
  manager declares a task finished; it
  lands in `task_reviews` and the task moves to `pending_review` until the
  manager approves, rejects, or dismisses it. Adding a status touches ~10
  hand-written enumerations — the map is in `0018_task_reviews.sql`. Three
  migrations built this: `0018_task_reviews.sql` (table, RLS, both RPCs),
  `0019_task_reviews_hardening.sql` (fix round 1: closed a fail-open tenant
  guard, added a row lock, revoked the INSERT grant), and
  `0020_task_review_supersede.sql` (the trigger below). The surfaces that
  matter are listed below, and the review that shipped this feature found
  the map itself had contained one inversion — treat this list as ground
  truth, not the in-progress draft:
  - `task_board.is_open` (`0013:71`) is a **denylist**
    (`status not in ('done','cancelled')`), so `pending_review` stays
    **open**: on the board, and still overdue when its dates say so. That is
    the safety property — a false completion claim is visible, never silent.
    Note the asymmetry inside the same view: `risk_late_start`/
    `risk_due_soon` (`0013:116-121`) are `status = 'pending'` **allowlists**,
    so those two *at-risk-of-slipping* signals never fire for a task in
    review. That does **not** make a task in review immune to `at_risk`
    overall: `risk_late_dependency` (`0013:92`) and `risk_paused_job`
    (`0013:125`) are **not** status-gated, so either can still put a
    `pending_review` task under the Em risco chip — e.g. a task declared
    finished but not yet approved still counts as a late dependency blocking
    its successors.
  - `dashboard_tasks` (`0006:31`, replacing `0005:71`) is a **denylist**, so
    `pending_review` rows DO appear in it — superseded predecessor of
    `task_board`, kept only so an old bundle served mid-deploy keeps working;
    it has no live reader.
  - `dashboard_obras.pendentes` (`0005:82`) is a **denylist**, so a task in
    review counts as *pendente* on the Obras screen. This view **is**
    live-read (`apps/web/app/dashboard-data.ts`).
  - `dispatch_tasks_today` (`0003:34`) and `BRIEFABLE`
    (`apps/web/app/notifications/briefing.ts:51`) are both **allowlists**, so
    both exclude it with no edit: the 07:00 briefing stops nagging a worker
    about work they already declared finished, and the frozen n8n view stays
    byte-identical.
    `BRIEFABLE` now gates **both** daily sends, which is load-bearing and was
    not designed — it fell out of the two streams meeting. The 16:30 check-in
    (`apps/web/app/api/cron/checkin/route.ts`) reads through
    `loadCompanyBriefing`, so a task in review is silently dropped from
    "acabaste as tarefas de hoje?" too. That is exactly right: the worker
    already said they finished it and is waiting on the manager, so asking
    again would read as the system having forgotten. Anything that widens
    `BRIEFABLE` therefore changes two messages, not one.
  - `context.ts`'s `openTasks` count (`packages/core/src/agent/context.ts:39`)
    is an **allowlist that had to be widened by hand**, or a task in review
    would silently vanish from the count Capo sees while still showing on the
    manager's board.

  Resolution goes through `resolve_task_review()`, never two client-side
  updates: the review and its task must move in one transaction or the
  half-applied state is exactly what the feature exists to prevent. Like
  `revert_translation_batch`, it is SECURITY DEFINER — RLS does **not** cover
  it and its internal `auth.uid()` check is the whole tenant boundary, which
  is why `scripts/rls-isolation-matrix.mjs` attacks it directly. `task_reviews`
  has **no INSERT and no UPDATE grant** for `authenticated` — SELECT is the
  only tenant grant that exists on the table. Every write, filing a claim as
  well as resolving one, goes through the two SECURITY DEFINER RPCs
  (`open_task_review` / `resolve_task_review`), so a tenant can neither forge
  `status`/`resolved_by` nor strand a task open by hand.

  The fifth status, **`superseded`**, exists because a task can leave
  `pending_review` out of band — `update_task` writes `status` straight
  through with no precondition, so "marca a tarefa como concluída" while a
  claim is outstanding would otherwise strand the review at `pending`
  forever: `task_reviews_one_pending_idx` blocks a replacement review, and
  tenants have no UPDATE grant to fix it themselves. `tasks_supersede_review`
  (`0020`) is an `after update of status on tasks when (old.status =
  'pending_review' and new.status is distinct from 'pending_review')` trigger
  that marks any still-`pending` review `superseded` instead. It is safe to
  fire on every exit from `pending_review`, including the legitimate one
  through `resolve_task_review()`, only because that RPC updates
  `task_reviews` to its resolution **before** it updates `tasks` — by the time
  the trigger fires on the `tasks` update, the review is no longer `pending`
  and the trigger's `where status = 'pending'` matches nothing. **This
  statement ordering inside `resolve_task_review` is load-bearing**: reorder
  it and every legitimate approve/reject/dismiss overwrites itself with
  `superseded`.

  `task_reviews.note` is the one place worker-authored text reaches the
  manager. Render it as an attributed quote, never as UI copy — in the
  inbox (`notifications.body`) as well as on the board.
- **A task has ONE lead and any number of collaborators, and
  `tasks.assignee_worker_id` is still the lead** (migration `0035`, issue #44).
  Before it, the only shape for "o Miguel e o João fazem a pintura" was two
  tasks — and `materials` lives on the task, so a duplicate doubled what
  /materiais and `materials_outlook` said to buy. That is the whole bug.
  `task_assignees` is additive: `(company_id, task_id, worker_id, role)` with
  `unique (task_id, worker_id)` and `role in ('lead','collaborator')`.
  - **The mirror flows ONE WAY, `tasks` → `task_assignees`, and no reader ever
    takes the lead from the join table.** `tasks_sync_lead_assignee_{ins,upd}`
    writes the `lead` row; `task_assignees_lead_matches_task` refuses any lead
    row — from any actor, service role included — that disagrees with
    `tasks.assignee_worker_id`. So "what if they disagree?" has no answer for
    anything a reader consults. A MISSING lead row is likewise harmless: it
    costs only the `unique` constraint's protection against the lead also being
    listed as their own helper, whose worst symptom is one name printed twice.
    The lead row exists for exactly that constraint — that is its job, not
    "being the lead".
  - **SELECT is the only tenant grant**, `task_reviews`' posture (0018) rather
    than the uniform three-policy one. Every write goes through
    `set_task_collaborators(p_task, p_workers[])`, SECURITY DEFINER, which
    REPLACES the whole set in one transaction — a crew is a set, and a
    half-applied one is a wrong WhatsApp message to a real person at 07:00. It
    silently drops the lead if named, caps at 20, and takes `[]` as "remove
    everybody". Its `auth.uid()` guard is the entire tenant boundary (the fourth
    function of that shape; see 0019/0021 on the `<>` trap), and
    `scripts/rls-isolation-matrix.mjs` attacks it directly. **There is still no
    DELETE policy on this table** — `push_subscriptions` remains the only one in
    the schema.
  - **`task_board` gained TWO APPENDED columns**, `collaborator_worker_ids` and
    `collaborator_names`, index-aligned by construction (same `order by` in both
    aggregates). Read them ONLY through `readCollaborators` /
    `everyoneOnTask` in `packages/core/src/capabilities/collaborators.ts`, which
    is the one place this codebase zips two arrays by position and says why.
    Every reader that needed them switched to `select('*')` — do not put either
    name in an explicit column list.
  - **The 07:00 briefing goes to EVERYONE on a task; the 16:00 check-in goes
    only to the LEAD.** That asymmetry is deliberate and load-bearing. Since #54
    a "Sim, terminei" tap FILES A COMPLETION CLAIM per task in the snapshot, so
    briefing a helper is information while asking a helper is authority — and
    `task_reviews_one_pending_idx` means a helper's premature claim would BLOCK
    the lead from filing their own. The filter lives in the check-in route, not
    in `loadCompanyBriefing`, so it cannot take the morning message with it.
  - **The wording is a requirement, not a nicety.** A collaborator's line reads
    `Pintar tecto (Casa de Paco) — a ajudar Miguel`; the lead's carries
    `Contigo: Zé, João`. Both come from `taskHeadline` in
    `apps/web/app/notifications/briefing.ts`, which every headline surface calls
    — a surface that built one inline would tell a helper the job is theirs.
    Lateness is applied AFTER the role clause, so it stays last on the line.
  - **The 07:00 guided menu lists only tasks this person LEADS.** `findWorkerTask`
    (and `loadWorkerTasks` behind it) still filters `assignee_worker_id`, so a
    collaborator's row would answer "that task is not yours". Fixed in the cron
    route rather than by widening that read, because the same read computes the
    worker agent's `scope.taskIds`, which is `declare_task_done`'s boundary.
  - **Deliberately NOT widened, and this is scope, not oversight**: the worker
    agent (`my_tasks`, `declare_task_done`) and the guided-menu task sheet all
    still see lead tasks only, so a collaborator cannot declare somebody else's
    task finished by any route. `WorkerContext` gains nothing.
    `dispatch_tasks_today` / `dispatch_log` are untouched — the frozen SMS path
    knows nothing about collaborators, by design.
  - Counters that answer "quem está livre?" — `loadTeamLoad`,
    `loadAssignableWorkers`, `list_workers` — count helpers too, via
    `everyoneOnTask`. A picker that called a helper "free" is the wrong-direction
    label that whole control exists to refuse.
- **Task photos are the project's only Storage use, and the object path IS
  the tenant boundary.** Migration `0023_task_photos.sql` adds a private
  bucket `task-photos`, the `task_photos` table, and one column,
  `tasks.completion_proof`. Everything about it keys on the path convention
  `{company_id}/{task_id}/{uuid}.{ext}` — build one only through
  `taskPhotoPath()` in `packages/core/src/media/photos.ts`.
  - **Two boundaries, not one, and they are enforced by different software.**
    `task_photos` is ordinary Postgres RLS. The BYTES are guarded by policies
    on `storage.objects` that compare `(storage.foldername(name))[1]` against
    `private.current_company_id()`, consulted by the Storage API over a
    different endpoint. A check that only touches the table proves nothing
    about the photos. `scripts/rls-isolation-matrix.mjs` attacks both (and the
    seam between them: a row whose `company_id` is honest but whose
    `storage_path` names another company's folder — caught by the
    `task_photos_path_scoped` CHECK, nothing else).
  - **Signed URLs are bearer tokens.** Mint them per request, in a dynamic
    segment (`loadTaskPhotos`, read only by `/tarefas/[id]`, which is
    `force-dynamic`). One baked into a statically rendered page is served to
    whoever asks and then expires, leaking briefly and rendering broken
    frames forever.
  - **Attribution is un-forgeable at the grant layer, not in app code.**
    `task_photos` grants tenants SELECT plus a COLUMN-SCOPED INSERT on
    `(company_id, task_id, storage_path, mime, byte_size, taken_at)`. `source`
    and `uploaded_by` are absent and fall to their defaults (`'manager'`,
    `auth.uid()`), so a manager cannot manufacture "the crew sent proof".
    PRD 4's worker path writes on the service role, which bypasses grants.
    There is no UPDATE and no DELETE — on the table or on `storage.objects`.
  - **One cap, three statements of it.** 5 MiB and `jpeg|png|webp` live in
    `TASK_PHOTO_MAX_BYTES`/`TASK_PHOTO_MIME_ALLOWLIST`, in the bucket's
    `file_size_limit`/`allowed_mime_types`, and in `task_photos`' CHECK
    constraints. The constant is meant to be passed straight through as
    `downloadMedia`'s `maxBytes` so PRD 4 shares it. Changing it needs a
    migration; nothing in CI will notice if you skip that.
  - **Photos are never shown to a model.** Feeding an inbound image to a
    vision model is a text-in-image prompt-injection surface with no guard in
    front of it. The agent neither reads the bucket nor reads `task_photos`.
  - `tasks.completion_proof` is `'photos' | 'skipped' | NULL`. Since #52 it is
    written by **three** callers — the completion sheet, `declare_task_done`,
    and the check-in photo follow-up — so it answers "does this completion have
    photographic proof", not "how did the manager close it" (`0034` restates the
    column comment). **NULL means "closed some other way" (chat, agent,
    pre-0023) — unknown, never "skipped".** Do not conflate them when counting,
    and note only the sheet ever writes `'skipped'`.
    It is **not** what the board and inbox read: those count `task_photos` at
    read time, because a photo can arrive after the claim.
- **EVERY inbound crew photo is STAGED before anything decides what it is of,
  and the one-turn limit is gone** (`worker_photo_inbox`, migration `0047`).
  This REPLACES the promise recorded above and in `runWorkerTurn` that photos
  live for exactly one turn. A crew member sent a photo, Capo asked which task
  it was for, and the bytes were already gone by the time they answered; three
  photos sent as three messages kept only the last. On 3 September that
  produced "I tried 3 times now. Is not working" and five days with no
  `task_photos` row. Seven things:
  - **It stages the BYTES, which is the whole difference from
    `checkin_photo_requests` (0034).** That table stages the EXPECTATION and
    must never gain a blob column; it only works because a tap knows the task
    BEFORE the photo arrives. Nothing knows the task when somebody just sends a
    photo, so the only way to stop losing it is to keep it somewhere that is not
    a task folder yet. Both tables are needed and they answer different
    questions.
  - **`{company_id}/inbox/{worker_id}/…` in the SAME `task-photos` bucket, and
    that needed NO storage policy change.** 0023's two policies on
    `storage.objects` compare `(storage.foldername(name))[1]` against
    `private.current_company_id()` and read nothing else, so segment 1 is still
    the boundary. Segment 2 is the literal word `inbox`, which is not a uuid and
    therefore cannot collide with a task folder. Build both keys only through
    `taskPhotoPath` / `taskPhotoInboxPath` in `packages/core/src/media/photos.ts`.
  - **A staged photo is NOT evidence.** There is no `task_photos` row until it
    is ATTACHED, at which point the object is MOVED to the task key and the row
    is written by `attachInboxPhotos` beside `storeWorkerTaskPhoto` — one file,
    because `source: 'worker'` is an ATTRIBUTION 0023 makes unforgeable at the
    grant layer and two writers of that claim would eventually disagree.
    `task_photos_path_scoped` is untouched and still binds every row it ever
    bound.
  - **Deny-all for tenants, `checkin_photo_requests`' posture.** A tenant able
    to INSERT one could stage an object as though the crew had sent it; able to
    UPDATE one, they could re-point a colleague's waiting photo. The route runs
    on the service role, so the `company_id` + `worker_id` filters in
    `loadInboxPhotos` and `attachInboxPhotos` ARE the boundary, both
    phone-derived. `scripts/rls-isolation-matrix.mjs` attacks read, insert,
    update, delete, the cross-company FK trigger, and carries a service-role
    positive control.
  - **A bare photo with no open check-in request now gets BUTTONS, not a model
    turn.** "Recebi a foto (2). Mais fotos ou é tudo?", `capo:photos:more` /
    `capo:photos:done` — the FOURTH tappable codec and the THIRD under
    `type: 'interactive'`, two of which now read the same `button_reply.id`.
    Nothing but the non-overlapping prefixes keeps them apart; `pnpm
    whatsapp-check` asserts every direction and a fifth codec must extend those
    assertions rather than assume them. The payload carries NO id: which photos
    "é tudo" settles comes from the tapper's phone-derived worker id.
    A CAPTIONED photo is still excluded from the deterministic branch and still
    falls through to the agent, for #52's own reason.
  - **The TTL is 24 hours, enforced by the READER, and NOTHING sweeps the
    table or the objects behind it.** Longer than 0034's three hours on purpose:
    that one bounds what an unlabelled photo may be BELIEVED to be about, this
    one bounds only how long Capo keeps offering somebody their own photo back.
    The consequence is stated rather than hidden: an expired staged OBJECT stays
    in the bucket for ever until somebody writes a sweep. A photo taken at 08:00
    is still waiting at the next day's 07:00 briefing, which is safe here only
    because the crew member NAMES the task themselves and the model is shown
    each photo's arrival time.
  - **`storeWorkerTaskPhoto` used to swallow four different failures into one
    silent `null`**, and one of its two callers logged nothing at all, so a
    systemic Storage failure produced zero rows and zero events. Every failure
    on both writers now logs `task_photo.store_failed` with the `stage` it
    failed at. Grep that event before concluding the crew sends no photos.
  - **A STAGING FAILURE FALLS BACK TO THE PRE-0047 PATH, and that is the whole
    deploy-order safety story.** While 0047 is unapplied every query on the
    table answers 42P01, and on this project a migration has sat merged and
    unapplied for three weeks (0038) while the app half was live. So
    `stageInboundPhoto` hands the DOWNLOADED BYTES back with its failure, and
    every branch does what it did before: the check-in photo path writes them
    straight to the task through `storeWorkerTaskPhoto`, and the agent turn
    carries them as `WorkerContext.unstagedPhotos` for `declare_task_done`.
    **No photo the pre-0047 product would have kept is lost**; what is lost in
    that window is only the photo outliving its turn and the buttons. Both
    writers end at ONE row-insert helper, so the `source: 'worker'` attribution
    is asserted in exactly one place whichever of them ran.
  - **"É tudo" attaches only photos received AFTER the check-in request
    opened** (`photosSinceRequest`, `apps/web/lib/checkin-photo.ts`). A photo
    taken at 15:00 of another job, with a 16:00 request open, must never become
    proof of that request's task: #52's own rule is that wrong evidence is worse
    than none, and 0023 has no DELETE policy anywhere. An entirely older batch
    makes the branch fall through, so those photos stay in the inbox for the
    agent path rather than being attached wrongly OR lost.
  - **The bytes are deny-all in the TABLE but readable in STORAGE by their own
    company.** 0023's SELECT policy on `storage.objects` keys on segment 1
    alone, so a tenant can list `{company_id}/inbox/…`. That is deliberate (they
    are that company's own crew's photos) and it is why the deny-all above is
    about the ROW, which is the thing that would let somebody re-point a
    colleague's next photo.
  Known and NOT done: nothing sweeps expired objects, `caption` is recorded and
  read by nobody, and a crew member who sends photos for two different jobs in
  one batch has to say so in words.
- **`notifications` (0024) is the in-app inbox, and is NOT
  `notification_log` (0016).** They share a stem and nothing else.
  `notification_log` is the OUTBOUND ledger — one row per paid WhatsApp
  template send, RLS on with deliberately zero policies, written only by the
  cron as the service role, readable by nobody. `notifications` is read by
  the tenant on every page load and written only by triggers. Four things
  about it are load-bearing:
  - **It is scoped per PROFILE as well as per company.** The select/update
    policies carry both predicates, because one `read_at` shared across a
    company would let whichever manager opened the app first clear everyone
    else's badge. This is the repo's first per-profile relation, which is
    why `scripts/rls-isolation-matrix.mjs` now seeds a **colleague** — a
    second profile per company. Without one, a policy that dropped the
    `profile_id` clause still reports green.
  - **Producers are triggers on the subject table, never app code.**
    `task_reviews_notify_pending` fans a row out to every profile in the
    company except the actor (`is distinct from auth.uid()` — the naive `<>`
    notifies *nobody* when the actor is the service role). Wiring a producer
    into `open_task_review` instead would miss every other path that files a
    review: the WhatsApp webhook, PRD 4's worker agent, a backfill.
  - **`task_reviews_retire_notifications` marks the row read when the review
    leaves `pending`** — by any door, including 0020's `superseded`. The
    manager resolves reviews on the board, not in the inbox, so without this
    the badge would still be lit after the decision was made.
  - **Copy is not in the row.** `title` is the task's title and `body` is the
    worker's note — both data. The sentence around them comes from the
    catalog, keyed on `kind`, so each manager reads it in their own
    `profiles.language`. Adding a kind is therefore always two edits: the
    `kind` check constraint and all three dictionaries (the catalog's
    `Record<NotificationKind, …>` makes the second one a `tsc` error).

  The inbox lives at `/notificacoes` and is a **drill-down with a Back arrow**,
  not a tab. It briefly had one; `/atividade` took it. The two are different
  questions and must not be merged: the inbox is what needs YOU and is markable
  as read, the feed is a record of the SITE and is neither.
  **The unread strip in `(app)/layout.tsx` stays**
  and is not made redundant by the tab: a tab label is not a count, and the
  strip's job is to make an unread decision unmissable. It retires the day that
  tab carries a badge. Both strips remain siblings of the `overflow-hidden`
  content column, never children of it, which is why neither can be clipped —
  and the persistent top bar is a sibling for the identical reason, because the
  drawer it owns would otherwise be clipped by that column.
  `/perfil/privacidade` carries the always-present link for when nothing is
  unread.
- **Web Push (0026) rides `notifications`; the row IS the queue.** There is no
  push producer and no outbound push ledger. `notifications.pushed_at` /
  `push_attempts` mark delivery, so a push exists if and only if an inbox row
  does — which is why #22's and #23's future kinds get push with no edit.
  `dispatchPushes()` (`apps/web/app/notifications/push.ts`) is **one function
  called from two places**: `after()` in the producer's own request, and
  `api/cron/push` every 10 minutes. The sweep is not redundancy — it is what
  makes a producer that forgets the immediate call cost lateness instead of
  silence. Five things here are load-bearing:
  - **The `0026` backfill (`update notifications set pushed_at = now()`) was
    mandatory.** Any future migration adding a delivery-marker column to a
    populated table needs the same, or its first deploy replays history.
  - **`410`/`404` means delete, on the first answer.** Classified in
    `packages/core/src/channels/push-rules.ts`, asserted by `pnpm push-check`.
    Anything else is retryable and capped at `PUSH_MAX_ATTEMPTS`.
  - **An all-`'gone'` round stamps the row.** Every registration was just
    deleted, so there is nothing left to reach; treating it as a retry hangs
    the row in the queue and re-sweeps it forever.
  - **The cron route has NO `lisbon_hour()` gate**, unlike the two daily sends.
    It is meant to run all day; gating it on the hour is the same bug that made
    the check-in ship and never send. The `:00`-not-`:30` rule likewise does not
    apply — it exists for hour-gated crons.
  - **The permission prompt is one-shot and iOS needs a home-screen install.**
    Both failures are silent, so `/perfil`'s card enumerates every state rather
    than rendering a button that does nothing. `push_subscriptions` also carries
    the schema's **first DELETE policy** — deliberate, because a registration is
    a device and not a business event.
  Copy never enters `packages/core`: `push-rules.ts` takes an already-rendered
  headline, and the dispatcher renders it from the recipient's own
  `profiles.language` using the SAME catalog entry the inbox uses, so the two
  surfaces cannot say different things.
- **Being onboarded is a COLUMN, never a count** (`companies.onboarded_at`,
  migration `0046`). Capo used to work out whether a manager was still being set
  up by counting rows, and the count switched the whole onboarding block off the
  moment one obra and one worker existed: a manager who had answered two
  questions was told "done" and left with an empty company. Seven things:
  - **THREE STATES, and the third is a deploy-ordering rule.** A string is the
    moment the setup was declared finished; an explicit SQL NULL means it is
    still running, and is the ONLY state that turns the checklist on; an ABSENT
    column (`select('*')` on a database where 0046 has not been applied) reads
    as ALREADY ONBOARDED. `CompanySnapshot.onboardedAt` is therefore
    `string | null | undefined` and the loader uses `'onboarded_at' in row`,
    never `??`. Collapsing absent into null is the obvious way to write it and
    is the bug: with the code live and the migration pending it drops EVERY
    established customer into a setup conversation whose two tools cannot run,
    which is exactly the harm the backfill exists to prevent, arriving through
    another door (0038 sat merged and unapplied for three weeks on this repo).
    Both tools answer a 42703 with a plain "not available yet" sentence rather
    than a driver error the model would retry, and `pnpm onboarding-check` pins
    absent and null side by side.
  - **The dashboard URL is WITHHELD from the prompt while `onboarded_at` is
    null.** `finish_onboarding` RETURNS it, which is what makes "share it only
    once the setup succeeded" a property of the mechanism rather than of the
    model's goodwill. The `snapshotApp` line renders only for a company that is
    not mid-setup (and not at all when the snapshot read failed: not knowing is
    a reason to say nothing). Left in from turn one, the plausible failure is
    the original bug in a new shape: Capo offers the link, the manager leaves
    for the dashboard, and the company is never finished being set up.
    `pnpm cache-check` asserts the string reaches neither half.
  - **The backfill was mandatory**, exactly as `0026`'s `pushed_at` and `0033`'s
    welcome ledger were: every company with at least one job AND one worker is
    stamped `now()` by the migration itself. Without it the first deploy tells
    every existing customer, in their next message, that Capo is about to set
    their company up from scratch.
  - **The checklist is REBUILT from the counts every turn and lives in the
    UNCACHED half.** It is per-tenant and changes several times during a single
    setup conversation, so above the breakpoint it would fragment the cached
    prefix per company and rewrite it on every answer. `pnpm cache-check`
    asserts it stays below the line.
  - **`missingOnboardingItems` is the ONE definition of "set up"**, and both the
    prompt block and `finish_onboarding` read it. Two copies would be a
    conversation that says the setup is finished and a tool that refuses to
    agree. `finish_onboarding` RE-READS the snapshot rather than trusting the
    block rendered at the top of the turn, because the turn itself may have
    created the last task.
  - **Both tools are UNGUARDED and that is deliberate.** `set_company_about`
    stores one sentence the manager just said about his own business;
    `finish_onboarding` stamps a timestamp on his own company row and stops a
    checklist appearing. Neither creates anything, schedules anything or
    messages anybody. Under the product default posture (`always_ask`, 0031)
    guarding them would meet a brand new manager with an approval card asking
    him to confirm the sentence he had just typed, before he has any idea what
    an approval card is.
  - **`appUrl` is REQUIRED on `ToolContext`, `HandleInboundOptions`,
    `buildSystemPrompt` and `resolveProposal`**, for the same reason
    `confirmPosture` is. `packages/core` reads no environment by contract, so an
    optional field with a fallback resolves to a link to localhost or to an
    empty string: a dead link handed to a manager on the last step of signup,
    which nothing in a build could notice. `WorkerContext` must never gain it —
    a crew member has no dashboard.
  - **The tenant's UPDATE grant on `companies` grew to `(name, about,
    onboarded_at)` and to nothing else.** 0011 revoked the table-wide grant
    precisely so `subscription_status` has exactly one writer, the Stripe
    webhook; that stays true. What a tenant can now do is declare their own
    company set up early, which costs them a checklist and nobody else anything.
  `firstUse` is left in the prompt catalogs unreferenced on purpose, so
  reverting this feature is a code change rather than a translation job.
  Known and NOT done: nothing ever un-stamps a company, and no screen shows the
  manager where he is in the checklist. The conversation is the only surface.

- **The live facts outrank the frozen prose, and the prompt says so** (issue
  #62). Capo's context holds two kinds of thing: blocks rebuilt from the
  database on every turn (the date, the company snapshot, the knowledge index,
  tool results) and blocks that are compressed HISTORY (`memories`, the
  conversation summary). Nothing re-checks the second kind, and
  `maybeSummarize` MERGES the previous summary into each new one — so a fact
  written into it once is copied forward indefinitely. That is how a manager
  who renamed himself on `/perfil` kept being called by his old surname while
  the company rename was picked up immediately: `companies.name` is read every
  turn, his own name was not read at all. Four things follow:
  - **The manager's name is now a live fact**, loaded by `loadManagerName` in
    `agent/context.ts` and rendered as the first line of the company snapshot,
    with the same fail-soft posture as the counts (an error drops the line, it
    never breaks the turn). `buildSystemPrompt` takes an options object with a
    REQUIRED `userId` for it — positionally, `companyId`/`userId` are two bare
    uuids and a swap would silently name the wrong person.
  - **It must stay in the UNCACHED half.** It is per-PROFILE, so above the
    breakpoint it would both rewrite the cached prefix on every rename and
    fragment it per manager — two managers of one company would stop sharing an
    entry. `pnpm cache-check` seeds a profile fixture and asserts the name
    below the line, plus that it survives a failed snapshot read (the two reads
    fail independently on purpose).
  - **The precedence RULE is static text, so it lives above the line**, in
    `prompts/orchestration.ts` ("Live facts outrank your notes"). Values below,
    policy above — that split is what keeps the cache shareable.
  - **The summarizer is told never to write the manager's name**, naming him by
    role instead. It is not a safety boundary and not retroactive: existing
    summaries keep the old name until they are next merged. Deliberately, no
    path deletes or rewrites a stored summary on rename — a summary is a record
    of what was said, and rewriting history to fix a display bug is the worse
    trade. The precedence rule is what makes the stale copy harmless.
- **Memory has THREE tiers now, an OWNER, and a CEILING** (`memories.profile_id`,
  `memory_consolidations`, migration `0037`, issue #48). Before it there were two
  thin tiers — a rolling summary and a company-wide `memories` table — and the
  table was injected WHOLESALE into the system prompt on every turn. Both facts
  had to change together: the nightly pass below writes memories on a SCHEDULE,
  so growth became automatic, and an automatic growth curve on a block re-sent
  with every message is a cost bug and a #58 cache bug at the same time.

  **Whose memory it is, and whose it is ABOUT, are different questions.**
  `subject_type`/`subject_id` (0001) say what a memory is about — a job, a
  worker. `profile_id` (0037) says who it belongs to, and **NULL means the whole
  company**, which is what every pre-0037 row is. Do not give it a default and do
  not invert the null: the whole reason no backfill was needed is that the absent
  value is the inherit case, exactly as `workers.language` is.
  A memory ABOUT a worker still belongs to the company — one that belonged to a
  single manager would be invisible to the colleague who most needs it.
  - **Per-profile rows need PER-PROFILE RLS**, and this is the schema's SECOND
    such relation after `notifications` (0024). All three policies carry
    `company_id = current_company_id() AND (profile_id is null OR profile_id =
    auth.uid())`, and the company half **must stay first in the OR** — it is what
    keeps every pre-0037 row readable. 0007's company-only triple was DROPPED
    rather than added to: two permissive policies on one command are ORed, so
    leaving the wider one in place would have left it in force and made the
    narrower one decorative.
  - **The INSERT policy's second predicate is load-bearing**, unlike
    `notifications`, which solves the same problem by having no INSERT policy at
    all. `remember` runs on the tenant's own client on the web, so an INSERT
    policy is unavoidable; without the predicate a manager could file a memory
    AGAINST a colleague — attacker-chosen text that Capo then reads out inside
    that colleague's own conversation.
  - **`memories` lost its Supabase default `grant all`** (carried since 0001,
    never revoked). Column grants now: INSERT `(company_id, profile_id, kind,
    content, subject_type, subject_id)`, UPDATE `(content, active, updated_at)`.
    `content` is there because `runTranslationBatch` rewrites it on the tenant's
    own client; `active` because "forget this" does. `active` is absent from
    INSERT so a memory cannot be born already forgotten.
  - **The cross-company FK trigger is the only defence against a row whose
    `company_id` is honest and whose `profile_id` is a stranger's.** Such a row
    satisfies NEITHER select policy, so it names another tenant's user and no
    tenant can find it. Same seam as 0024's.
  - **There is still no DELETE policy. "Forget" sets `active = false`**, uniform
    with the translation undo (0015) and a read notification (0024). Nothing on
    the request path reads an inactive row, so the promise to the manager is
    total; the row survives so "why did Capo say that in March" stays answerable.

  **The ceiling is a READ-time cap, and it is the bound that matters**
  (`packages/core/src/agent/memory/prompt-memories.ts`): 40 rows AND 6000
  characters, newest first, then reversed so the rendered block stays
  chronological. Four things about it:
  - **Read-time, not write-time, on purpose.** A write cap means refusing to
    record something true and makes the nightly pass' behaviour depend on how
    full the table already is; a read cap means recording it and choosing what to
    CARRY. The second is reversible and the manager can watch it working.
  - **`select('*')` + a TypeScript filter, never `.eq('profile_id', …)`.**
    `profile_id` is a column 0037 adds, and naming it in the query makes a deploy
    landing first answer 42703 on EVERY turn. An absent field reads as
    `undefined`, which `memoryVisibleTo` treats as company-wide — i.e. the
    pre-0037 product. Same rule as the view-extension one below.
  - **On the WhatsApp path that filter is the ONLY boundary.** No `auth.uid()`
    there, so RLS is bypassed by design and `selectPromptMemories` is what keeps
    a colleague's private note out of this manager's context. `pnpm cache-check`
    drives the real prompt builder against a colleague-owned fixture for exactly
    that reason.
  - **Memories stay BELOW the cache breakpoint**, in the uncached half. Above it
    they would be the textbook "breakpoint on content that changes every request"
    — a nightly write invalidating the cached prefix — and a per-profile row up
    there would fragment it per manager, the trap `loadManagerName` (#62) had to
    avoid. `cache-check` asserts both halves.

  **The nightly consolidation pass is a SECOND agent with a different job**
  (`agent/memory/consolidate.ts`, `api/cron/consolidate`). Seven things:
  - **It reads `messages` and nothing else. Never `worker_messages`.** This is
    #22's boundary extended to its longest-lived surface: a worker's words must
    not reach the manager's context, and a memory written from one would be that
    rule broken permanently rather than for one turn. The separate-tables design
    (0027) is what makes it structural — there is no query here that could reach
    a worker's text. `role='event'` rows are excluded too, for a different
    reason: since #47 they are several a day of our own copy about data already
    in `tasks`, so consolidating them is paying a model to consider writing down
    what the database already holds.
  - **It writes MEMORIES, not prose**, which is what makes the manager's
    see-and-forget screen possible at all. A paragraph cannot be deleted a
    sentence at a time.
  - **It NEVER writes a name, and that is enforced in CODE.**
    `mentionsForbiddenName` rejects any candidate containing a profile
    `full_name` or `companies.name` — full string, plus profile-name tokens of
    four characters or more, accent- and case-insensitively. Workers are
    deliberately ABSENT from the list: "Zé is slow on tiling" is a legitimate
    `kind: 'worker'` memory. Over-rejecting costs one memory; under-rejecting is
    #62 with a longer fuse, because unlike a summary nothing ever merges a
    memory forward and launders the old name out.
  - **"Nothing tonight" is an explicit answer**, not an absence
    (`nothing_worth_keeping`). Taken from Mem0's NOOP branch; a reviewer that
    must produce something will produce something, and most nights genuinely
    hold nothing durable.
  - **It CANNOT deactivate a memory and CANNOT write a personal one.** The first
    is scope (a model retiring the manager's notes unattended at 03:00 is its own
    feature); the second is a FINDING — `conversations` is per company and
    `messages` carries no author, so at 03:00 there is no honest way to say whose
    preference something was. Personal memories come only from `remember` (which
    has `ctx.userId`) and the manager's own screen.
  - **The claim is `unique (company_id, run_date)` and the WATERMARK is
    `covers_until_at`, stamped only by a run that SUCCEEDED.** The claim makes
    the three in-window ticks no-ops by construction (23505); the watermark makes
    a skipped, failed or out-of-window night simply covered by the next one. Claim
    BEFORE the model call with the watermark null and stamp after — the reverse
    order marks a window consumed that was never read, the one failure here that
    loses information. A too-few-messages run deliberately does NOT advance it.
  - **It calls a model, so it is on the #53 ledger**: role `consolidation`
    (Sonnet 5, uncached — one call per company per night with no shared prefix),
    surface `consolidation`, actor `system`. Adding a surface is two edits and
    0037 REDEFINES 0032's CHECK to do it.

  **The hour gate: Lisbon 02–04, three hours wide, hourly heartbeat at `:00`.**
  It has one — unlike `api/cron/push` — because reviewing a day only makes sense
  once the day has finished. It is safe to have one, unlike the check-in, because
  the watermark turns a missed night into lateness rather than silence; the width
  is secondary. It ends at 04 rather than 05 because `MIN_SEND_HOUR` is 5 and a
  review still running then would contend with a paid send for the same
  300-second ceiling — `pnpm scheduler-check` derives that from the constants and
  is what caught the first, four-hour version. **It is deliberately NOT in
  `company_schedules`**: that table's `job_kind` CHECK and
  `/perfil/automacoes`'s `Record<'daily_briefing' | 'task_checkin', …>` are what
  keep a job that messages nobody off a screen about messages sent to people.

  **The summarizer's dial moved from 40/10 to 80/30** (`SUMMARIZE_AFTER` /
  `KEEP_RECENT`), which is the tuning the code comment had been asking Federico
  for. Passes per N messages goes from N/30 to N/50, and each pass is a lossy
  re-compression of an already-lossy summary — the mechanism behind #62. Two
  further reasons: #47's event rows mean 40 can now be reached without the
  manager typing anything, and ten messages is less than one sitting. The cost is
  real and stated: the verbatim tail is re-sent uncached on every one of up to
  twelve requests per turn.

  **Two consequences elsewhere, neither of them designed.** A bulk
  `translate_company_data` collects memories through the tenant's own client, so
  after 0037 it silently skips a COLLEAGUE's personal memories — correct (they
  are not visible) and consistent between `countTranslatable` and `collect`, but
  it means a company that translates everything can still hold un-translated
  personal notes. And the orchestration policy now tells the model about `scope`,
  about never writing a name, and that the manager can see and delete all of it;
  that text is in the CACHED half, which is fine because it is a constant of the
  code, but it means a reword there rewrites every tenant's cached prefix once.

  Known and NOT done: **no recall tool over what falls outside the 40-row
  window.** That is the archival tier the research names, and today the window is
  the whole of memory — `/perfil/memoria` says so out loud by labelling rows as
  stored-but-not-carried rather than hiding them.
- **`/` is the Home launchpad and the chat lives at `/chat`.** Chat was the
  landing screen from the beginning of the product; moving it is the single
  biggest behavioural change the design handoff made. Anonymous `/` still
  rewrites to the marketing landing page (`proxy.ts`), untouched. Anything that
  linked to `/` meaning "talk to Capo" had to be repointed — the dashboard
  empty states (`talkToCapo` in `dashboard-ui.tsx`), task detail's "ask Capo"
  (`/chat?q=`), and the top bar's mic and `+` (`/chat?voice=1`,
  `/chat?compose=1`). A new empty state that funnels to the chat must use
  `/chat`; `/` now lands on a dashboard.
- **The activity feed is ONE loader behind TWO surfaces, and that is the whole
  design** (`apps/web/app/activity/`). `loadActivity()` feeds both the
  Atividade tab and Home's "what just happened" widget, and
  `activitySentence()` is the only place an event becomes words. Two renderers
  would eventually describe one event differently and the manager would have no
  way to tell which was right — the same reason push and the inbox share a
  catalog entry. Five things:
  - **Three sources merged in TypeScript, not a SQL view**: `task_reviews`
    (claims, and resolutions as their OWN later event), `task_photos`, and
    `worker_checkins`. A view would need a migration, and a deploy has landed
    ahead of its migration on this project before.
  - **Photos collapse to one row per task per day.** Six photos of one façade
    is one thing that happened; six rows would bury every other event, which is
    what the handoff's own "6 photos added" example expects.
  - **There is no delivery event and there cannot be one.** The handoff's feed
    showed "Cement delivery signed for — 2 pallets short". Capo has no goods-in
    concept anywhere in the schema and materials are notes on a task, not stock
    that is received. Building the row would be a promise the product cannot
    keep.
  - **Worker names come from `workers.name`**, typed by the MANAGER — never
    from anything a crew member wrote. Same boundary #47 draws around thread
    events, for the same reason.
  - `pnpm activity-check` (credential-free, in CI) pins the pure half,
    including the **Lisbon-vs-UTC day boundary**: 23:30Z in August is already
    tomorrow in Lisbon, so labelling from the UTC date files a row under the
    wrong day.
- **Home re-derives NOTHING** (`apps/web/app/(app)/home-data.ts`). Today's
  tasks come from `task_board` via `loadBoardTasks`, decisions from
  `loadPendingReviews`, the buy list from `loadMaterials`, the feed from
  `loadActivity` — the same reads the screens it links to use. A widget with
  its own query would be a second opinion, and the failure is Capo saying one
  thing while the screen the manager taps through to says another. It fails
  SOFT per widget (`home.*_failed` log lines): a launchpad is the first screen
  of the app, so one broken query must cost one card and never the page. Grep
  those events before concluding a quiet Home means a quiet day.
  **The decision card deliberately has no "Confirm" button**, against the
  handoff: approving a completion claim goes through `resolve_task_review()`
  and is exactly what `confirm_posture` exists to slow down, so Home links to
  the task where the real control sits beside the photos. A launchpad points;
  it does not decide.
- **One clock, one definition of "today".** The active-window rule
  (`lisbon_today() BETWEEN coalesce(start_date, created_at) AND
  coalesce(due_date, 'infinity')`) and every schedule-risk signal live in SQL,
  in the `task_board` view. Anything that answers "what is on today /
  tomorrow / overdue / at risk" — a screen, a loader, or an agent tool —
  reads that view. Never re-derive those buckets in TypeScript: the failure
  mode is Capo telling the manager one thing while the Tarefas board shows
  another, and the manager having no way to tell which is right. The `agenda`
  tool (`packages/core/src/capabilities/agenda.ts`) exists solely to hold this
  line on the agent side, and its horizon names are deliberately the board's
  own chip names so the two cannot drift.
  (`dashboard_tasks` is the superseded predecessor, kept only so an old bundle
  served mid-deploy keeps working; do not write new readers against it.)
- **Capo's TONE has a prompt half and a code half, and the prompt half was the
  bug.** The product read as machine-written, and the first place to look was
  not the model: the instruction files were written like engineering memos and
  the model was copying their prose. Forty em dashes in the orchestration
  policy, fourteen in the worker policy, seventeen in the planner. Every
  model-facing string is now dash-free and `pnpm voice-check` keeps it that
  way. **A rule the prompt states and the prompt breaks is worse than no rule**,
  because it reads as compliance while producing the opposite, and nothing in a
  build will ever notice.
  `agent/prompts/voice.ts` is the style block, ONE copy appended to BOTH agents'
  cached half. Two copies of a style rule is the one duplication that cannot be
  tolerated here: the manager and the crew are different documents everywhere
  else, but a person reading both surfaces would have no way to tell which was
  right. It sits in the CACHED half legitimately (it is a constant of the code,
  never of the clock or the tenant) and adding it rewrote every tenant's cached
  prefix once, which is the documented price of a policy edit.
  `channels/voice.ts` is the code half: `applyWhatsAppVoice(text)`, pure, run
  between `toWhatsAppMarkdown` and `splitForWhatsApp` in **both**
  `planAssistantMessages` and `planWorkerMessages`. Six things:
  - **It REPAIRS and counts; it does not refuse.** The email product this is
    modelled on rejects a draft and never substitutes, for two reasons. The
    first (a silent substitution changes a human author's words) does not hold
    here: nothing on this path is human-authored, and the two things on it that
    ARE — an approval card's `renderedText` and the daily briefing — never reach
    the function. The second (a silent fix hides prompt drift) is answered
    rather than dismissed: every repair is RETURNED and the sink logs
    `voice.repaired` with the rules that fired. The fix is silent to the reader,
    never to the log. Grep that event before concluding the model needs no
    correcting. A refusal would also have cost a paid model call and, on a live
    conversation, a person waiting — which is the incident shape #126 exists
    for.
  - **AFTER the converter, BEFORE the splitter, and both halves of that matter.**
    After, because `toWhatsAppMarkdown` has already collapsed every dialect the
    model might emit into one canonical form, so flattening is three regexes
    instead of a second converter. Before, for the converter's own reason:
    splitting first can cut a marker pair across a chunk boundary.
  - **A card is NOT voiced, and that is geography rather than a rule.** In
    `planAssistantMessages` the card text travels a different branch from the
    prose, so the pass is simply not on its road. `renderedText` stays
    byte-identical to the persisted approval artifact the web card, the operator
    app and the audit trail all read, on the interactive branch AND on the
    over-1024 text branch. Both are asserted.
  - **Emphasis stripping is word-boundary scoped, and the guards are
    load-bearing.** Without `(?<!\w)`/`(?!\w)`, `_` eats the inside of anything
    holding two underscores — which is URLs and identifiers. `/dia`'s crew link
    (#114) is a bearer token in a URL, and a mangled one does not fail loudly:
    it 404s for the one person who needed it. This also leaves
    `whatsapp-markdown.ts`'s documented `snake_case` non-goal exactly where it
    was; rendering it italic is cosmetic, deleting characters out of it is not.
  - **`onRepair` is OPTIONAL, unlike `ToolContext.confirmPosture`.** Omitted,
    both planners stay pure, which is what lets `pnpm whatsapp-check` assert all
    of this with no credentials. Here the omission is a metrics gap; there it
    would be a safety regression. Same shape as the agent loop's `onStepEnd`.
  - **`applyVoice` (the channel-agnostic rules) is exported separately from the
    WhatsApp-only flattening**, so the in-app chat can adopt the first group
    without splitting the file. It is deliberately NOT wired there: the web sink
    streams the model's words into the browser as they are generated, so there
    is nothing to correct before the manager has read it. The prompt half
    improves that surface anyway; the code half does not reach it, and that gap
    is a decision.
  Scope taken and NOT taken: punctuation and formatting only. No length cap, no
  splitting one answer into several bubbles, no dropping the sentence-final full
  stop, no mirroring the manager's own casing or emoji use (Poke's idea, and the
  natural next step). No randomised reply delay either: Capo already sends a
  read receipt and a typing indicator (#50), the functions have a hard ceiling,
  and a deliberate pause would fight both.
  Consequence to know about: **a task list now arrives as plain lines, not
  bullets.** That is the point on a phone, and it is also the thing most likely
  to want reverting. It is one function in one file.
- **The design system is TOKENS plus a fixed set of COMPONENT MODULES, and
  `pnpm design-check` is what keeps it true.** `packages/ui/src/tokens.css` is
  the single source of every colour, size, spacing, radius, shadow and timing,
  and BOTH apps import it — before it, each declared its own `--background`,
  which is two copies of one rule and therefore an eventual disagreement.
  Eight things are load-bearing:
  - **Never put `@utility` in `tokens.css`.** Tailwind discards the ENTIRE
    imported file when it finds one — no error, no warning, every token gone.
    It works only in an app's own `globals.css`. Nothing in the design needs
    one: `min-h-11 min-w-11` is already 44px.
  - **Text colours are `--fg*`, never `--text*`.** Tailwind v4 owns `--text-*`
    as its FONT-SIZE namespace, so `--text-muted` would generate a font-size
    utility named `text-muted` and collide with the colour of the same name.
  - **There is no `--duration-*` theme namespace**, so `duration-fast` is not a
    utility and fails silently. Use `--default-transition-duration` (a bare
    `transition-colors` is then 180ms) or `duration-(--duration-fast)`.
  - **`--background` aliases `--surface`, never `--bg`.** Every existing
    `bg-background` is on a sheet, an input, the tab bar or the chat composer —
    a surface, never the page. Aliasing it to the page colour silently repaints
    all fifteen, input fields included.
  - **`--brand` (`#c2410c`) is the only orange legal behind text**;
    `--brand-vivid` (`#ea580c`) is 3.56:1 and is for large non-text fills only.
    `design-check` asserts vivid stays UNSAFE behind text, so it cannot be
    quietly promoted back into the primary button it used to be.
  - **Solid status fills are their own tokens, IDENTICAL in both themes.**
    `--danger-solid --warn-solid --success-solid --info-solid --review-solid
    --brand-solid` and `--on-solid`. A danger banner is a fixed signal colour,
    not a themed surface: white on the DARK status colours fails every tone
    (2.77:1 on danger, 1.67:1 on warn), so the themed `--danger`/`--info`
    must never be used behind banner text.
  - **`UNCONVERTED` in `scripts/design-check.mts` may only ever shrink**, and a
    STALE entry fails too. An allowlist nobody prunes is how a temporary
    exception becomes permanent; that list is the remaining sweep, written down.
  - **A route folder may NOT start with an underscore.** App Router treats a
    leading-underscore folder as PRIVATE and excludes it from route collection
    entirely — the build succeeds, no error, no warning, and the URL 404s in
    dev and production alike. `apps/web/app/_ui/` is correct BECAUSE it is
    components rather than routes. The gallery lives at `/design-system` for
    this reason, and `apps/web/proxy.ts` carries a NODE_ENV-guarded exemption
    so it renders without a login in development while production's auth
    posture is unchanged (the pages also call `notFound()` there).
  **The rule that decides where a component lives is whether it needs browser
  JavaScript** — if it does, it goes in `apps/web/app/_ui/`; if it does not, it
  goes in `packages/ui`, which is `'use client'`-free by contract. Naming a
  bare total invites drift, so list the modules instead of counting them:
  `packages/ui/src/` holds `button.tsx` (`Button`, `ButtonLink`, `IconButton`
  — the last with a compiler-required `label` prop, because an unlabelled icon
  button is invisible to a screen reader), `card.tsx` (`Card`), `list-row.tsx`
  (`ListRow`), `field.tsx` (`Field`, `Input`, `Select`, `Textarea`),
  `badge.tsx` (`Badge`), `banner.tsx` (`Banner`), `empty-state.tsx`
  (`EmptyState`), `skeleton.tsx` (`Skeleton`), and `app-bar.tsx` (`AppBar`).
  `apps/web/app/_ui/` holds `sheet.tsx` (`Sheet`), `segmented-control.tsx`
  (`SegmentedControl`), and `tab-bar.tsx` (`TabBar`). `/design-system` and
  `/design-system/screens` are dev-only and render every component and every
  hard layout case without a login.
- **Plan durations are working days, not calendar days.** The scheduler
  advances through `packages/core/src/capabilities/workdays.ts`, which skips
  weekends and the thirteen Portuguese national holidays. Anything that
  computes a due date from a duration goes through `addWorkdays`. Measuring an
  existing span (rather than walking one) goes through `countWorkdays` /
  `workdayDelta` in the same file — they are the exact inverse of `addWorkdays`
  and `scheduler-check` asserts that, because a task with no `duration_days`
  (nullable since `0010` — every pre-planner task) has its length read back off
  its dates.
- **Pausing an obra is a BOOKING decision, never a deletion** (migration
  `0038`, issue #95). `dashboard_obras` had carried `where j.status = 'active'`
  since `0005` and is the only reader behind the Obras screen, so pausing a site
  removed it from the app entirely — no row, no badge, no explanation, and no
  route back except knowing the `/obras/<uuid>` URL. Every other surface already
  read `paused` correctly: `task_board.overdue` deliberately ignores
  `job_active`, `risk_paused_job` exists to badge those tasks, and
  `loadObraOptions` reads `jobs` rather than the view with a comment saying why.
  Four things:
  - **The view now carries `active` AND `paused`, and `done` stays out.** A
    finished obra has no work left to book and belongs on a history screen that
    does not exist; adding it here would silently change what `pendentes` means
    on the screen that does. `0038` is a `create or replace view` with an
    IDENTICAL column list — only the WHERE clause moves, `status` was already
    selected, and grants and `security_invoker` survive untouched. The Obras
    list is therefore **no longer "active obras"**: any new reader that assumes
    every row is active must filter on `status` itself.
  - **Two pauses exist and they are different products.** A DEFINITE pause
    ("parada até dia 3") is `update_job(status: 'paused')` and keeps every date
    where it is, because the plan is still the plan. An INDEFINITE pause is
    `pause_job`, which proposes pausing AND clearing the dates of the job's
    unfinished tasks — Federico's own words: "if the person says I don't know
    when I'm starting it again, then all tasks are without dates". The
    distinction lives in the two tool descriptions and nowhere else.
  - **`apply_job_pause` is the FOURTH absent-from-roster applier**, alongside
    `apply_plan`, `apply_company_translation` and `apply_reschedule`, and the
    reason is sharper here than for any of them: erasing a date is not
    recoverable from anything the payload stores, and for "vou de férias, pausa
    a obra" the model can always quote the manager. `pause_job` is unguarded
    because it only ever proposes. The `from_start_date`/`from_due_date` pair is
    the compare-and-set predicate, checked for EVERY row before the first write,
    and a task that reached `done`/`cancelled` since the card was written fails
    it too — those dates are the record of when work happened, not a booking to
    release.
  - **The job is paused BEFORE the dates are cleared, and that order is
    load-bearing.** Dying in between leaves a paused obra with some dates still
    on it: visible, badged, off the crew's morning message, and fixed by
    approving again. The reverse order strips dates while the obra still looks
    active — work that has silently vanished from every day view with nothing
    saying why.
  - **Shipping this feature was TWO events, not one, and only one of them was
    automatic.** The app half deployed itself on merge; `0038` had to be applied
    by hand and was not, for three weeks — so the board went on hiding paused
    obras while every line of code above said it should not. That is the general
    hazard, not a detail of this feature: a skipped migration presents as a
    feature silently not working, never as an error. `pnpm migration-check` is
    now the check that asks.
  Known and NOT changed: `risk_paused_job` still puts every open task on a
  paused obra under **Em risco**. For a deliberate holiday pause that is amber
  noise rather than information, but narrowing it is a product decision about
  what "at risk" means, not part of making a paused site visible again.
- **`apply_reschedule` is the third absent-from-roster applier**, alongside
  `apply_plan` and `apply_company_translation`, and for the identical reason: a
  *guarded* tool in the roster executes directly whenever the model can quote
  the manager, and for "a Pintura acabou mais cedo" it always can. The model
  reaches rescheduling only through `reschedule_job`, which is unguarded
  because it never writes — it only ever produces a card.

  The cascade splits across four files on purpose, and the split is load-bearing:
  - `capabilities/reschedule.ts` — **pure**. No `Db`, no `Date.now()`, no locale,
    no `createProposal`. This is the only part of the task-completion work
    `pnpm scheduler-check` can cover, and it is the highest-risk pure function
    in the repo because it proposes moving dates on a live job. Keep it
    importable with no credentials and no network.
  - `capabilities/reschedule-load.ts` — reads **base `tasks`**, not `task_board`
    (the view's `lisbon_today()` window would drop exactly the future rows a
    cascade exists to move), but takes `today` from `lisbon_today()`: one clock.
    It loads one hop of **cross-job predecessors**, because `task_dependencies`
    only requires both ends be same-*company* (`0007:127-140`), never same-job —
    an unloaded outside predecessor is a silently *missing* constraint.
  - `capabilities/reschedule-propose.ts` — orchestration plus the `reschedule_job`
    roster tool.
  - `capabilities/reschedule-apply.ts` — the applier.

  Four things inside it that look like details and are not:
  - **Nothing outside `movable` is ever written.** `scheduleTasks` (`plan.ts`)
    cannot be reused precisely because it rewrites *every* task from one global
    start floor; on a live job that is catastrophic.
  - **`from_start_date`/`from_due_date` are in the payload as a compare-and-set
    predicate**, not as documentation. `resolveProposal` re-validates and
    re-renders but cannot know a *row* changed underneath, so without them
    approving a card left open overnight silently stomps a manual edit. Same
    role as `apply_company_translation`'s `languageMoved` re-check
    (`render.ts:169-178`). The applier reads every target row and verifies the
    whole set **before** the first write, so a stale card changes nothing.
  - **A cycle throws.** `task_dependencies` has no anti-cycle constraint in SQL
    and `scheduleTasks` silently drops back-edges — safe for model output, which
    zod-validates as a DAG first, never checked for DB edges.
  - **`pending_review` counts as finished for the cascade floor and as immovable
    for movement.** The cascade therefore fires on an *unverified* claim, which
    is exactly why it can only ever produce a card — and why the card says so
    out loud (`cards/types.ts`'s `reschedule.header({ unverified })`).

  An **empty result creates no proposal at all**: a job whose tasks were made
  one at a time by `create_task` has zero edges, so a completion cascades to
  nothing. That is the dominant case, not an error — an empty approval card is
  worse than silence. The skip is logged (`dashboard.reschedule_skipped`) so
  "no card appeared" stays falsifiable.

  Known and accepted: a manually pinned date gets stomped, defensible **only
  because** the card shows `from → to` per row and the CAS refuses stale rows.
  The long-term fix is a `schedule_locked boolean` on `tasks`.
- **Provider prompt caching is ON, and the system prompt's block ORDER is now
  load-bearing** (`packages/core/src/agent/cache.ts`, issue #58). Anthropic
  caches a PREFIX — `tools` → `system` → `messages` — so a `cache_control`
  marker means "everything before this point is one entry", and any byte that
  changes earlier invalidates it. Both agent prompts are therefore returned as
  **two system messages** with one breakpoint between them, and a second
  breakpoint sits on the last tool definition. Five things are load-bearing:
  - **The cut is immediately ABOVE the daily date line, in both prompts.**
    Cached: persona ⊕ orchestration ⊕ language directive. Uncached: date ⊕
    snapshot ⊕ onboarding ⊕ knowledge index ⊕ memories ⊕ summary (manager),
    date ⊕ tasks ⊕ knowledge ⊕ photos (worker). A breakpoint below the date
    caches a prefix guaranteed to be stale tomorrow: you pay the 1.25× write
    every day and never read it. **Anything added to the cached half must be a
    constant of the CODE, not of the clock or the tenant.**
  - **The split must stay byte-identical to the single string it replaced.**
    `cachedInstructions` joins the halves with the same `\n\n---\n\n` the
    blocks inside each half use, and `pnpm cache-check` asserts the rejoin
    against the real builders. This was a caching change, never a prompt
    rewrite — in particular the language directive's `manager_instruction`
    carve-out crosses no boundary and is asserted present in the cached half.
  - **Only the `conversation` role is cached, and the reason is per-MODEL.**
    Anthropic's minimum cacheable prefix is not monotonic across generations:
    Sonnet 5 is 1024 tokens, Haiku 4.5 is **4096**. Below the floor a marker is
    a silent no-op that still bills the write. `summarizer` / `extraction` /
    `translation` are all Haiku 4.5 with prompts of a few hundred tokens, and
    `planner` is Sonnet 5 with a ~900-token prompt and one call per plan — so
    all four are deliberately uncached. `MIN_CACHEABLE_PREFIX_TOKENS`,
    `MODEL_IDS` and `CACHED_ROLES` in `agent/models.ts` record this and
    `cache-check` asserts it, so moving a role to another model re-opens the
    decision loudly instead of silently.
  - **The economics are paid inside one turn, not across traffic.** A write
    costs 1.25× and a read 0.1×, so break-even is two requests on the same
    prefix within the 5-minute TTL. `stopWhen(12)` (manager) and `(6)` (worker)
    mean one inbound message is up to twelve API requests seconds apart, all
    re-sending the identical prefix. Do **not** switch to the 1-hour TTL: it
    costs 2× to write and needs three reads.
  - **`cache.ts` may serve both agents only because it is provider plumbing**,
    exactly like `models.ts`. Its whole vocabulary is `string` and the AI SDK's
    `ToolSet` — no `CapoTool`/`WorkerTool`, no `ToolContext`/`WorkerContext`,
    no roster, no persona, no policy. If something wants to pass a Capo type
    through it, that is the manager/worker isolation failing, not this file
    growing. The tool breakpoint is applied at the two agent cores
    (`withToolCacheBreakpoint(toAiTools(ctx))`) rather than inside `toAiTools`,
    so `capabilities/` stays unaware of the provider and the two rosters keep
    no shared import.

  Known and NOT done: the conversation history carries no breakpoint. Within a
  tool-heavy turn the loop re-sends the accumulated thread on every step at full
  price, and that is now the largest remaining uncached span. It was left out
  because it is the one marker that MOVES between requests (it rides the last
  message), which brings Anthropic's 20-block lookback window into play — a
  single turn can add more than 20 blocks and silently stop finding the previous
  entry. Worth doing, deliberately not done here.
- **The cost ledger stores TOKENS, never money, and is written at ONE seam**
  (`ai_usage`, migration `0032`, issue #53). Before it, nothing recorded what a
  model call cost: every request to Anthropic and Google was made, billed and
  forgotten. One row per API REQUEST — not per turn, because `stopWhen(12)`
  means one manager message can be twelve requests and a per-turn aggregate
  cannot tell one expensive answer from twelve cheap hops. Seven things are
  load-bearing:
  - **The write lives in `getModel()`, not at call sites.** `getModel(role,
    attribution?)` wraps the provider model in usage-recording middleware
    (`packages/core/src/agent/usage.ts`). A call site's only job is to say WHO
    is spending; a `recordUsage(...)` line per call site would count turns
    instead of requests and would silently undercount forever the first time
    somebody added a model call and forgot the line. `attribution` is
    deliberately OPTIONAL — unlike `ToolContext.confirmPosture`, where the
    omission is a safety regression; here it is a metrics gap, and requiring it
    would break the credential-free `pnpm cache-check`.
  - **`usage.ts` may serve both agents ONLY because it is plumbing**, exactly
    like `models.ts` and `cache.ts`: its whole vocabulary is `Db`, plain strings
    and numbers. `UsageActor` is a discriminated union
    (`{kind:'manager',profileId}` | `{kind:'worker',workerId}` | `{kind:'system'}`),
    so "a worker turn billed to a profile" is not expressible, the same way
    `WorkerContext` has no `userId`.
  - **The four token columns are DISJOINT.** `input_tokens` is the FULL-PRICE
    half only; `cache_read_tokens` and `cache_write_tokens` are their own
    numbers and total prompt tokens = the three added. The AI SDK's
    `inputTokens.total` INCLUDES the cached halves, so storing it would
    double-bill every cached request — and since #58 that is most of the
    conversation traffic. The resulting figure is plausible, too high, and
    unfalsifiable by looking. `toTokenBuckets` uses `.noCache`; `pnpm
    cost-check` pins it.
  - **Prices live in `packages/core/src/agent/pricing.ts`, keyed on MODEL ID.**
    Never on the role: a row written under an older model must stay priced at
    that model's rate. An unknown id is reported UNPRICED, never as free.
    Anthropic's rates are published; the Gemini and WhatsApp figures are marked
    `estimated` and have NOT been checked against a bill.
  - **The write must never break a turn.** `recordUsage` swallows every error
    into one `ai_usage.write_failed` warning line — same posture as
    `loadCompanySnapshot`. The cost of that: a wrong `surface`, an unapplied
    migration or a revoked grant all present as a table that quietly stops
    filling up. Grep that event before concluding a quiet dashboard means quiet
    traffic.
  - **RLS is INSERT-only for tenants, with no SELECT policy at all.** Not
    `notification_log`'s zero-policy posture, and the difference is forced: this
    write happens inside a tenant request on that tenant's own RLS-scoped client
    (the system-vs-user split forbids `getDb()` there). `usage_date` is absent
    from the column grant and comes from `lisbon_today()`, and there is no
    UPDATE and no DELETE — so the only lie available to a tenant inflates their
    own company's bill. If this ever becomes a BILLING input rather than an
    operator instrument, move the write behind a SECURITY DEFINER function that
    derives `company_id` from `private.current_company_id()`.
  - **Attribution is by who SPOKE, never by who was discussed.** A manager's
    chat turn is a manager cost even when the conversation is entirely about one
    crew member. Per-worker WhatsApp cost is the different, genuinely knowable
    question and comes from `notification_log`'s recipient. Adding a `surface`
    is two edits (0032's CHECK and the `UsageSurface` union) and there is
    deliberately no `briefing` value — both daily sends call no model at all.

  The dashboard is `/cost` in **apps/operator**, reading both ledgers on the
  service role. It is not in apps/web on purpose: cross-company cost is an
  operator question and this needs no tenant read surface. **Vercel hosting is
  absent and cannot be added** — it is one flat platform bill with no per-tenant
  meter, so any per-company hosting figure would be invented.
- **A task assigned for TODAY reaches the crew member now, and the door is a
  DATABASE TRIGGER** (`task_assignment_notices`, migration `0048`, issue W7).
  Before it, the only moment Capo ever spoke to a crew member first was 07:00,
  so a task given to somebody at nine in the morning reached them the following
  morning, and nothing told the manager they had not been told. Seven things:
  - **The trigger is the door because there are SEVEN of them.** `create_task`,
    `update_task`, `apply_plan`, `apply_reschedule`, the `assignTask` and
    `setCollaborators` web actions, and `set_task_collaborators` from the agent.
    A hook on each is a hook somebody forgets in a commit about something else,
    and the symptom is one crew member who silently stops being told about their
    work. Two triggers, on `tasks` and on `task_assignees` — the latter filtered
    to `role = 'collaborator'`, because 0035 MIRRORS the lead into that table and
    without the filter every assignment would queue twice.
  - **The trigger QUEUES; it never DECIDES.** It knows nothing about calendars.
    "What is on today" has one definition, in `task_board`, and a copy of it
    inside a trigger would be a second opinion whose symptom is Capo messaging
    somebody about next week's work. The drain
    (`apps/web/app/notifications/task-assigned.ts`) reads the view and answers
    two questions: `briefableToday` (the same allowlist both daily sends use)
    and `window_start = today`, which is the one question the daily sends never
    ask — `active_today` is true on EVERY day of a multi-day task.
  - **`queued_date` is the dedup key, and it is a LISBON DAY.** One person hears
    about one task at most once a day, however many times it is reassigned. The
    other candidate — a partial unique where `notified_at is null` — lets a task
    taken off somebody and given back the same afternoon announce itself twice.
  - **Deny-all for tenants**, like `notification_log` and `worker_day_links`:
    RLS on, zero policies, every grant revoked. A row here causes a WhatsApp
    message in Capo's voice to a real crew member, so a tenant who could write
    one could message another company's crew, and one who could update one could
    silence their own.
  - **Free inside the window, PAID and capped outside it.** Inside the crew
    member's own 24 hours it is free text carrying the WHOLE day, rendered by
    `renderWorkerFreeForm` with the new task marked — one renderer, shared with
    07:00, because two would eventually describe a task differently. Outside, it
    is `capo_task_assigned`, claimed in `notification_log` under kind
    `task_assigned`, so that table's unique key caps it at ONE per crew member
    per day: a second assignment the same afternoon deliberately sends nothing,
    because the first template already asked for a reply and a reply opens the
    free window. **`TASK_ASSIGNED_APPROVED_LANGUAGES` starts EMPTY** and the
    template was submitted 3 Sep 2026 with all three locales PENDING review; a
    locale is switched on by hand only once `whatsapp-template status` shows it
    APPROVED. Until then an out-of-window crew member gets nothing extra and
    tomorrow's briefing carries the task. ⚠ `whatsapp-template` needs
    `WHATSAPP_WABA_ID=715247827972608` with the token in `.env.local`, or its
    discovery step refuses and nothing is submitted. Runbook §6d.
  - **The QUEUE ROW is the lock on the free path.** Nothing free may go in
    `notification_log`, so rows are CLAIMED before the Graph call — one atomic
    `update ... set notified_at = now(), outcome = 'sending' where id in (...)
    and notified_at is null returning id` — and only what came back is sent
    about. `ENGAGED_OUTCOMES` counts `'sending'` as "already messaged", which is
    what makes the coalescing window work in the two-seconds-apart case rather
    than only across whole drains. `claimThenSend` in
    `apps/web/lib/task-assigned-plan.ts` takes both sides injected, so `pnpm
    whatsapp-check` asserts the ORDER — which no type checker can see.
  - **The trigger fires on an ASSIGNEE CHANGE or an INSERT, and nothing else.**
    Not on status: `resolve_task_review(..., 'rejected')` moves a task from
    `pending_review` back to `in_progress` (0018), and queueing there tells the
    crew member whose completion claim was just rejected that they have a NEW
    task. Not on `start_date` either: `apply_reschedule` re-dates an existing
    task, and the copy this queue produces says "new".
  - **A notice queued on an earlier Lisbon day is `stale` and is NEVER sent**
    (`noticeIsStale`). Evening admin planning tomorrow's work is the common
    case: the notice survives the night because the out-of-hours branch does not
    consume rows, and at 08:00 the task now does start today, so without this it
    goes out an hour after the 07:00 briefing already said it.
  - **A task no longer on that person's board is `reassigned`, and sends
    nothing.** `renderWorkerFreeForm` short-circuits on an empty day, so the
    message would otherwise read "your boss just gave you a new task", followed
    by the nothing-today line.
  - **Working hours are Lisbon 08..18 inclusive** (`withinAssignmentHours`,
    `apps/web/lib/task-assigned-window.ts`, pinned by `pnpm scheduler-check`).
    Deliberately NOT `withinSendWindow`: this models a working DAY, not a send
    aimed at an hour and absorbing cron drift. An out-of-hours notice is the one
    branch besides the coalescing deferral that is NOT stamped decided —
    `notified_at` stays null, the next in-hours drain finds the task no longer
    starts today, and it is dropped as `not_today`, which is right because the
    07:00 briefing carries it.
  - **Five in-request `after()` calls plus a `*/15` cron, and the cron is the
    MECHANISM.** Same relationship `/api/cron/push` has with its producers: the
    five calls make the message arrive in seconds, the sweep makes a forgotten
    sixth door cost lateness rather than silence. It has NO hour gate of its own
    — the quiet-hours rule belongs to the drain and stating it twice would let
    the two drift. The drain never throws, at any level, and opens its own
    service-role client like `dispatchPushes` so every call site stays one line.
  Known and NOT done: a manager assigning several tasks one at a time gets ONE
  message for the first and the rest are deferred by `COALESCE_WINDOW_MS` into
  the next cron tick — so the follow-ups are up to fifteen minutes late by
  design. Nothing sweeps `task_assignment_notices`; drained rows stay as the
  record of who was told what.
- Views may only be extended with `create or replace view` **appending**
  columns (Postgres forbids reorder/retype). Code reading a view that a
  pending migration extends should `select('*')` and treat the new fields as
  optional, so a deploy landing before its migration degrades instead of
  erroring — see `0013` and the comment in `agenda.ts`.
- **The crew agent knows WHO IT IS TALKING TO, and that is not a loosening of
  the worker prompt's deliberate absences** (`loadWorkerIdentity` /
  `buildIdentityBlock` in `packages/core/src/agent/worker-context.ts`). A crew
  member asked "who am I?" and Capo answered that it could not give out
  personal information — which was not a guardrail working, it was the model
  correctly reporting it had been told nothing. Four things:
  - **The line is "facts about the person holding the phone", never "facts
    about the company".** The block carries their own name, their own trade,
    the company's name, at most THREE manager names and the language they are
    being written to in. The absences listed at the top of `worker-context.ts`
    are unchanged: no memories, no proposals, no company snapshot, no
    conversation summary, and above all no other crew member's name, number or
    work. Widening it past those five fields is a decision, not a tidy-up.
  - **Manager names come from `profiles.full_name`**, which managers type about
    themselves — the same reasoning that lets #47's thread notes carry
    `workers.name`. Never a phone number and never an email.
  - **It is loaded in ONE place, `handleWorkerInbound`, and it fails soft.**
    Three small reads behind one `try`; any failure returns null and the block
    is simply absent, which is byte-for-byte the pre-W4 prompt. The WhatsApp
    route gained no query.
  - **It sits BELOW the cache breakpoint and must stay there.** Every field is
    per-WORKER, so above the line it would write one cache entry per crew
    member and read none — the trap `loadManagerName` had to avoid on the
    manager side (#62). `pnpm cache-check` asserts the cached half is IDENTICAL
    for two different crew members, which is the assertion that catches a
    migration upward.
- **A crew member's VOICE NOTE is transcribed and answered** (`apps/web/lib/
  worker-audio.ts`, W4). This REVERSES PRD 4's written-down decision that
  worker audio falls to the generic `workerAck`. The cost argument was sound
  and the trade was not: crew on site talk far more than they type, so the
  channel's own audience was the one paying for it, and what they got back was
  the line written for a sticker. Five things:
  - **A transcript is worker-authored text and nothing more.** It lands in
    `worker_messages` exactly as a typed message would, and NOWHERE else —
    never `messages`, a summary, a memory or a proposal (0027).
  - **THE TRANSCRIPTION HAPPENS BELOW THE DAILY BUDGET, and that is why
    `inbound.transcribe` is a CALLBACK rather than a string.** The caller cannot
    know whether this crew member has any allowance left without the two counted
    queries inside `handleWorkerInbound`, so a route that transcribed first and
    passed the text would pay for a media download plus a Gemini call on every
    voice note from an exhausted worker, for ever, while `worker-core.ts` went
    on claiming "an exhausted worker costs two counted queries and nothing
    else". Handing in the RECIPE instead of the RESULT is what keeps that
    sentence true. Never call `transcribeWorkerAudio` from the route.
  - **A FAILED transcription consumes one unit of budget**, by persisting
    `UNINTELLIGIBLE_AUDIO_TEXT` — our own copy, PHOTO_ONLY_TEXT's shape — in
    place of the transcript. `readWorkerBudget` counts `role='user'` rows, so a
    failure that wrote nothing would be free to repeat for ever on the one path
    where somebody hostile chooses both the payload and how often it arrives.
    The Gemini call was made; one unit is the honest price.
  - **⚠ THE KEYWORD TABLES DO NOT RUN ON IT.** All five (STOP/START, the report
    keyword, PT/ES/EN, MENU, OK) are reached through ONE seam, `keywordText` in
    `apps/web/lib/worker-keywords.ts`, which answers `undefined` for anything
    that is not typed text — so a SPOKEN "stop" reaches the agent instead of
    unsubscribing, and an armed problem report (`problem_report_requests`) is
    not consumed by a voice note either. That is the correct side of the trade
    — those tables exist so a MODEL can never intercept a tap, and a transcript
    is already model output — but it is a decision, and the written STOP remains
    the unsubscribe Meta requires. `pnpm whatsapp-check` asserts it AT THAT
    SEAM: a change that let a transcript through would have to make
    `keywordText` return something for a non-text message, and the check fails
    the moment it does.
  - **ONE size cap, shared with the manager path.** `WORKER_AUDIO_MAX_BYTES` IS
    `MAX_AUDIO_BYTES`; two numbers would drift into a voice note refused at a
    size a manager's is accepted at, with nothing saying why.
  - **⚠ THE WORKER PATH TRANSCRIBES WITH NO COMPANY VOCABULARY.**
    `TranscribeAudioInput.vocabulary` is a REQUIRED `'company' | 'none'`, never
    optional and never defaulted, because the convenient value is the unsafe one
    here. `'company'` injects up to 50 crew names, 50 obra names and 40 learned
    terms into the transcription instruction — right for a manager, whose own
    data it is, and the single biggest lever on accuracy. On the crew path the
    audio is chosen by whoever holds the phone, and the worker prompt is built
    around naming no other crew member, no other task and nothing of the
    company's shape (`worker-context.ts`); a roster one prompt line away from an
    attacker-chosen payload would move that boundary into a sentence. The cost
    is a worse transcript, never a leak. `whatsapp-check` asserts scope `none`
    reads NOTHING from the database, with a positive control on `'company'`.
  - **The spend is filed against `{ kind: 'worker', workerId }` on surface
    `worker_chat`**, through `transcribeAudio`'s optional `usage` override.
    Actor and surface travel together in ONE object on purpose: setting the
    actor and forgetting the surface would file a crew member's spend under the
    manager's dictation line with no error anywhere. `transcribeAudio` must
    never gain a worker id on `profileId`.
  - **One failure line for all three causes** (download, transcription, empty
    or too-short transcript). A crew member can do exactly one thing about any
    of them, and an error surface that varies with the cause tells whoever is
    probing it which half broke. `whatsapp.worker_audio_failed` carries the
    reason; grep it before concluding nobody sends voice notes.

## Local tooling

- **Stripe CLI** (`stripe`, installed via `brew install stripe/stripe-cli/stripe`,
  logged in with `stripe login`) — use for local billing work instead of
  editing webhook destinations in the Stripe Dashboard:
  - `stripe listen --forward-to localhost:3000/api/stripe/webhook` — forwards
    live test-mode events to the local dev server and prints a `whsec_...`
    signing secret; put that in `.env.local` as `STRIPE_WEBHOOK_SECRET` for
    local testing (separate from the production destination's secret in
    Vercel).
  - `stripe trigger checkout.session.completed` (or
    `customer.subscription.updated` / `.deleted`) — fires a synthetic test
    event at whatever `stripe listen` is forwarding to, without needing a
    real Checkout session.
  - `stripe logs tail` — tails live API request/event logs, useful when a
    webhook delivery from the Dashboard shows as failed and the response
    body isn't enough to diagnose.
  - Always confirm test mode (`stripe config --list` shows the active key)
    before running `trigger`/`listen` against anything — these hit real
    Stripe API state, just in the test-mode ledger.

<!-- BEGIN:codex-review-guidelines -->
## Codex Review Guidelines

This repository has no general test suite. The only automated correctness
check is `pnpm scheduler-check`, which covers the plan scheduler and the
working-day calendar and nothing else. Do not assume incorrect logic
elsewhere will be caught — it will not. Treat this as reason to be more
conservative and explicit in review comments about correctness risk, not
less.

The merge gate in CI is `pnpm turbo lint typecheck build` across the whole
workspace, plus `pnpm scheduler-check`:

- `lint` (ESLint flat configs per package, all based on `eslint-config-next`)
- `typecheck` (`tsc --noEmit` per package; every tsconfig extends
  `@capo/config/typescript/*` with `"strict": true`)
- `build` (`next build` — a full production build of every app must succeed)
- `scheduler-check` (deterministic assertions over the plan scheduler and the
  PT working-day calendar; the only correctness check that runs per PR)

When reviewing a PR, prioritize feedback in this order:
1. Correctness bugs and logic errors (most important, since nothing else
   will catch these).
2. Anything that would break `next build` or introduce a type error
   (`tsc --noEmit` runs in CI per package, all `"strict": true`).
3. Anything that would trigger an ESLint error under the Next.js
   core-web-vitals + TypeScript rule sets.
4. Next.js App Router conventions and idioms — this is a Next.js 16 App
   Router project deployed on Vercel. Before flagging anything as
   "deprecated" or "wrong" based on prior Next.js versions, check
   `node_modules/next/dist/docs/` for current behavior; this Next.js version
   has breaking changes versus older training data (see the section above).
5. Style/readability nits (lowest priority, and optional to raise at all).

Do not recommend adding a test suite as a blocking fix for a specific PR —
that's a separate, larger initiative. It is fine to suggest it as a
non-blocking follow-up.

Server-only environment variables (e.g. `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`) are read lazily inside functions, not at module
scope — flag any change that would move that access to module scope or into
a statically-rendered page/route, since that would break `next build` in CI
(and in Vercel's build) once those secrets aren't present at build time.
<!-- END:codex-review-guidelines -->
