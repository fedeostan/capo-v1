// Memory tier 2, and the CEILING on it (issue #48).
//
// ── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────
// Every active memory is injected WHOLESALE into the system prompt, on every
// turn, for ever. That was fine while `remember` was the only writer and fired
// only when the model happened to notice something mid-conversation. It stops
// being fine the moment a nightly pass writes memories on a schedule: growth
// becomes automatic, and an automatic growth curve on a block that is re-sent
// with every message is a cost bug that compounds silently.
//
// It is also a CACHE bug, which is the less obvious half. Since #58 the system
// prompt is two messages with a cache breakpoint between them, and the cache
// covers a PREFIX — everything before the marker. The memories sit BELOW the
// marker, in the un-cached half, and they must stay there:
//   * above it, adding one memory would invalidate the whole cached prefix for
//     that company, so we would pay the 1.25× write again on the next message;
//   * and a per-PROFILE memory above the line would fragment the prefix per
//     manager, the same trap issue #62's `loadManagerName` had to avoid.
// `pnpm cache-check` asserts the placement.
//
// ── PURE ON PURPOSE ────────────────────────────────────────────────────────
// No `Db`, no clock, no locale. The cap is the one piece of this feature that
// can be asserted with no credentials and no network, so it lives where
// `pnpm cache-check` can drive it directly.

/**
 * The longest one memory may be.
 *
 * Stated in THREE places, deliberately, and they must not drift: this constant,
 * the zod `.max()` on the `remember` tool (so the model is told the rule and a
 * violation is a retryable tool-input error rather than a database exception),
 * and the `memories_content_length` CHECK in migration 0037 (the backstop that
 * binds the service role too, which RLS and zod both miss).
 *
 * 240 characters is roughly forty words — comfortably one self-contained fact
 * in any of the three languages this product speaks, and far too short for a
 * paragraph smuggled in as a "fact".
 */
export const MEMORY_CONTENT_MAX_CHARS = 240;

/**
 * How many memories may reach the model, newest first.
 *
 * THIS IS THE BOUND THAT ACTUALLY MATTERS. Note it is enforced when memories
 * are READ, not when they are written, and that asymmetry is the design:
 *   * a write-time cap means refusing to record something true — irreversible,
 *     and it makes the nightly pass' behaviour depend on how full the table
 *     already is;
 *   * a read-time cap means recording it and choosing what to CARRY, which is
 *     reversible, and which the manager can see happening on /perfil/memoria.
 * Whatever accumulates over years, what reaches the model is fixed.
 */
export const MEMORY_PROMPT_ROWS = 40;

/**
 * …and a second ceiling in characters, because 40 rows of 240 characters is
 * ~9 600 characters (~2 000 tokens) of un-cached prompt on every request, and
 * one manager message is up to twelve requests (`stopWhen(12)`).
 *
 * Whichever binds first wins. In practice the character cap binds only when the
 * memories are unusually long, which is exactly when it should.
 */
export const MEMORY_PROMPT_MAX_CHARS = 6000;

/**
 * How many rows the prompt builder asks the DATABASE for, before the visibility
 * filter and the two caps above are applied in TypeScript.
 *
 * Comfortably wider than MEMORY_PROMPT_ROWS on purpose. The visibility filter
 * cannot run in the query — `profile_id` is a column migration 0037 adds, and
 * naming it in a `.eq()`/`.or()` would make a deploy landing before that
 * migration answer 42703 on EVERY turn (the 0031 reasoning). So the filter runs
 * after the read, and this headroom is what stops a company whose newest 40
 * memories all belong to a colleague from arriving at the model with none.
 */
export const MEMORY_READ_LIMIT = 200;

/**
 * The shape the prompt builder reads.
 *
 * `profile_id` is OPTIONAL, and that is not laziness. It is a column migration
 * 0037 adds, and this codebase's rule for a column a pending migration adds is
 * that readers must degrade rather than error (AGENTS.md, the view-extension
 * rule): the read is `select('*')` and an absent field reads as `undefined`.
 * `undefined` and `null` both mean "belongs to the whole company", so a deploy
 * landing before 0037 sees exactly the product it replaced instead of a prompt
 * builder throwing 42703 on every single turn.
 */
export interface MemoryRow {
  kind: string;
  content: string;
  created_at: string;
  profile_id?: string | null;
}

export interface PromptMemories<T extends MemoryRow = MemoryRow> {
  /** Oldest first, ready to render. Never longer than the two caps allow. */
  carried: T[];
  /** How many visible memories did not fit. Shown on /perfil/memoria. */
  dropped: number;
}

/**
 * Is this memory visible to this reader?
 *
 * NULL (or absent) = the whole company. Anything else = exactly one profile.
 *
 * RLS enforces the same rule (0037) and is the real boundary — but only on the
 * WEB, where the client is the tenant's own. On the WhatsApp path the client is
 * the service role and `auth.uid()` is null, so RLS is bypassed by design and
 * this predicate is the only filter there is. That is why it is a function with
 * a name rather than an inline `||` at the call site.
 */
export function memoryVisibleTo(row: MemoryRow, profileId: string | null): boolean {
  const owner = row.profile_id ?? null;
  return owner === null || (profileId !== null && owner === profileId);
}

/**
 * Choose what goes on the desk.
 *
 * Newest first for the cut — a memory written last night is more likely to be
 * true than one written in March — then reversed, so the block the model reads
 * is chronological, byte-for-byte the ordering `buildSystemPrompt` has always
 * produced.
 *
 * Ties on `created_at` are broken by nothing in particular, and deliberately so:
 * two memories written in the same millisecond are equally recent and there is
 * no honest tiebreaker. The sort is stable, so their input order survives.
 *
 * GENERIC over the row type so the caller keeps its own columns. /perfil/memoria
 * needs the `id` of every carried row to mark which notes Capo is actually
 * reading right now — showing the cap working is half the point of that screen —
 * and a signature fixed to `MemoryRow` would erase it.
 */
export function selectPromptMemories<T extends MemoryRow>(
  rows: T[],
  profileId: string | null,
): PromptMemories<T> {
  const visible = rows.filter(row => memoryVisibleTo(row, profileId));
  const newestFirst = [...visible].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  const carried: T[] = [];
  let chars = 0;
  for (const row of newestFirst) {
    if (carried.length >= MEMORY_PROMPT_ROWS) break;
    // The +1 is the newline each rendered line costs. Counting the separator is
    // the difference between a budget that holds and one that is exceeded by
    // exactly the number of rows carried.
    const cost = row.content.length + 1;
    if (chars + cost > MEMORY_PROMPT_MAX_CHARS && carried.length > 0) break;
    carried.push(row);
    chars += cost;
  }

  return { carried: carried.reverse(), dropped: visible.length - carried.length };
}

/**
 * One rendered line. Unchanged from what `buildSystemPrompt` emitted before
 * this file existed, and that matters: `pnpm cache-check` compares the two
 * halves of the split prompt against the single string they replaced.
 *
 * A personal memory is NOT tagged as personal, and that is a decision rather
 * than an omission. The scope's job is to decide WHO SEES the row, which the
 * filter above has already done by the time the model reads anything; the model
 * cannot act differently on "yours" versus "the company's", so a tag would be
 * prompt vocabulary in three locales for a distinction with no behaviour behind
 * it. Revisit if a company ever has two managers who disagree.
 */
export function formatMemoryLine(row: MemoryRow): string {
  return `- [${row.kind}] (${row.created_at.slice(0, 10)}) ${row.content}`;
}
