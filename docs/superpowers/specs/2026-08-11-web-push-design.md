# Web Push (PRD 7, issue #25) — design

**Date:** 2026-08-11
**Status:** approved by Federico (trigger scope, send timing, quiet hours, payload
content, logout behaviour and the approve-from-notification exclusion all chosen via Q&A)
**Depends on:** #24 (`notifications`, migration `0024`) — merged.

## Problem

A manager learns that a worker declared a task finished only by opening the app
(the `/notificacoes` inbox and the blue shell strip, #24) or at the next 07:00
WhatsApp briefing. There is no way to reach a manager whose phone is in their
pocket. The PWA has no push support of any kind: `apps/web/public/sw.js` is 33
lines handling `install`/`activate`/`fetch` only, and the repo contains zero
occurrences of `web-push`, `pushManager`, `PushSubscription`, `VAPID` or
`Notification.requestPermission`.

What already exists and is load-bearing here: the service worker is registered
(`apps/web/app/sw-register.tsx`), there is an install-to-home-screen guide at
`/instalar` with client-side platform detection, and #24 already decided **who**
is told **what** — one `notifications` row per recipient profile, written by a
trigger on `task_reviews`, actor excluded via `is distinct from auth.uid()`.

## Decisions (settled)

1. **Trigger scope: exactly the rows `notifications` already carries.** Today
   that is one kind, `review_pending`. No new notification kinds, no
   overdue/at-risk scanner, no check-in-answer push. Future kinds (#22, #23) get
   push with **no edit to this feature**.
2. **Send timing: immediate + a 10-minute sweep.** The immediate path fires from
   the request that caused the row; the sweep is the structural guarantee that a
   producer which forgets to call it (or a transient failure) cannot lose a
   push permanently.
3. **No quiet hours.** Sends go out whenever the row is written. Phones have Do
   Not Disturb; Capo does not reimplement it.
4. **Payload = the inbox headline, nothing more.** The catalog sentence for the
   row's `kind`, rendered in the *recipient's* `profiles.language`, plus the
   task title. `task_reviews.note` (worker-authored) never reaches a lock
   screen — it stays behind the tap, where the existing attributed-quote
   rendering applies.
5. **Sign-out removes that device's registration.** Not in the issue; added
   because crews share handsets and the alternative is one manager's alerts
   landing on a colleague's lock screen.
6. **No action buttons on the notification.** Approving a review is a decision
   made against a photo and a note; a lock-screen button invites a reflex.

## Architecture

### The `notifications` row IS the delivery queue

The single idea the rest depends on. Rather than a separate outbound queue,
`notifications` gains a delivery stamp. An unstamped row is an undelivered
parcel; a stamped row is done.

This is what makes issue #25's hardest acceptance criterion structural rather
than aspirational: **no push can exist without an inbox row, because the inbox
row is the instruction to push.** It also means the producer set stays exactly
where #24 put it — triggers on the subject table — with no push-specific
producer to keep in sync.

Deliberately NOT a `push_log` table mirroring `notification_log` (0016). That
table exists because WhatsApp sends are *paid* and need a per-send ledger with a
unique-constraint idempotency lock. Push is free, and the idempotency lock here
is the stamp on a row that already exists.

### Flow

```
worker "acabei" (WhatsApp webhook, #22)  ─┐
manager taps "pedir controlo"            ─┼──► open_task_review()
PRD 4 worker agent                       ─┘         │
                                                    ▼
                                   task_reviews_notify_pending (0024 trigger)
                                                    │
                                     one notifications row per recipient
                                          (pushed_at IS NULL)
                                                    │
                        ┌───────────────────────────┴──────────────────────────┐
                        │ immediate: after(() => dispatchPushes(companyId))    │
                        │ sweep:     /api/cron/push every 10 min, all companies│
                        └───────────────────────────┬──────────────────────────┘
                                                    ▼
                                          dispatchPushes()  [service role]
                                    per row → recipient's push_subscriptions
                                    → encrypt + POST to push service
                                    → stamp pushed_at / bump push_attempts
                                    → delete registration on 410/404
```

`dispatchPushes()` is **one function called from two places**, not two
implementations. `companyId` is an optional narrowing filter, nothing more —
the sweep calls it with none.

### Service-role access, and why it is forced

`dispatchPushes()` runs on `getDb()` (service role) even when invoked from the
immediate path inside a tenant request. This is not a convenience: the rows it
must send belong to *other* profiles, and #24's trigger specifically excludes
the actor, so the caller's own user client structurally cannot see a single row
it needs. Guardrails, to be stated in the file's header comment:

- takes only a `companyId` that came from an already-authenticated
  `requireAuth()` context, never from a request body;
- returns `void` — no data path back to the caller;
- is invoked through `after()` (Next 16, `next/server`) so it never delays the
  manager's response and a push failure can never fail their action.

## Components

### Migration `supabase/migrations/0026_push_subscriptions.sql`

```sql
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  profile_id uuid not null references profiles(id) on delete cascade,
  -- The push service URL the browser minted. Globally unique: one endpoint is
  -- one browser install, and reassignment (shared handset) must MOVE the row,
  -- never duplicate it — two rows would buzz the same device twice and, worse,
  -- buzz it for the wrong manager.
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_failed_at timestamptz
);
create index push_subscriptions_profile_idx on push_subscriptions (profile_id);
alter table push_subscriptions enable row level security;
```

- **Cross-company FK guard**, same shape as `0024`'s
  `assert_notification_fks_same_company`: a BEFORE INSERT/UPDATE trigger
  asserting `profiles.company_id = new.company_id`. RLS checks a row's own
  `company_id`, never the company of the rows its FKs point at.
- **Per-profile RLS**, two predicates like `notifications`:
  `company_id = private.current_company_id() AND profile_id = auth.uid()`, on
  SELECT, INSERT (WITH CHECK) and DELETE.
- **Column grants:** `revoke all` first (Supabase default-grants ALL), then
  `grant select, delete`, and `grant insert (company_id, profile_id, endpoint,
  p256dh, auth, user_agent)`. **No UPDATE grant** — `last_failed_at` is written
  only by the dispatcher on the service role, so a tenant cannot launder a
  failing registration into a healthy-looking one.
- **First DELETE policy in this schema.** Every other table marks rather than
  removes. Justified: this is a device registration, not a record of a business
  event, and "turn alerts off on this phone" must actually remove the address —
  a stale address the push service still honours is precisely how someone keeps
  being buzzed after opting out. Bounded to the caller's own rows and attacked
  directly by `scripts/rls-isolation-matrix.mjs`.

Same migration, on `notifications`:

```sql
alter table notifications
  add column pushed_at timestamptz,
  add column push_attempts smallint not null default 0;

-- MANDATORY. Without this, the first deploy after this migration buzzes every
-- manager about every notification ever written.
update notifications set pushed_at = now();

create index notifications_push_pending_idx
  on notifications (created_at) where pushed_at is null;
```

No grant change on `notifications`: the existing `grant update (read_at)`
already means a tenant cannot write either new column.

### `apps/web/lib/push.ts` — the transport

Wraps `web-push`. Reads `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
**inside functions**, never at module scope (AGENTS.md: a module-scope read of a
server secret breaks `next build` in CI, where secrets are absent).

```ts
export type PushOutcome = 'ok' | 'gone' | 'retry';
export function pushConfigured(): boolean;
export function vapidPublicKey(): string | null;
export async function sendPush(sub: StoredSubscription, payload: PushPayload): Promise<PushOutcome>;
```

`'gone'` on `410`/`404` only. Everything else — `429`, `5xx`, network — is
`'retry'`. Sibling of `apps/web/lib/whatsapp.ts`, which does the same job for
the two Meta routes.

`pushConfigured()` is the dispatcher's and the cron route's early exit;
`vapidPublicKey()` is what `/perfil` passes to the browser. Both read env
lazily, so both are safe to call at request time and neither exists at build
time.

**Deliberately not in `packages/core/src/channels/`,** where the WhatsApp
channel lives, and this needs saying in the file header so a reviewer does not
"fix" it: `core` is the bundle Capo's agent ships in, `web-push` is a Node-only
dependency, and push never involves a model. Adding it to `core` would make the
agent bundle Node-only for machinery it never calls.

### `apps/web/app/notifications/push.ts` — the dispatcher

Beside `inbox.ts` and `briefing.ts`, which is the right neighbourhood: the same
subject matter arriving through a third channel.

```ts
export async function dispatchPushes(opts?: { companyId?: string; limit?: number }): Promise<void>;
```

1. Select unstamped rows (`pushed_at is null and push_attempts < 3`), oldest
   first, `limit` default 200 — bounds a single run after an outage.
2. Resolve `subject_type = 'task_review'` → task id for the deep link, reusing
   the same second-query approach `loadInbox` uses (not a PostgREST embed, whose
   alias depends on a generated FK constraint name).
3. Render the headline per recipient: `getCatalog(profiles.language)` →
   `t.notifications.kind[kind](title ?? t.notifications.noSubject)`. **Same
   catalog entry and same null-title fallback the inbox uses**, so push and
   inbox cannot say different things. An unknown `kind` (a row from a newer
   deploy reaching an older bundle) is **skipped and left unstamped** rather
   than pushed as a bare title — unlike the inbox, which can degrade gracefully
   on screen, a lock-screen alert with no sentence is noise.
4. Load that profile's `push_subscriptions`. **Zero rows → stamp `pushed_at` and
   move on**; otherwise the sweep chases that row until `push_attempts` caps.
5. Send per subscription, independently — one dead phone must not cost the
   manager's other phone its alert. `'gone'` → delete the row. `'retry'` →
   `last_failed_at = now()`.
6. Stamp `pushed_at` when at least one send returned `'ok'`, **or when every
   subscription came back `'gone'`** (they have all just been deleted, so the
   recipient now has none and retrying is chasing nothing), **or when the
   profile had none to begin with**. Only a `'retry'` leaves the row unstamped:
   bump `push_attempts` and let the sweep have it.
7. `logEvent('notifications.push_dispatched', { sent, gone, retried, skipped })`
   per run — a run that sends nothing writes no rows and raises no error, which
   is exactly the shape of failure AGENTS.md flags on the cron routes.

Payload: `{ title, body, url, tag }` where `title` is the app name, `body` is the
rendered headline, `url` is `/tarefas/{taskId}` (or `/notificacoes` when the
subject no longer resolves — the inbox's `href: null` case), and `tag` is the
notification row id so a redelivery replaces rather than stacks.

### `apps/web/app/api/cron/push/route.ts` — the sweep

`authorizeCron()` from `lib/cron.ts` (shared Bearer check), then
`dispatchPushes()` with no company filter. **No `lisbon_hour()` gate** — unlike
the two daily sends, this one is meant to run every ten minutes, so the hour is
irrelevant and gating on it would be the same class of bug that made the
check-in silently never send.

`apps/web/vercel.json` gains `{ "path": "/api/cron/push", "schedule": "*/10 * * * *" }`.
The AGENTS.md `:00`-not-`:30` rule does not apply — it exists because
`lisbon_hour()` gating cannot survive cron drift, and there is no hour gate here.
Drift costs lateness on a backstop, not silence.

### Immediate path

`apps/web/app/(app)/_tasks/actions.ts` → `requestReview()` gains
`after(() => dispatchPushes({ companyId }))` after the existing
`cascadeReschedule` call.

When #22 lands, its WhatsApp-webhook path adds the same one line. If its author
forgets, the sweep still delivers within ten minutes — which is the entire
reason the sweep exists, given #22 and #23 are being built on separate branches.

### Service worker `apps/web/public/sw.js`

Three handlers added; the existing three are untouched.

- **`push`** — parse JSON, `showNotification(title, { body, tag, data: { url },
  icon: '/icon-192.png', badge: '/icon-192.png' })`. A malformed or bodyless
  push shows a generic fallback rather than nothing: some push services send a
  wake-up with no payload, and a silent no-op there is indistinguishable from a
  broken feature.
- **`notificationclick`** — `close()`, then focus an existing client on this
  origin and navigate it, else `clients.openWindow(url)`. Focusing beats opening
  a second copy of a standalone PWA.
- **`pushsubscriptionchange`** — re-subscribe with the same VAPID key and POST to
  the authenticated registration action. This fires without a session sometimes
  and will then fail; the real safety net is the client re-registering on every
  app open (below), which is idempotent.

`CACHE` bumps to `capo-shell-v2` so the new worker actually activates.

### Client: `apps/web/app/(app)/perfil/push-card.tsx`

Client component, rendered by `perfil/page.tsx` (already `force-dynamic`), which
passes `vapidPublicKey()` as a prop. **No `NEXT_PUBLIC_` variable** — the public
key is not secret but keeping all three VAPID values on one server-only path
means one place to configure and no build-time bake. Card does not render at all
when the key is absent.

States, all four explicit — silence here is what makes people think the app is
broken:

| Condition | UI |
|---|---|
| `!('serviceWorker' in navigator) \|\| !('PushManager' in window)` | render nothing |
| `detectPlatform() === 'ios'` (that value already means *not* standalone) | explanation + link to `/instalar` |
| `Notification.permission === 'denied'` | "you blocked these" + how to undo in phone settings; **no button**, because JS cannot re-prompt |
| subscribed | "on for this phone" + Desligar |
| otherwise | Receber alertas button |

Platform detection is **extracted** from
`apps/web/app/(public)/instalar/install-guide.tsx` into
`apps/web/app/platform.ts` (`detectPlatform()`, `useDetectedPlatform()`), and the
install guide imported from there. Targeted improvement to code this work
touches — the alternative is two copies of a rule about Apple that will drift.

On mount, if `Notification.permission === 'granted'`, re-read the current
subscription and re-register it. Idempotent, and this is what actually covers
rotated endpoints.

### Server actions in `apps/web/app/(app)/perfil/actions.ts`

- `registerPush(sub)` — **reclaims the endpoint on the service role first**
  (`delete from push_subscriptions where endpoint = $1`), then inserts on the
  *user* client so RLS and the column grants apply to the row being created.
  The reclaim is what handles a shared handset whose previous user's session
  expired without signing out; the endpoint is high-entropy and known only to
  that device's browser, so presenting it is the capability. Without the
  reclaim, the insert dies on the unique constraint and that phone can never
  register again.
- `unregisterPush(endpoint)` — plain delete on the user client, RLS-scoped.

Neither is behind `assertNotBlocked`. Same reasoning as `markAllRead`: a lapsed
subscription blocks changing site data; it must not trap someone into alerts
they cannot switch off.

### Sign-out

`perfil/page.tsx`'s `<form method="post" action="/auth/signout">` gains a small
client wrapper (`sign-out-button.tsx`) that, on submit, unsubscribes in the
browser and calls `unregisterPush` before letting the POST proceed. The route
itself is unchanged — the server never knows the endpoint, only the browser
does, so this cannot be done server-side.

### `/notificacoes` nudge

One line at the bottom of the inbox: "want these on your phone?" linking to
`/perfil`. It triggers no permission prompt — it only points at the card. Solves
the discoverability problem of a switch buried in a settings screen without
spending the one-shot prompt.

### i18n

New `push` section in `packages/i18n/src/dictionaries/{pt-PT,es-ES,en-US}.ts` and
the `Catalog` type: card title, subtitle, enable/disable buttons, the four
states above, the iOS explanation, the denied explanation, the inbox nudge.
`tsc` catches a missing dictionary. No new `notifications.kind` entry — push
reuses the existing sentence.

### `scripts/rls-isolation-matrix.mjs`

- `seedTenant` creates a `push_subscriptions` row per tenant (and one for the
  **colleague** profile it already seeds for `notifications`).
- `push_subscriptions` joins the visibility-matrix relation list.
- `cleanupTenant` deletes them.
- Three new adversarial attacks:
  1. tenant A SELECTs tenant B's registration → must see nothing;
  2. tenant A DELETEs tenant B's registration → must affect zero rows (this is
     the check that earns the new DELETE policy);
  3. the owner reads their **colleague's** registration in the *same* company →
     must see nothing. Without this, dropping `profile_id = auth.uid()` from the
     policies still reports green.
- A fourth on the FK guard: inserting an own-company row naming the other
  tenant's `profile_id` → rejected.

Per the AGENTS.md warning that every matrix check asserts a refusal: also verify
the owner's own registration remains readable and deletable, or a policy denying
everyone passes all four.

### `docs/human-todo.md`

New section: generate the VAPID pair
(`npx web-push generate-vapid-keys`), add `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:` address) to Vercel for
`capo-v1` only, plus the manual device checklist below. **The keys must not be
rotated after managers subscribe** — existing registrations are bound to the
public key and all of them go dead at once.

### `AGENTS.md`

New structural-invariant bullet covering: the row-is-the-queue rule, the
mandatory backfill in `0026`, `'gone'`-means-delete, the first DELETE policy, the
one-shot permission rule, and the iOS-needs-install constraint.

### `apps/web/package.json`

`web-push` + `@types/web-push`. Only new runtime dependency.

## Error handling

| Condition | Behaviour |
|---|---|
| `410` / `404` from push service | delete the registration; never retry |
| `429` / `5xx` / network | leave `pushed_at` null, `last_failed_at = now()`, bump `push_attempts`; sweep retries; give up at 3 |
| one of N subscriptions fails | others still sent; per-subscription, independent |
| recipient has no subscriptions | stamp `pushed_at` immediately |
| VAPID not configured | `dispatchPushes` returns immediately; `/perfil` card does not render; **no throw** — the app must work with push unconfigured, which is the state of every preview deploy |
| dispatcher throws inside `after()` | logged via `logEvent`; the manager's action already succeeded and must not be affected |
| recipient phone off / no signal | not handled — the push service queues and delivers on wake |

Note the accepted trade-off: three failed attempts abandons that push
permanently. The inbox row and the blue shell strip remain, so the manager is
never left uninformed — only un-buzzed.

## Testing

No test suite exists; `pnpm scheduler-check` is untouched (nothing here computes
dates). Three gates:

1. `pnpm rls-matrix` — must be green with `push_subscriptions` and the four new
   attacks.
2. `pnpm turbo lint typecheck build` — specifically, no server secret read at
   module scope.
3. **A real device checklist**, written into `docs/human-todo.md`, run once on
   iOS-installed and once on Android. This is the only gate that proves the
   feature works:
   - opt in from `/perfil`; permission box appears
   - colleague declares a task finished; locked phone buzzes within seconds
   - tap → lands on `/tarefas/{id}` with the review controls
   - Capo already open → focuses, does not open a second window
   - opt out → declare another completion → silence
   - iPhone in a plain Safari tab → the install explanation, not a dead button

## Out of scope

- Action buttons on the notification (approve/reject from the lock screen).
- Push for workers — they have no Capo account.
- Per-kind preferences; one kind exists.
- Quiet hours / delivery windows.
- App-icon badge counts (`setAppBadge`).
- New notification kinds for #22 or #23 — those land in their own issues and
  ride this feature unchanged.

## Risks

- **iOS support burden.** Safari delivers only to a home-screen-installed PWA.
  Managers who never install never get a push; the inbox and shell strip stay
  their path. Detected and explained, not silently broken.
- **Sweep depends on Vercel cron**, which this project has caught drifting ~45
  minutes. It is a backstop, so drift costs lateness — but if the immediate path
  regresses, alerts degrade to slow before anyone notices. The
  `dashboard.push_swept` log line is what makes that falsifiable.
- **First deletable table** in the schema. Bounded and matrix-tested, but a new
  shape worth a reviewer's attention.
- **New runtime dependency** (`web-push`).
- **VAPID keys are permanent once live.** Rotating them silently kills every
  existing registration.

## Amendments after implementation

Recorded, not rewritten into the body above — this section is the diff
between what was agreed and what shipped, and why. Found during the
whole-branch review that followed all fourteen tasks.

- **Registration is insert-first, escalate-on-conflict — not reclaim-first.**
  `registerPush` (design, §Server actions) was written as "reclaim the
  endpoint on the service role first, then insert on the user client." The
  code in `apps/web/app/api/push/route.ts` instead tries the plain user-client
  insert first and only reaches for the service role on `23505`
  (unique-violation). Same outcome, cheaper path: the overwhelming majority of
  registrations are a phone's first ever sign-up, which needs no elevated
  privilege at all, so paying for a service-role round trip on every call to
  cover the rare shared-handset reclaim was the wrong default.
- **The sign-out wrapper (`sign-out-button.tsx`) gained a hard ceiling and
  independent halves**, neither of which the design specified. A
  `CLEANUP_TIMEOUT_MS` (1500 ms) bounds the *whole* cleanup step so a service
  worker that never reaches `ready` (private browsing, a dropped `sw.js`
  fetch, a locked-down Android ROM) cannot hang sign-out itself — a manager
  must always be able to leave a shared phone. The server DELETE and the
  browser `unsubscribe()` also run independently (`Promise.allSettled`, not a
  sequential await), so a device that is offline — where `fetch` rejects
  outright — still unsubscribes locally instead of the exception skipping it.
- **An unrenderable `kind` is left unstamped AND its `push_attempts` is
  bumped**, not just left unstamped as originally designed (§`dispatchPushes`,
  step 3). The review that found this pointed out the design's own version was
  unsafe in both directions: stamping it (what the first implementation did)
  loses the push permanently if a newer bundle serving the same rollout could
  have rendered it moments later; leaving it alone with no attempt counter, as
  originally designed, circles it forever after a rollback that never ships
  the renderer. Bumping the counter alongside leaving it unstamped caps it at
  `PUSH_MAX_ATTEMPTS` sweeps (about 30 minutes) either way — long enough to
  outlast a rollout, short enough not to spin indefinitely.
- **The iOS branch is checked before the capability probe**, the reverse of
  the state table's listed order (§Client, the states table). WebKit gates
  `PushManager`/`Notification` behind a home-screen install, so on an iPhone
  in a plain Safari tab those APIs are likely undefined — checking the
  capability row first would hit `'unsupported'` (render nothing) before ever
  reaching the `'ios-needs-install'` row this table exists to describe. Moving
  the iOS check first fixes that; `'ios'` already implies not-standalone by
  construction (`apps/web/app/platform.ts`), so no other platform's behaviour
  changes.
