# WhatsApp BSUID — Stage 2: resolve, send, and survive rotation

Design for [issue #28](https://github.com/fedeostan/capo-v1/issues/28). Stage 1
(#27, PR #34) added storage; this stage starts reading and writing it.

Approved by Federico on 2026-08-11 with three explicit decisions, recorded in
"Decisions taken" below.

## The problem in one paragraph

Capo identifies every WhatsApp sender by phone number. Meta is taking that away:
a person who adopts a WhatsApp username has `from` omitted from their messages
entirely, leaving only `from_user_id` — a business-scoped user ID (BSUID) such as
`PT.13491208655302741918`, stable for that person across username changes and
scoped to our business portfolio. Stage 1 records the BSUID against whoever the
phone resolved to. Stage 2 resolves by it, sends to it, and keeps it current when
Meta regenerates it.

## Preconditions established before this work started

- Migration `0022_whatsapp_bsuid.sql` was written by Stage 1 but **never applied**.
  Applied to the live project on 2026-08-11 (version `20260811…`, name
  `whatsapp_bsuid`) after confirming `list_migrations` matched
  `supabase/migrations/` with exactly that one gap. Until then every capture
  attempt was failing with "column does not exist" and being swallowed by design,
  so no BSUID had ever been recorded and the 30-day binding window was being spent
  for nothing.
- Live grants verified directly rather than trusted from comments. `0022`'s own
  note claims `workers` carries a table-wide UPDATE grant to `authenticated`; that
  was true when written and is **false now** — `0025_whatsapp_optin.sql:78-79`
  revoked it and re-granted a column list
  (`name, trade, phone, active, language, whatsapp_opt_in_at, whatsapp_opt_out_at`)
  that excludes `whatsapp_user_id`. Do not repeat the stale claim.

## Decisions taken

1. **Apply `0022` before building.** Done, see above.
2. **Both daily sends, not just the 07:00 briefing.** The 16:30 check-in reaches
   its recipients through the same `loadCompanyBriefing`, so making the briefing
   BSUID-capable and leaving the check-in phone-only would mean telling a worker
   their tasks in the morning and never asking whether they finished. The issue
   names only `cron/reminders`; this is a deliberate, minimal widening.
3. **Accept the residual forge vector, guard it, document it, file a follow-up.**
   A tenant can no longer UPDATE `workers.whatsapp_user_id`, but `authenticated`
   still holds a table-wide INSERT on `workers`, and `workers_insert_company`
   constrains only `company_id`. So a tenant can CREATE a crew row in their own
   company carrying any BSUID they like, including one belonging to another
   company's worker. The `.limit(2)` ambiguity guard turns that into silence for
   both parties rather than a wrong answer or a leak — a denial of service against
   one worker's acknowledgements, not a data exposure. The manager side has no
   equivalent hole: `profiles.whatsapp_user_id` is `unique` and `authenticated`
   holds neither UPDATE nor a way to reach it.

## 1. Inbound resolution — phone first, always

An ordered chain, stopping at the first hit:

| # | Table | Key | Notes |
|---|-------|-----|-------|
| 1 | `profiles` | `phone` | today's query, unchanged |
| 2 | `profiles` | `whatsapp_user_id` | new; unique column, so `maybeSingle()` |
| 3 | `workers` | `phone` | today's query, unchanged |
| 4 | `workers` | `whatsapp_user_id` | new; non-unique, so `.limit(2)` + ambiguity guard |

Two properties this ordering buys, both load-bearing:

- **Today's traffic takes a byte-identical path.** Steps 1 and 3 run the same
  queries with the same column lists in the same order. Nothing added here can
  regress the 100% of traffic that currently works.
- **The new lookups are separate queries, never widened column lists.** Adding
  `whatsapp_user_id` to the `select` in steps 1 or 3 would couple sender
  resolution to the migration: a deploy landing first gets a PostgREST 42703, the
  lookup returns null, and *every manager* becomes an unknown sender. As separate
  queries the same failure costs one log line and the fallback finding nobody.
  This is the same reasoning `captureBsuid` documents in Stage 1.

Steps 2 and 4 are skipped entirely when the message carries no `from_user_id`, or
when it carries one that fails `isBsuid` (which is also what rejects a parent
BSUID).

Unknown by all four remains today's silent no-op — no reply, no error body, no
distinguishing log. `company_id` still comes from the matched row and never from
the payload; the proposal-ownership read on the button path is untouched.

## 2. Outbound — a discriminated recipient

Meta will not accept a BSUID in `to`. It is a sibling property, `recipient`,
carrying a plain string (confirmed against third-party documentation quoting the
Graph API request body; Meta's own page is JS-rendered and unfetchable).

`WhatsAppSendConfig.to: string` is replaced by:

```ts
export type WhatsAppRecipient =
  | { kind: 'phone'; waId: string }   // digits, no '+'
  | { kind: 'bsuid'; userId: string };
```

`post()` emits `to` **xor** `recipient` — never both. Sending both is legal and
`to` wins, which is precisely why we do not: the response then cannot tell us
which envelope was actually used.

`toSendTarget()` (the E.164 → wa_id strip) stops being exported. The only way to
construct a phone recipient is `phoneRecipient(e164)`, which calls it; the only
way to construct a BSUID recipient is `bsuidRecipient(userId)`, which cannot. The
requirement that phone-digit surgery is unreachable from the BSUID branch is
therefore structural rather than a comment.

Error code `131062` (*BSUID recipients are not supported for this message*) joins
the annotated list on `WhatsAppSendError`. It applies to authentication templates
only; `capo_daily_briefing` and `capo_task_checkin` are UTILITY and eligible.

## 3. The webhook change router

`entry[].changes[]` is currently flat-mapped straight to `value.messages`, with
`change.field` ignored. A `user_id_update` change carries no `messages` array and
is therefore dropped today without a trace.

A pure, generic router moves into `packages/core/src/channels/whatsapp.ts`:

```ts
routeWebhookChanges<M>(body): {
  messages: M[];
  rotations: BsuidRotation[];
  unhandledFields: string[];
}
```

It lives in `@capo/core` rather than the route for the reason `parseProposalButtonId`
and `isBsuid` already do: `scripts/whatsapp-check.mts` can then assert it with no
credentials and no network, and that script is the only automated gate this
feature has. It is generic in `M` so `WhatsAppMessage` — and the substantial
documentation attached to it — stays in the route where it is used.

The router is purely structural: it sorts, it does not validate. Validation of
`current`/`previous` with `isBsuid` happens in the applier, so an invalid value
produces a distinct log rather than being silently dropped by the sorter.

`parent_user_id` is read and discarded wherever it appears, with a comment. Capo
is a single portfolio; a parent BSUID would look like an identity while belonging
to nobody in particular, and `isBsuid`'s single-dot rule already refuses it.

Unrecognised fields produce one `whatsapp.unhandled_field` log and are ignored.
Today they vanish entirely, which is what would make Meta's next addition
invisible rather than merely unhandled.

## 4. Rotation

`user_id_update` entries are documented (in the issue, sourced from Meta's
changelog) as `{ wa_id?, user_id: { previous, current } }`. No public third-party
documentation quotes this payload verbatim, so the parser is **tolerant**: it
accepts that shape, and logs a distinct event when a `user_id_update` change
arrives whose entries it cannot read. A shape surprise must be discoverable, not
silent.

The applier rewrites `whatsapp_user_id` from `previous` to `current` on `profiles`
and on `workers`, and logs one of three outcomes:

- rewrote at least one row → `whatsapp.bsuid_rotated`
- matched nothing → `whatsapp.bsuid_rotation_orphan`, **the "we just lost
  someone" alarm**, distinct precisely because it is otherwise invisible
- `current` or `previous` fails `isBsuid`, or the write errors →
  `whatsapp.bsuid_rotation_failed`

Rotations are applied inside `after()`, like every other write on this route, so
Meta's ack is not delayed. They are registered before the message loop, but Next's
`after()` gives no hard ordering guarantee, so a batch containing both a rotation
and a message from the new BSUID may resolve the message against the old value.
Rare — the two arrive as separate webhook deliveries in practice — and
self-healing on the next message. Commented, not pretended away.

`system` messages with `system.type === 'user_changed_user_id'` are a secondary
signal. They currently fall into the unsupported-type triage, which is safe. They
gain a distinct log and, when the payload carries both ids, a rotation. Belt and
braces, never the primary path.

**External step, outside this repo:** the app must be subscribed to the
`user_id_update` webhook field in the Meta App Dashboard, or none of this ever
fires. Recorded in `docs/whatsapp-cloud-api-runbook.md`.

## 5. The two daily sends

`WorkerBriefing.phone: string` becomes `recipient: WhatsAppRecipient`, built in
`loadCompanyBriefing`: prefer `phone`, fall back to `whatsapp_user_id`, drop only
when neither exists. Both crons inherit it without implementing anything, which is
the same argument that put the consent gate there.

`cron/reminders` gains the same preference for managers. `profiles.phone` is
`not null`, so "neither usable" is close to unreachable there, but the branch
exists and resolves the claim as `'skipped'` with a log rather than throwing — one
unreachable recipient must never abort the run.

`dry_run=1` gains an address-kind label per send. It already prints the full
phone; that is unchanged, and the kind is added beside it.

`notification_log` needs no schema change: it keys on `worker_id`/`profile_id`,
never on an address. The claim protocol is untouched.

Honest scope note: this half is mostly future-proofing. A stored phone number keeps
working after its owner adopts a username. The BSUID send path becomes load-bearing
the day a stored number stops working, or for someone who never gave us one.

## 6. Verification

- `pnpm whatsapp-check` gains: phone recipient → `to` and no `recipient`; BSUID
  recipient → `recipient` and no `to`; the router over all three change kinds; and
  inbound fixtures for phone-only, BSUID-only, and both.
- `pnpm turbo lint typecheck build`.
- `pnpm rls-matrix` is on the issue's checklist but needs live credentials, which
  are write-only in Vercel on this project. If it cannot run, that is reported as
  a gap rather than claimed green.
- End-to-end without waiting on rollout: Meta's webhook test tool, App Dashboard →
  Use cases → Connect with customers through WhatsApp → Customize → Configuration →
  Test. The scenario that matters is *"user has adopted a username and phone number
  is unavailable"*.

## Out of scope

`REQUEST_CONTACT_INFO`, reserving a business username, parent BSUIDs, and
status/`contacts` webhook parsing — all per the issue. Also unchanged: the tenant
boundary. A BSUID is scoped to our business portfolio, not to a tenant, so it is
exactly as tenant-ambiguous as the phone number it replaces. RLS remains the
boundary and is not touched.
