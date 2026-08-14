import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { withUsageRecording, type UsageAttribution } from './usage';

// The model seam: every model call in the app goes through a named role.
// Swapping or adding a model is an edit here, nowhere else. The transcription
// role is the XPRIZE Gemini qualifying call, wired via @ai-sdk/google
// (direct, not a gateway, to unambiguously go "through the Gemini API").
// The embedding model lives in ./embeddings.ts (its type is EmbeddingModel,
// not LanguageModel, and swapping it forces a corpus re-ingest — see there).
export type ModelRole =
  | 'conversation'
  | 'summarizer'
  | 'consolidation'
  | 'transcription'
  | 'extraction'
  | 'planner'
  | 'translation';

// Typed as the concrete model objects the providers return, not as
// `LanguageModel` — that union also admits a bare gateway model-ID string, and
// a string cannot be wrapped with usage-recording middleware (see ./usage.ts).
// Keeping the narrower type here means "somebody put a plain string in the
// registry" is a tsc error rather than an unrecorded model call.
const registry: Record<ModelRole, () => Exclude<LanguageModel, string>> = {
  conversation: () => anthropic('claude-sonnet-5'),
  summarizer: () => anthropic('claude-haiku-4-5-20251001'),
  // The nightly memory review (issue #48). Sonnet rather than the summarizer's
  // Haiku, and the asymmetry is the point: a summary is prose the next few turns
  // read and each pass launders the last one, while a MEMORY is a row injected
  // into every future prompt that nothing ever re-checks. Judging what is
  // durable is the whole task, getting it wrong is permanent, and it runs once
  // per company per night — so the cheap model is a false economy here in a way
  // it is not one message downstream.
  consolidation: () => anthropic('claude-sonnet-5'),
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

/**
 * Which provider each role bills against. Needed by the usage ledger, which
 * records it per row so a future provider swap does not make old rows
 * ambiguous. Derived from the registry above and asserted by `pnpm cost-check`
 * against `MODEL_IDS`, so a role added to one and not the other is caught.
 */
export const MODEL_PROVIDERS: Record<ModelRole, 'anthropic' | 'google'> = {
  conversation: 'anthropic',
  summarizer: 'anthropic',
  consolidation: 'anthropic',
  transcription: 'google',
  extraction: 'anthropic',
  planner: 'anthropic',
  translation: 'anthropic',
};

/**
 * The model seam, and — since issue #53 — the usage seam too.
 *
 * `attribution` is the ONE thing a call site has to supply: whose spend this
 * is, and which surface is spending it. Everything else about recording (that
 * it happens at all, per API request rather than per turn, into which columns,
 * and that a failure is swallowed) is decided in ./usage.ts, so no call site
 * ever writes a ledger row itself.
 *
 * It is OPTIONAL rather than required, unlike `ToolContext.confirmPosture`, and
 * the asymmetry is deliberate. A forgotten posture is a SAFETY regression — an
 * unconfirmed write on a live job — so `tsc` must refuse it. A forgotten
 * attribution costs an uncounted call, which is a metrics gap. Making it
 * required would break `getModel()` for the credential-free checks
 * (`pnpm cache-check` builds every model with no database in sight) and would
 * push a fake `db` into scripts, which is worse than an undercount.
 * `pnpm cost-check` asserts that every real call site passes one.
 */
export function getModel(role: ModelRole, attribution?: UsageAttribution): LanguageModel {
  const model = registry[role]();
  if (!attribution) return model;
  return withUsageRecording(model, {
    ...attribution,
    modelRole: role,
    modelId: MODEL_IDS[role],
    provider: MODEL_PROVIDERS[role],
  });
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
  consolidation: 'claude-sonnet-5',
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
 *                 ~50 messages (SUMMARIZE_AFTER 80 / KEEP_RECENT 30 since #48),
 *                 so there is nothing to reuse either.
 *
 *   consolidation ❌ NOT CACHED. Sonnet 5, so the 1024-token floor is within
 *                 reach — but a run is ONE generateObject call per company per
 *                 night and the prompt carries that company's own memories and
 *                 transcript, so there is no prefix shared with anything and
 *                 nothing to read a written entry back from. A breakpoint here
 *                 would buy a 1.25x write and zero reads, every night.
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
