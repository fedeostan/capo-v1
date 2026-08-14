// The rate card — the ONLY place in this codebase that turns tokens into money.
//
// ── WHY THIS IS A MODULE AND NOT A COLUMN ──────────────────────────────────
// `ai_usage` (0032) stores token counts and no currency at all. Prices change:
// providers cut them, we swap models, a negotiated rate arrives. A euro figure
// written into a row is a number that was true on the day it was written and is
// silently wrong forever after, with no way to tell which rows were priced
// under which card. Keeping the arithmetic here means re-pricing the entire
// history is one edit to this file, and re-pricing a single row is impossible.
//
// ── HOW SURE WE ARE ────────────────────────────────────────────────────────
// Every entry carries a `confidence`. `published` means it was read off the
// provider's own public rate card; `estimated` means it is a working figure
// that has NOT been verified against a bill. The dashboard renders the two
// differently on purpose — a cost report that cannot tell a known price from a
// guess is worse than no report, because it invites decisions.
//
// Anything not in this table is UNPRICED, and `estimateCostUsd` says so rather
// than returning zero. A model swapped in without a line here would otherwise
// make the whole spend look like it fell.
//
// Currency is USD throughout, because that is what Anthropic, Google and Meta
// bill in. No euro conversion happens anywhere: a made-up exchange rate is one
// more stale number, and the invoice Federico actually pays is in dollars.

export type PriceConfidence = 'published' | 'estimated';

export interface ModelPrice {
  /** USD per 1,000,000 full-price prompt tokens. */
  inputUsdPerMTok: number;
  /** USD per 1,000,000 output tokens. */
  outputUsdPerMTok: number;
  /** USD per 1,000,000 prompt tokens served from cache. */
  cacheReadUsdPerMTok: number;
  /** USD per 1,000,000 prompt tokens written into cache. */
  cacheWriteUsdPerMTok: number;
  confidence: PriceConfidence;
  /** Free-text provenance, so a stale number is traceable rather than mystifying. */
  note: string;
}

/**
 * Anthropic's cache multipliers, stated once.
 *
 * These are the same two numbers `packages/core/src/agent/cache.ts` reasons
 * about when it argues that a breakpoint pays for itself inside one turn: a
 * WRITE costs 1.25x normal input and a READ costs 0.1x. Deriving the per-bucket
 * rates from them, rather than typing four numbers per model, means the two
 * files cannot drift and a rate change is one edit per model instead of four.
 */
export const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;
export const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1;

function anthropic(
  inputUsdPerMTok: number,
  outputUsdPerMTok: number,
  confidence: PriceConfidence,
  note: string,
): ModelPrice {
  return {
    inputUsdPerMTok,
    outputUsdPerMTok,
    cacheReadUsdPerMTok: inputUsdPerMTok * ANTHROPIC_CACHE_READ_MULTIPLIER,
    cacheWriteUsdPerMTok: inputUsdPerMTok * ANTHROPIC_CACHE_WRITE_MULTIPLIER,
    confidence,
    note,
  };
}

