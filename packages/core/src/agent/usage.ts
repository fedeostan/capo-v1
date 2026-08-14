import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import type { Db } from '@capo/db/client';

// The usage ledger — token accounting for issue #53.
//
// ── ONE SEAM, NOT N CALL SITES ─────────────────────────────────────────────
// Every language-model call in this codebase already passes through exactly one
// place: getModel() in ./models.ts. That is where the recording goes, as
// provider MIDDLEWARE wrapped around the model the registry returns, so no call
// site ever writes a usage row itself. A call site's only job is to say WHO the
// spend belongs to; whether, when and how it is recorded is decided here.
//
// The alternative — a `recordUsage(...)` line after each of the seven
// generateText/generateObject/agent.stream calls — fails in a specific and
// silent way. It counts TURNS, not REQUESTS: the two agent loops make up to
// twelve and six provider requests per inbound message, and only the model
// wrapper can see each one. It also makes "somebody added a model call and
// forgot the ledger line" a permanent, invisible undercount.
//
// ── WHAT THIS MODULE IS ALLOWED TO KNOW ────────────────────────────────────
// The manager agent and the worker agent are separate by design (AGENTS.md).
// Like ./models.ts and ./cache.ts, this file may serve both ONLY because it is
// plumbing: its whole vocabulary is `Db`, plain strings and numbers. There is
// no CapoTool/WorkerTool, no ToolContext/WorkerContext, no roster, no persona
// and no policy in it, so there is nothing Capo-shaped for the two agents to
// converge on. `UsageAttribution` is a discriminated union of plain ids
// precisely so that "a worker turn billed to a profile" is not expressible.
// If a future change wants to pass a context type through here, that is the
// isolation failing, not this file growing.

/**
 * Which part of the product spent the tokens.
 *
 * MUST stay in lockstep with the `surface` CHECK constraint in
 * `supabase/migrations/0032_ai_usage.sql`. Adding a value is two edits, and the
 * failure mode of doing only one is silence, not an error — see `recordUsage`.
 *
 * There is deliberately no `briefing` value: the 07:00 crew briefing and the
 * late-afternoon check-in call no model at all. Their cost is a WhatsApp
 * template send and lives in `notification_log`.
 */
export type UsageSurface =
  | 'manager_chat'
  | 'worker_chat'
  | 'summarizer'
  // The nightly memory review (issue #48). Its own surface rather than sharing
  // 'summarizer': the two run on different models, on different schedules, and
  // answer different questions about the money — "what does compressing a
  // conversation cost" and "what does the night shift cost" are the two figures
  // most likely to be tuned independently.
  | 'consolidation'
  | 'planner'
  | 'translation'
  | 'transcription'
  | 'vocab_extraction';

/**
 * Whose spend this is.
 *
 * A union rather than two optional id fields, so the three shapes the database
 * CHECK allows are the three shapes TypeScript allows. `{ kind: 'worker' }`
 * has no `profileId` to set, which is the point: the worker loop physically
 * cannot file its spend against a manager.
 *
 * `system` is for company-wide work nobody personally asked for in the moment —
 * a bulk data translation is the only current example.
 */
export type UsageActor =
  | { kind: 'manager'; profileId: string }
  | { kind: 'worker'; workerId: string }
  | { kind: 'system' };

/**
 * `ToolContext.userId` is nullable — it is null when a tool runs from an
 * approved proposal, where there is no live user in the path at all. This turns
 * that into the honest actor rather than a fabricated one: a real profile id
 * bills the person, and its absence bills the company.
 *
 * There is no worker equivalent and there must not be: `WorkerContext.workerId`
 * is non-nullable, so a worker turn always has a name attached to it.
 */
export function managerOrSystem(profileId: string | null | undefined): UsageActor {
  return profileId ? { kind: 'manager', profileId } : { kind: 'system' };
}

export interface UsageAttribution {
  /**
   * The client the CALLER already holds — the RLS-scoped user client on the
   * web, the service role on the WhatsApp and worker paths. Never getDb():
   * this write happens inside a tenant request, and the system-vs-user client
   * split (AGENTS.md) is what keeps a misbehaving path inside its own tenant.
   * `ai_usage`'s INSERT policy pins company_id to the caller's own company.
   */
  db: Db;
  companyId: string;
  surface: UsageSurface;
  actor: UsageActor;
}

/**
 * The four disjoint token buckets, already normalised out of the provider's
 * shape. `input` is FULL-PRICE prompt tokens only; the cached halves are their
 * own numbers. Summing input + cacheRead + cacheWrite gives the request's total
 * prompt tokens, and adding cacheRead on top of a total would double-count.
 */
