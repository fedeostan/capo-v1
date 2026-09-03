// Who owns a company's Capo account, by name — the clause that opens the crew
// welcome ("O teu gerente na Silva, Miguel, acabou de te adicionar ao Capo").
//
// ── WHY IT LIVES IN @capo/db AND NOT IN EITHER APP ─────────────────────────
// Exactly posture.ts's reasoning, one file over. TWO apps need this answer and
// they must not disagree: the welcome sweep in apps/web sends the message, and
// the operator's "resend a failed welcome" button in apps/operator sends the
// SAME message to somebody the sweep gave up on. Apps may not import each
// other's modules (the graph is i18n ← db ← core ← {web, operator}), so
// without a shared home the two would each hold their own copy of the rule —
// and the symptom of them drifting is one person reading a colder introduction
// than everybody else, which nothing in a build or a check would ever notice.
//
// The rendering itself cannot be shared: it needs the user copy catalog, which
// keeps the welcome renderers in apps/web. This is the part that CAN be, so
// this is the part that is.
//
// Deliberately PURE — no Db, no query, no clock. It takes rows the caller has
// already read, which is what lets the sweep answer this from the profiles
// list it fetches for the ledger rather than paying for a second query.

/** The only field this rule reads. `select('*')` gives it for free. */
export interface AccountOwnerRow {
  full_name?: string | null;
}

/**
 * The name to put in the welcome, or null.
 *
 * ── WHICH PROFILE, WHEN THERE ARE SEVERAL ──────────────────────────────────
 * The MOST RECENTLY CREATED one that has a name. Capo has no owner column:
 * every profile in a company is a manager and any of them can add crew. The
 * newest is the closest thing to "whoever is running this account now" that
 * the schema can answer, and being wrong costs a crew member the wrong
 * colleague's name in one sentence, never a wrong send or a wrong tenant.
 *
 * ⚠ `profiles` MUST ARRIVE ORDERED BY created_at ASCENDING. That is what
 * `.order('created_at')` gives by default and what both callers already do for
 * their own reasons; this function reads the LAST named row and cannot tell an
 * unordered list from an ordered one. Handing it a reversed list is not an
 * error, it is quietly the oldest manager.
 *
 * ── NULL IS A REAL ANSWER, NOT A MISSING ONE ───────────────────────────────
 * A company can have no readable owner name: no profile row yet (the crew were
 * seeded before anybody signed in), or a `full_name` that is blank or
 * whitespace. The caller then OMITS the clause rather than filling it with
 * "the person who added you", which names nobody and makes a first message
 * sound like a form letter.
 */
export function pickAccountOwnerName(profiles: readonly AccountOwnerRow[]): string | null {
  let name: string | null = null;
  for (const profile of profiles) {
    const named = profile.full_name?.trim();
    if (named) name = named;
  }
  return name;
}
