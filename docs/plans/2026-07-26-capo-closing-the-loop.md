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
| 1 | Core | Working-day scheduler + Portuguese national holidays |
| 2 | Core | `agenda` + `materials_outlook` tools; `list_tasks` date filters |
| 3 | Core | Orchestration + planner prompt updates to match |
| 4 | Web | Chat error surface, stop/retry, refresh-after-write, growing composer |
| 5 | Web | **Materiais** screen (tonight's actions) + crew load/SMS-reachability on `/perfil` |
| 6 | Operator | Health home (at-risk companies, stuck proposals, dispatch, KB) + activation funnel |
| 7 | Docs | Runbooks, human-todo, AGENTS.md |

## Reconciled with main (two branches landed while this was in flight)

PR #7 (`/tarefas` board + `/perfil`) and PR #8 (multilingual + WhatsApp voice
notes) both merged during this session and overlapped heavily. Rather than
force my version through, I took main's wherever it solved the same problem
better:

- **My migration `0013_dashboard_materials_team.sql` was deleted outright.**
  Main's `task_board` view already exposes `materials`, `assignee_worker_id`,
  `duration_days` and — via `window_start`/`window_end` — an arbitrary date
  range. Extending `dashboard_tasks` alongside it would have left two
  competing read surfaces. **Net result: this work now ships with no
  migration at all**, so there is no deploy-ordering hazard.
- **`agenda` was rewritten onto `task_board`**, and its horizons are now the
  board's own chip names — `hoje / amanha / atrasadas / risco / semana`. It
  gained the `risco` horizon and per-task risk reasons for free.
- **My Hoje/Amanhã/Atrasadas screens, the segmented switcher, and my
  `task-actions`/`task-toggle` were dropped** — main's filter chips on
  `/tarefas` are a better answer to the same problem, and its `_tasks/`
  actions already do the job.
- **My standalone Equipa screen was dropped**; the crew card main put on
  `/perfil` was enriched in place with load, overdue count, and the
  who-gets-no-SMS warning.
- **All new copy went through `@capo/i18n`** in pt-PT, es-ES and en-US, since
  main made every user-facing string locale-driven.
- Nav is now **Chat · Tarefas · Obras · Materiais · Perfil**.

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

- **No migration of its own** after the reconciliation above — but it depends
  on `task_board` from `0013_task_board.sql`, and on `0014_language.sql`,
  neither of which was applied to production by the sessions that wrote them.
  See `docs/human-todo.md` §8. Apply those before deploying.
- **The Spanish register is now inconsistent with the docs.** `CONTEXT.md`
  says Rioplatense; `packages/i18n/src/dictionaries/es-ES.ts` is Peninsular
  (`tú`). I matched the existing dictionary rather than mixing two registers
  in one file, but only Federico can settle which is right.
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
