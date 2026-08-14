import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';

// The model seam: every model call in the app goes through a named role.
// Swapping or adding a model is an edit here, nowhere else. The transcription
// role is the XPRIZE Gemini qualifying call, wired via @ai-sdk/google
// (direct, not a gateway, to unambiguously go "through the Gemini API").
// The embedding model lives in ./embeddings.ts (its type is EmbeddingModel,
// not LanguageModel, and swapping it forces a corpus re-ingest — see there).
export type ModelRole =
  | 'conversation'
  | 'summarizer'
  | 'transcription'
  | 'extraction'
  | 'planner'
  | 'translation';

const registry: Record<ModelRole, () => LanguageModel> = {
  conversation: () => anthropic('claude-sonnet-5'),
  summarizer: () => anthropic('claude-haiku-4-5-20251001'),
  transcription: () => google('gemini-3.5-flash'),
  // Vocab learning: pulls corrected terms out of (heard, sent) pairs. Same
  // model as summarizer today, but its own role — swapping one must never
  // silently change the other.
  extraction: () => anthropic('claude-haiku-4-5-20251001'),
  // generateObject call behind generate_plan: needs the same reasoning
  // quality as the conversation model, but kept as its own role — swapping
  // one must never silently change the other.
  planner: () => anthropic('claude-sonnet-5'),
  // Tenant-wide data translation (src/translation). Short domain strings with
  // a supplied glossary, run in bulk under a hard function-duration ceiling —
  // volume-bound, not reasoning-bound, so the cheap fast model is the right
  // call. Its own role for the usual reason: swapping one must never silently
  // change the other.
  translation: () => anthropic('claude-haiku-4-5-20251001'),
};

export function getModel(role: ModelRole): LanguageModel {
  return registry[role]();
}

// ── Prompt caching, per role ────────────────────────────────────────────────
//
// Caching is decided HERE, at the model seam, and not at each call site,
// because the decision is a property of the model and the traffic shape rather
// than of the prompt. The mechanics live in ./cache.ts.
//
// Anthropic silently refuses to cache a prefix shorter than a per-model
// minimum: no error, no warning, just `cache_creation_input_tokens: 0` and a
// 1.25× bill you never earn back. The minimum is NOT monotonic across model
// generations, which is the trap — Haiku 4.5's is four times Sonnet 5's.
export const MIN_CACHEABLE_PREFIX_TOKENS: Record<string, number> = {
  'claude-sonnet-5': 1024,
  'claude-haiku-4-5-20251001': 4096,
};

/**
 * The model id each role resolves to, as a plain string. Kept beside the
 * registry so a model swap and its caching consequences are one edit, and so
 * `pnpm cache-check` can assert the two agree without constructing a model.
 */
export const MODEL_IDS: Record<ModelRole, string> = {
  conversation: 'claude-sonnet-5',
  summarizer: 'claude-haiku-4-5-20251001',
  transcription: 'gemini-3.5-flash',
  extraction: 'claude-haiku-4-5-20251001',
  planner: 'claude-sonnet-5',
  translation: 'claude-haiku-4-5-20251001',
};

/**
 * The roles that carry cache breakpoints, and the reason every other role does
 * not. This list is the PR's per-role table in executable form; `pnpm
 * cache-check` asserts each claim below that it can check.
 *
 *   conversation  ✅ CACHED. Sonnet 5, 1024-token minimum. Both agent loops run
 *                 on this role. The stable prefix (tool schemas + persona +
 *                 policy + language directive) is several times the minimum,
 *                 and one inbound message costs up to 12 (manager) or 6
 *                 (worker) API requests that all re-send it — so the write is
 *                 repaid inside a single turn, before repeat traffic matters.
 *
 *   summarizer    ❌ NOT CACHED. Haiku 4.5, 4096-token minimum. Its whole
 *                 system prompt is five lines (~100 tokens): a breakpoint here
 *                 would be a silent no-op, not a saving. It also runs once per
 *                 ~40 messages, so there is nothing to reuse either.
 *
 *   extraction    ❌ NOT CACHED. Haiku 4.5, same 4096-token floor, same
 *                 short prompt, and one call per transcription correction.
 *
 *   translation   ❌ NOT CACHED. Haiku 4.5, 4096-token floor. This is the
 *                 closest call on the list: a bulk translation fans out many
 *                 chunk calls sharing one system prompt, which is exactly the
 *                 shape caching rewards — but that prompt (instructions plus a
 *                 short glossary) sits well under 4096 tokens, so the marker
 *                 would be ignored. Revisit only if the glossary grows past
 *                 the floor, or if the role ever moves to a Sonnet-tier model.
 *
 *   planner       ❌ NOT CACHED. Sonnet 5, so the floor is only 1024 — but the
 *                 planner prompt is ~900 tokens, i.e. under it, and a plan is
 *                 ONE generateObject call with nothing to reuse. A breakpoint
 *                 would buy a 1.25× write and no reads at all.
 *
 *   transcription ❌ N/A. Gemini. Anthropic prompt caching does not exist here.
 */
export const CACHED_ROLES: readonly ModelRole[] = ['conversation'];
