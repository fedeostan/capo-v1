# Capo — closing the loop (2026-07-26)

Autonomous overnight session. Goal from Federico: *"everything we have today
looks better, works better, it's 10x better — users have a great experience,
the agent works better, and I (solo owner) have visibility and control."*

## What I found

The codebase is small (~6.6k LOC), well-factored, and the baseline gate
(`pnpm turbo lint typecheck build`) is green. The architecture is sound: the
system/user client split, RLS as the tenant boundary, and the propose/guard
structural safety boundary are all real and worth preserving exactly as they
are.

The gaps are not architectural. They are that **the product stops short of
the loop it promises**, in five specific ways:

1. **Capo and the dashboard can disagree about "today".** The Hoje/Amanhã/
   Atrasadas screens read `dashboard_tasks`, where the active-window logic
   (`lisbon_today() between coalesce(start_date, created_at) and
   coalesce(due_date, 'infinity')`) lives in SQL. The agent has only
   `list_tasks` — 50 raw rows, no date filter — so when the manager asks
   "o que temos hoje?" the model re-derives the date math by hand. Two
   answers, one product. That is a trust bug, not a polish bug.

2. **The killer feature is not built.** `00_VISION/02-solution-mvp.md` calls
   materials anticipation "the killer feature" and `03_PRODUCT/02-flows.md`
   specifies a "tonight's actions" panel. `tasks.materials` has existed since
   migration 0010. Nothing in the product ever reads it.

3. **The manager cannot see their team.** There is no worker screen at all.
   The 07:00 SMS dispatch is invisible from the app — the manager cannot
   answer "who gets a message tomorrow, and about what?"

4. **The plan scheduler counts weekends and holidays as working days.**
   `due_date = start_date + duration_days - 1` in *calendar* days. A 5-day
   task starting Thursday is due Monday — 3 working days. And a plan will
   happily schedule work on 25 de Abril or Natal. A Portuguese builder
   notices this immediately, and it silently compresses every plan.

5. **The chat swallows its own failures, and the operator app has no health
   signal.** `useChat`'s `error` is never read: a 402 (billing blocked) or a
   500 leaves the manager typing into a void. On the operator side there is
   no answer to "is anything broken, and who is stuck?"

## What I am building

Ordered by dependency, each step keeping the gate green.

| # | Area | Change |
|---|---|---|
| 1 | DB | `0013` — extend `dashboard_tasks` (materials, assignee, duration, address, `active_this_week`) so SQL stays the single source of date truth |
| 2 | Core | Working-day scheduler + Portuguese national holidays |
| 3 | Core | `agenda` + `materials_outlook` tools; `list_tasks` date filters |
| 4 | Core | Orchestration + planner prompt updates to match |
| 5 | Web | Chat error surface, stop/retry, refresh-after-write |
| 6 | Web | **Materiais** screen (tonight's actions), **Equipa** screen, agenda segmented nav with counts, quick-complete everywhere |
| 7 | Operator | Health home (at-risk companies, stuck proposals, dispatch, KB) + activation funnel |
| 8 | Docs | Runbooks, human-todo, AGENTS.md |

## What shipped

All of the above, plus two things the plan did not anticipate:

- **`pnpm scheduler-check`** — 21 deterministic assertions over the scheduler
  and the PT working-day calendar, needing no credentials, wired into CI. The
  repo had no automated correctness check at all; this is the slice that can
  run on every PR, and it guards the exact bug fixed in step 2.
- **`agent-smoke` now asserts on tool choice**, not just on prose. A reply can
  read perfectly while the agent quietly goes back to hand-rolled date
  arithmetic, so two new checks confirm that "o que temos para hoje?" reaches
  for `agenda` and "o que preciso de comprar?" reaches for `materials_outlook`.

Verified: `pnpm turbo lint typecheck build` green (12/12),
`pnpm scheduler-check` green (21/21), and the new screens rendered and
eyeballed against mock data at 420px.

Not verified (needs Federico): anything requiring credentials or a real
device — `pnpm agent-smoke`, `pnpm rls-matrix`, and the on-phone QA in
`docs/human-todo.md` §6.

## Known limitations, stated deliberately

- **Migration 0013 is not applied.** It is a production database; running
  migrations there is Federico's call. The code degrades softly without it
  (see `docs/human-todo.md` §0), but Materiais and the team load counts stay
  empty until it lands.
- **The worker half of the loop is still one-way.** Materials anticipation is
  now real on the manager's side; the 18:00 push to workers is n8n work and
  remains in the backlog, with the query it needs documented.
- **Flow 4 (the client share link) is still unbuilt.** Untouched by this
  session.
- **Operator aggregations are pilot-scale** and silently capped at
  PostgREST's 1000-row default — commented at the call site.

## Invariants I am not touching

- `dispatch_tasks_today` / `dispatch_log` semantics (external n8n/Twilio contract).
- `getDb()` vs `createUserClient()` split.
- The propose/guard boundary — including `matchesManagerInstruction`, which is
  Federico's safety dial.
- RLS as the tenant boundary.