/**
 * Keyed on the CONCRETE MODEL ID, never on the role.
 *
 * `ai_usage` records both (see 0032), and pricing must key on the id: a row
 * written six months ago under an older model has to stay priced at that
 * model's rate. Keying on the role would retroactively re-price all of history
 * every time a model is swapped, which is exactly the kind of quiet rewrite
 * this whole design exists to prevent.
 *
 * Keep every id from `MODEL_IDS` in `./models.ts` listed here, and keep RETIRED
 * ids listed too — history does not stop needing a price when a model is
 * dropped from the registry.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-5': anthropic(3, 15, 'published', "Anthropic's published Sonnet-tier rate: $3 in / $15 out per MTok."),
  'claude-haiku-4-5-20251001': anthropic(
    1,
    5,
    'published',
    "Anthropic's published Haiku 4.5 rate: $1 in / $5 out per MTok.",
  ),
  // Google does not use Anthropic's prompt cache, so the two cache buckets are
  // always zero on these rows and their rates are set to the input rate rather
  // than to a fabricated multiplier — if a cached Gemini row ever appears, it
  // will be priced conservatively rather than free.
  'gemini-3.5-flash': {
    inputUsdPerMTok: 0.3,
    outputUsdPerMTok: 2.5,
    cacheReadUsdPerMTok: 0.3,
    cacheWriteUsdPerMTok: 0.3,
    confidence: 'estimated',
    note: 'NOT VERIFIED against a Google bill. Carried over from the Flash-tier rate; audio input may be billed differently again. Check before quoting this number to anyone.',
  },
};

/**
 * What one delivered WhatsApp template send costs, in USD.
 *
 * Meta prices per delivered TEMPLATE by category and by recipient country, and
 * this is a single blended figure for Portugal utility templates. It is an
 * ESTIMATE and it is used for both daily sends (the 07:00 briefing and the
 * late-afternoon check-in), which are the only paid messages the product emits
 * — a free-form reply inside the 24-hour window a worker's own message opens
 * costs nothing and is not counted.
 *
 * Verify against the WhatsApp Manager rate card before treating any WhatsApp
 * total on the dashboard as real money.
 */
export const WHATSAPP_TEMPLATE_USD = 0.03;
export const WHATSAPP_TEMPLATE_CONFIDENCE: PriceConfidence = 'estimated';

export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface CostEstimate {
  usd: number;
  /**
   * False when the model id has no line in MODEL_PRICES. `usd` is then 0 —
   * which is a MISSING price, not a free call. Every caller must surface the
   * difference; the dashboard counts unpriced rows separately.
   */
  priced: boolean;
  confidence: PriceConfidence | 'unpriced';
}

/**
 * Price one row (or one already-summed group of rows sharing a model id).
 *
 * The four buckets are DISJOINT (see 0032's header): full-price input, cache
 * read, cache write and output are each multiplied by their own rate and added.
 * Never add a cached figure on top of a total.
 */
export function estimateCostUsd(modelId: string, tokens: TokenCounts): CostEstimate {
  const price = MODEL_PRICES[modelId];
  if (!price) return { usd: 0, priced: false, confidence: 'unpriced' };

  const usd =
    (tokens.input_tokens * price.inputUsdPerMTok +
      tokens.output_tokens * price.outputUsdPerMTok +
      tokens.cache_read_tokens * price.cacheReadUsdPerMTok +
      tokens.cache_write_tokens * price.cacheWriteUsdPerMTok) /
    1_000_000;

  return { usd, priced: true, confidence: price.confidence };
}

/**
 * What the same tokens would have cost with prompt caching switched off — i.e.
 * every cached prompt token billed at the full input rate.
 *
 * This is the only way to state what #58 is actually saving. Subtracting it
 * from the real figure is the saving; a positive difference means the 1.25x
 * writes are not being repaid by reads, which is the failure mode caching has
 * (it silently costs MORE rather than erroring).
 */
export function estimateUncachedCostUsd(modelId: string, tokens: TokenCounts): CostEstimate {
  const price = MODEL_PRICES[modelId];
  if (!price) return { usd: 0, priced: false, confidence: 'unpriced' };

  const promptTokens = tokens.input_tokens + tokens.cache_read_tokens + tokens.cache_write_tokens;
  const usd = (promptTokens * price.inputUsdPerMTok + tokens.output_tokens * price.outputUsdPerMTok) / 1_000_000;

  return { usd, priced: true, confidence: price.confidence };
}

/**
 * `$0.0123` / `$1.23` / `$12` — small numbers need the decimals, big ones do
 * not.
 *
 * Negatives are formatted as `-$1.23` rather than `$-1.23`, and the precision
 * is chosen from the MAGNITUDE. One figure on the dashboard can legitimately go
 * negative — the caching saving, when the 1.25× writes are not being repaid by
 * reads — and that is exactly the number nobody should have to squint at.
 */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  const sign = usd < 0 ? '-' : '';
  const abs = Math.abs(usd);
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  if (abs < 10) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${abs.toFixed(0)}`;
}
