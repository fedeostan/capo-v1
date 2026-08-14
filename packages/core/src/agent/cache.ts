import type { SystemModelMessage, ToolSet } from 'ai';

// Provider prompt caching — the seam.
//
// Anthropic caches a PREFIX, not a set of blocks. The request renders in a
// fixed order — `tools` → `system` → `messages` — and a `cache_control` marker
// says "everything from the start of the request up to and including this point
// is one cache entry". Any byte that changes anywhere before a marker
// invalidates that entry and every entry after it. So the only thing that makes
// caching work is putting stable bytes first and volatile bytes last; the
// markers themselves are just where you cut.
//
// That is why this file is tiny and why nothing here decides WHAT goes in the
// prompt. The ordering discipline lives in ./context.ts (manager) and
// ./worker-context.ts (worker), which each hand us two halves.
//
// ── What is deliberately NOT shared ────────────────────────────────────────
// The manager agent and the worker agent are separate by design (AGENTS.md).
// This module is allowed to serve both for the same reason ./models.ts is: it
// is PROVIDER PLUMBING and it touches none of the things the separation is
// about. It knows nothing about `CapoTool`/`WorkerTool`, nothing about
// `ToolContext`/`WorkerContext`, no roster, no persona and no policy — its
// entire vocabulary is `string` and the AI SDK's own `ToolSet`. It cannot
// become a convergence point, because there is nothing Capo-shaped in it to
// converge on. Keep it that way: if a future change wants to pass a context or
// a tool type through here, that is the isolation failing, not this file
// growing.
//
// ── Costs, so the decisions below are checkable ────────────────────────────
// A cache WRITE costs 1.25× normal input; a cache READ costs 0.1×. So a marked
// prefix is a loss on the first request and a 90% saving on every later one:
// break-even is TWO requests hitting the same prefix inside the (5 minute)
// window. That bar is cleared by construction on both agent paths, because one
// inbound message is not one API request — the tool loop makes up to 12
// (manager) or 6 (worker), seconds apart, each re-sending the identical
// tools + stable-system prefix. The cache pays for itself inside a single turn
// before any question of repeat traffic arises.
//
// The 5-minute TTL is deliberate and we do not set the 1-hour one: a 1h write
// costs 2× and needs THREE reads to break even, which is a bet on traffic we do
// not have yet. Everything below assumes the default.

/**
 * `providerOptions` is `Record<string, Record<string, JSONValue>>` in the AI
 * SDK. Deriving the type off a message rather than importing it keeps this file
 * to one import and pins it to the shape the SDK actually accepts.
 */
type ProviderOptions = NonNullable<SystemModelMessage['providerOptions']>;

/**
 * One cache breakpoint, 5-minute TTL (the provider default — the field is
 * omitted rather than set to '5m' so we inherit whatever the default is).
 *
 * `@ai-sdk/anthropic` reads this off a system message, a message part, or a
 * tool definition and emits `cache_control: {type: 'ephemeral'}` on the
 * corresponding wire block.
 */
export const CACHE_BREAKPOINT: ProviderOptions = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
};

/**
 * Anthropic allows at most FOUR breakpoints per request; a fifth is dropped
 * with a warning nobody reads. We use two per agent turn (tools, then the
 * stable system half), which leaves headroom for a future message-history
 * breakpoint without anyone having to count.
 */
export const MAX_CACHE_BREAKPOINTS = 4;

/** The `\n\n---\n\n` both prompt builders have always joined blocks with. */
export const PROMPT_BLOCK_SEPARATOR = '\n\n---\n\n';

export function joinBlocks(blocks: readonly (string | null | undefined)[]): string {
  return blocks.filter((b): b is string => Boolean(b)).join(PROMPT_BLOCK_SEPARATOR);
}

/**
 * Split a system prompt into a cached half and an uncached half.
 *
 * The returned value is deliberately `Array<SystemModelMessage>` rather than a
 * string: the AI SDK renders consecutive system messages into ONE Anthropic
 * `system` array with one text block each, so the two halves stay a single
 * system prompt on the wire — the only difference is that a `cache_control`
 * marker sits between them.
 *
 * **The join is byte-identical to the old single-string form.** `stable` and
 * `volatile` are joined by the same separator the blocks inside each half use,
 * so `stable + SEP + volatile` reproduces the previous prompt exactly. This is
 * a caching change, not a prompt rewrite, and `pnpm cache-check` asserts that
 * identity rather than trusting it.
 *
 * The caller's ONLY job is to put nothing volatile in `stable`. In practice
 * that means: nothing dated, nothing counted, nothing read out of the tenant's
 * rows. The trap is the daily date line — a breakpoint placed after it caches
 * a prefix that is guaranteed to be wrong tomorrow, so today's write is paid
 * for and never read again.
 */
export function cachedInstructions(
  stable: readonly (string | null | undefined)[],
  volatile: readonly (string | null | undefined)[],
): SystemModelMessage[] {
  const stableText = joinBlocks(stable);
  const volatileText = joinBlocks(volatile);

  const messages: SystemModelMessage[] = [];
  if (stableText) messages.push({ role: 'system', content: stableText, providerOptions: CACHE_BREAKPOINT });
  if (volatileText) messages.push({ role: 'system', content: volatileText });
  return messages;
}

/**
 * Put a breakpoint on the LAST tool definition.
 *
 * Tools render before `system`, so this is the earliest cut in the request and
 * it caches the whole tool schema — the largest genuinely frozen thing we send.
 * It earns its own breakpoint rather than riding on the system one for a
 * specific reason: **the tool definitions are the only part of the prefix that
 * does not vary by locale.** Descriptions and zod schemas come off the static
 * roster, so every manager in every language shares one entry here, while the
 * system half fragments by persona (3 locales) and by language directive
 * (user × company dial). Same bytes written, finer-grained hits.
 *
 * "Last" is insertion order: `toAiTools`/`toWorkerAiTools` build the ToolSet by
 * mapping a module-level array, JS preserves string-key insertion order, and
 * the provider walks the set in that order. Marking the last entry therefore
 * covers every earlier one. Appending a tool to a roster moves the marker
 * automatically and costs one cache rewrite on deploy, which is correct.
 *
 * Returns a new ToolSet; the input is never mutated.
 */
export function withToolCacheBreakpoint(tools: ToolSet): ToolSet {
  const names = Object.keys(tools);
  const last = names[names.length - 1];
  if (last === undefined) return tools;

  return Object.fromEntries(
    names.map(name => [
      name,
      name === last ? { ...tools[name], providerOptions: CACHE_BREAKPOINT } : tools[name],
    ]),
  ) as ToolSet;
}