interface TokenBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Anything the provider left undefined is zero, never NaN and never null. */
function n(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Map `LanguageModelV4Usage` onto the four columns.
 *
 * Exported for `pnpm cost-check`, which pins this mapping against hand-written
 * provider payloads — the one place a silent double-count could enter.
 *
 * `inputTokens.noCache` is used rather than `inputTokens.total`, and that is
 * the whole correctness question in this file. `total` INCLUDES the cached
 * halves; storing it alongside `cacheRead`/`cacheWrite` would bill every cached
 * prompt token twice, once at full price. When a provider reports only a total
 * (no cache breakdown at all — Google, and Anthropic on an uncached role), the
 * fallback below is still correct because both cache figures are then zero.
 */
export function toTokenBuckets(usage: {
  inputTokens?: { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens?: { total?: number };
}): TokenBuckets {
  const cacheRead = n(usage.inputTokens?.cacheRead);
  const cacheWrite = n(usage.inputTokens?.cacheWrite);
  const noCache = usage.inputTokens?.noCache;
  const input =
    typeof noCache === 'number'
      ? n(noCache)
      : // No breakdown reported: derive the full-price half from the total, and
        // never below zero if a provider's own numbers disagree.
        Math.max(0, n(usage.inputTokens?.total) - cacheRead - cacheWrite);

  return { input, output: n(usage.outputTokens?.total), cacheRead, cacheWrite };
}

export interface UsageRecord extends UsageAttribution {
  modelRole: string;
  modelId: string;
  provider: 'anthropic' | 'google';
}

/**
 * Write one row. **Never throws, under any circumstance.**
 *
 * Failing to count a turn is a metrics problem; failing a turn is a
 * conversation problem, and a manager standing in the rain does not care what
 * the ledger thinks. Same failure posture as `loadCompanySnapshot`: every error
 * collapses into "no data" and nothing propagates.
 *
 * The cost of that posture, stated plainly: a wrong `surface` value, a missing
 * migration, or a revoked grant all present as a table that quietly stops
 * filling up. The `console.warn` below is the only signal, so it names the
 * surface and the model — grep `ai_usage.write_failed` before concluding that a
 * quiet dashboard means quiet traffic.
 */
async function recordUsage(record: UsageRecord, tokens: TokenBuckets): Promise<void> {
  // A request that reported nothing at all is not worth a row. This is not an
  // error path — the provider omits usage on some streamed error responses, and
  // a row of four zeroes would add noise to every average on the dashboard.
  if (tokens.input === 0 && tokens.output === 0 && tokens.cacheRead === 0 && tokens.cacheWrite === 0) return;

  try {
    const { error } = await record.db.from('ai_usage').insert({
      company_id: record.companyId,
      actor: record.actor.kind,
      profile_id: record.actor.kind === 'manager' ? record.actor.profileId : null,
      worker_id: record.actor.kind === 'worker' ? record.actor.workerId : null,
      surface: record.surface,
      model_role: record.modelRole,
      model_id: record.modelId,
      provider: record.provider,
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      cache_read_tokens: tokens.cacheRead,
      cache_write_tokens: tokens.cacheWrite,
    });
    if (error) {
      console.warn(
        JSON.stringify({
          evt: 'ai_usage.write_failed',
          surface: record.surface,
          modelId: record.modelId,
          companyId: record.companyId,
          error: error.message,
        }),
      );
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        evt: 'ai_usage.write_failed',
        surface: record.surface,
        modelId: record.modelId,
        companyId: record.companyId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * The middleware itself: observe usage on the way out, record it, change
 * nothing.
 *
 * Both hooks are implemented because both are used — `generateText` and
 * `generateObject` go through `wrapGenerate`, and the two agent loops stream.
 * A middleware that only covered one would drop whichever half was forgotten,
 * with no error.
 *
 * **The stream side records at the `finish` part, inside a pass-through
 * transform.** Anthropic emits usage once, at the end. Awaiting the insert in
 * the transform's handler is what keeps the row from being lost to a serverless
 * function freezing the moment the response is flushed — an un-awaited promise
 * on Vercel is not "fire and forget", it is "fire and maybe never". It delays
 * the stream's CLOSE by one insert, after the last token has already reached
 * the reader, so nothing a human is waiting on moves.
 */
export function usageRecordingMiddleware(record: UsageRecord): LanguageModelMiddleware {
  return {
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      await recordUsage(record, toTokenBuckets(result.usage));
      return result;
    },

    async wrapStream({ doStream }) {
      const { stream, ...rest } = await doStream();

      const observed = stream.pipeThrough(
        new TransformStream({
          async transform(part, controller) {
            // Forward FIRST, always. Whatever the ledger does next, the
            // conversation has already moved on.
            controller.enqueue(part);
            if (part.type === 'finish') await recordUsage(record, toTokenBuckets(part.usage));
          },
        }),
      );

      return { stream: observed, ...rest };
    },
  };
}

/**
 * A `LanguageModel` that is an actual model object rather than a gateway model
 * ID string. `wrapLanguageModel` cannot wrap a string — there is nothing to
 * intercept until the gateway resolves it — and every entry in `./models.ts`'s
 * registry constructs a real provider model, so excluding the string arm here
 * costs nothing and keeps the failure at the type level rather than at runtime.
 */
type ModelInstance = Exclude<LanguageModel, string>;

/** Wrap a model so every request it makes lands in `ai_usage`. */
export function withUsageRecording(model: ModelInstance, record: UsageRecord): LanguageModel {
  return wrapLanguageModel({ model, middleware: usageRecordingMiddleware(record) });
}
