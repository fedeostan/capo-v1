# Narrowing the INSERT grant on `workers` (issue #39)

**Date:** 2026-08-12
**Issue:** [#39](https://github.com/fedeostan/capo-v1/issues/39) — follow-up from #28
**Migration:** `0028_workers_insert_grant.sql`

---

## 1. What this is about, in plain language

Every crew member in Capo has a row holding their name, trade and phone. Since
#28 that row can also hold a **WhatsApp identity code** — a string Meta gives us
(`PT.13491208655302741918`) that identifies a person even when their phone
number is hidden behind a username. It is how Capo knows which worker just
replied.

Today a Capo customer can create a crew row in their own company and type
**any** WhatsApp identity code into it, including one belonging to another
company's worker. Capo would then see two crew rows claiming to be the same
person and, by design, answer neither. The effect is that the victim's replies
to Capo silently stop working.

Nothing leaks: the worker acknowledgement contains no tenant data, and the
attack requires knowing a code Capo never displays anywhere. This is a door
being closed deliberately, not an incident.

After the change, a manager fills in the boxes a manager legitimately fills in.
The identity-code box is written only by Capo's own server, when a worker sends
a message. Nothing a manager does changes.

## 2. Live state, verified 2026-08-12

Queried against project `qdfmvhjrcmeoxbattnsm`, not read off the migration
files — see [[verify-grants-against-the-live-db]]; grants go stale in prose
silently.

`workers`, role `authenticated`:

| Privilege | Scope today |
|---|---|
| SELECT | table-wide |
| INSERT | **table-wide — all 11 columns, `whatsapp_user_id` included** |
| UPDATE | column-scoped to 7: `name, trade, phone, active, language, whatsapp_opt_in_at, whatsapp_opt_out_at` (`0025`) |
| DELETE | table-wide grant, but **no DELETE policy exists**, so RLS refuses every attempt |

Policies on `workers`: `workers_select_company`, `workers_insert_company`
(`with check (company_id = private.current_company_id())` — constrains the
company and nothing else), `workers_update_company`. All `to authenticated`.

`anon` holds the same table-wide INSERT. Harmless today only because every
policy is `to authenticated`, so a logged-out request fails the second check.
That is one lock, not two.

### `profiles` is safe — but not for the reason previously recorded

AGENTS.md and #39 both say `profiles.whatsapp_user_id` is safe because the
column is `unique` and absent from the tenant's UPDATE grant. Both true. But the
tenant's **INSERT** grant on `profiles` *does* include `whatsapp_user_id`.

What actually blocks it is that `profiles` has **no INSERT policy at all** —
only `profiles_select_own` and `profiles_update_own`. Under RLS, an INSERT with
no permissive policy is refused outright. Profile rows are created by
`complete_onboarding()`, which is SECURITY DEFINER and bypasses this.

This is worth stating because the protection is load-bearing and invisible: the
day anyone adds an INSERT policy to `profiles` for any reason, the stale grant
becomes a hole on the manager side — which is the side with the data behind it.

**Decision: `profiles` is not touched by this migration.** Narrowing its INSERT
grant would change no behaviour today and would risk mis-enumerating a second
column list for zero present benefit. The trap is recorded here and in
AGENTS.md instead.

## 3. Two errors in the issue text, corrected

**The proposed column list would break a working feature.** #39 suggests
granting `company_id, name, trade, phone, active, language`. `add_worker` also
writes `whatsapp_opt_in_at` / `whatsapp_opt_out_at` when the manager attests
consent ([`workers.ts:77`](../../../packages/core/src/capabilities/workers.ts)).
Shipping that list would make "adiciona o Zé, ele concordou em receber
mensagens" fail with `42501 permission denied for column whatsapp_opt_in_at`.
This is exactly the non-additive-grants trap #39 itself warns about, reproduced
inside its own snippet.

**`/perfil` has no add-crew-member form.** The Equipa card there is read-only
(`loadTeam` in `apps/web/app/dashboard-data.ts`). The only tenant-path INSERT
into `workers` anywhere in the repo is `add_worker`, reached through chat. The
positive-path check is therefore "add a worker via the agent tool", not "use the
Perfil form".

## 4. The change

```sql
revoke insert on table workers from anon, authenticated;
grant insert (company_id, name, trade, phone, active, language,
              whatsapp_opt_in_at, whatsapp_opt_out_at)
  on table workers to authenticated;
```

Eight columns: **the seven `0025` already allows a tenant to edit, plus
`company_id`.** That is the whole rule, and it is stateable in one sentence,
which is the point — a future reader can check it mechanically against `0025`.

Excluded, and why:

- `whatsapp_user_id` — the hole. Written only by the service role, in
  `captureBsuid` and `applyBsuidRotation`, which bypass grants entirely.
- `id`, `created_at` — database-generated defaults. No code path supplies
  either, and a tenant choosing its own primary key buys nothing.

Granting `active` and `language` widens no authority: both are already in the
tenant's UPDATE grant, so a tenant that could not set them on INSERT could set
them a millisecond later. Including them keeps the rule simple and avoids a
future breakage for nothing gained.

`anon` is revoked and not re-granted.

### Why an allowlist and not a rule forbidding the one column

The alternative is keeping the table-wide grant and tightening
`workers_insert_company` to `... and whatsapp_user_id is null`. It fails in the
opposite direction:

| | Column allowlist (chosen) | `is null` check in the policy |
|---|---|---|
| A column added to `workers` later | refused by default; someone must open it deliberately | writable by default; open unless someone remembers |
| Cost of getting it wrong | a feature breaks loudly, in development, with `42501` naming the column | a door stays quietly open |

The repo's posture is allowlists everywhere it has had this choice — the worker
tool roster, the separate worker conversation tables, `0014` and `0025`'s column
grants. This follows it. The cost is real and accepted: column grants are not
additive, so a future migration adding a `workers` column must add it here too
or its own feature will not work.

### What it does to the `.limit(2)` guard

AGENTS.md currently calls the two-match → stay-silent guard in
`handleWorkerReply` **"load-bearing, not defensive"**, and derives that from
precisely this hole. After the change that sentence is no longer true as
written, and the invariant must be edited rather than deleted:

- The guard stays. `workers.whatsapp_user_id` carries **no unique constraint**,
  and the service role can still write a duplicate — through a bug, a backfill,
  or a rotation racing an initial capture.
- Its status changes from "the only thing preventing a wrong-tenant answer" to
  defence in depth. Still not to be tie-broken.

A partial unique index on `workers.whatsapp_user_id` would make the ambiguity
structurally impossible and is safe once the grant is closed. **Explicitly out
of scope** — one idea per migration, and it is a second thing that can go wrong
on a live table. File separately if wanted.

## 5. Verification

`pnpm rls-matrix` is the stated gate in #39 and **cannot run**: the live ledger
is at 25 applied migrations while `supabase/migrations/` holds 27. `0026`
(push) and `0027` (worker agent) are unapplied, so the matrix dies during
seeding on a missing `push_subscriptions` table. This is true on a clean `main`
and is not caused by this branch. (Credentials, contrary to #39's assumption,
*are* present in `apps/web/.env.local`.)

The matrix would also be the weaker instrument here even if it ran: every check
in it asserts a **refusal**, so a grant that denied everyone passes it clean —
and denying everyone is the exact way this change can go wrong.

**Gate: the local Postgres harness** ([[local-postgres-migration-harness]]).
A throwaway Homebrew cluster (v16.14, present), the ~40-line Supabase stub,
migrations `0001`–`0028` applied verbatim (skipping `0012`, pgvector), then:

| # | Assertion | Expected |
|---|---|---|
| 1 | `authenticated` inserts a crew row with `name, trade, phone` | succeeds |
| 2 | …with `whatsapp_opt_in_at` set (the `add_worker` consent path) | succeeds |
| 3 | …with `active` and `language` set | succeeds |
| 4 | …with `whatsapp_user_id` set | fails `42501`, column named |
| 5 | …with `company_id` of another company | fails `42501` (RLS, unchanged) |
| 6 | `authenticated` updates `whatsapp_user_id` on own row | fails `42501` (unchanged by this migration; regression guard on `0025`) |
| 7 | service role inserts a row carrying `whatsapp_user_id` | succeeds — `captureBsuid`'s path |
| 8 | service role runs `applyBsuidRotation`'s update | succeeds |
| 9 | `anon` inserts anything | fails |
| 10 | **Negative control:** re-run assertion 4 against a database built *without* `0028` | must **succeed**, proving the check is not vacuous |

Assertions 1–3 and 7–8 are the ones the RLS matrix structurally cannot make.
Assertion 10 is mandatory: several grant checks pass vacuously otherwise.

After applying to production (maintainer's call, per the same convention as
`0026`/`0027`), the live confirmation is a real one: add a crew member through
chat, with consent, and see it land.

## 6. Files

| File | Change |
|---|---|
| `supabase/migrations/0028_workers_insert_grant.sql` | new — the revoke + grant, with the reasoning above as comments |
| `AGENTS.md` | edit the BSUID bullet: the hole is closed, the `.limit(2)` guard is demoted to defence in depth, `profiles`' real protection is the missing INSERT policy |
| `scripts/rls-isolation-matrix.mjs` | add a forged-`whatsapp_user_id` INSERT attack to the adversarial set, so the closed door is asserted by the repo's own gate once the ledger is unblocked |

No application code changes. `packages/db/src/types.ts` is unaffected — grants
do not appear in generated types.

## 7. Out of scope

- Partial unique index on `workers.whatsapp_user_id` (§4).
- Narrowing the `profiles` INSERT grant (§2).
- The unused table-wide DELETE grant on `workers` (no DELETE policy exists, so
  RLS refuses it; noted for completeness).
- Applying `0026` / `0027`, which is what actually unblocks `pnpm rls-matrix`.
