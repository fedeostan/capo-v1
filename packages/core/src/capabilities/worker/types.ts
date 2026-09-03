import type { z } from 'zod';
import type { Db } from '@capo/db/client';
import type { Locale } from '@capo/i18n/locale';
import type { TaskPhotoMime } from '../../media/photos';
import type { InboxPhoto } from '../../media/photo-inbox';

// The worker agent's tool contract — a SECOND, deliberately incompatible type
// system sitting beside ../types.ts.
//
// Read the two side by side once and the design is obvious: `WorkerContext` and
// `ToolContext` are MUTUALLY UNASSIGNABLE. Each requires fields the other does
// not have, so neither is a subtype of the other, so a `CapoTool` cannot be put
// in `workerRoster` and a `WorkerTool` cannot be put in `roster`. That is the
// isolation — a type error, produced by `tsc --noEmit` on every package in CI,
// not a review comment somebody has to remember to write.
//
// This is the first place in this codebase where UNTRUSTED TEXT reaches a
// model. A worker's phone can write any sentence at all, including a very good
// impression of the manager giving an order, and there is no auth.uid() on this
// path so RLS backstops nothing. Every safety property here therefore has to be
// something the compiler or the database enforces. Prefer a compile error over
// a runtime check, and a runtime check over a sentence in a prompt.

/**
 * One photo that arrived with the inbound message, already downloaded from
 * Meta's CDN and held in memory just long enough to be STAGED.
 *
 * ⚠ THE MODEL NEVER SEES ONE OF THESE ANY MORE. Since 0047 the route downloads
 * an inbound image and hands it straight to `stageInboxPhoto`
 * (media/photo-inbox.ts), which writes the bytes into the company's own inbox
 * prefix inside the task-photos bucket. What the agent loop reads instead is
 * `InboxPhoto` below: an id and a time, loaded from the database, covering
 * every photo this crew member has sent that no task has claimed yet.
 *
 * That staging is the fix for the limit this type used to carry. A task photo's
 * object key is `{company_id}/{task_id}/{uuid}.{ext}` (media/photos.ts) and
 * segment 1 of it is the tenant boundary the storage.objects policies read, so
 * the bytes cannot be written into a TASK folder until the task is known, and
 * the task is only known once `declare_task_done` names it. Keeping them
 * somewhere that is not a task folder is what makes "photo now, which job a
 * minute later" work at all.
 *
 * Hop 1's media URL lasts ~5 minutes and is effectively single-use, so the
 * download still cannot be deferred. `id` is ours rather than Meta's media id,
 * so nothing derived from it can be replayed against the Graph API.
 */
export interface PendingPhoto {
  id: string;
  mime: TaskPhotoMime;
  bytes: Uint8Array;
  byteSize: number;
}

/**
 * Everything a worker tool is allowed to know.
 *
 * Compare `ToolContext` (../types.ts): it carries `userId`, `actor`,
 * `recentUserTexts` and `locales`. NONE of them appear here, and each absence
 * closes a specific door:
 *
 *   recentUserTexts — the guard's entire evidence pool (guard.ts:26-37). There
 *     is no manager in this loop, so "the manager told me to" is not a claim
 *     that can be made, checked, or forged. `WorkerTool` correspondingly has no
 *     `guarded` field AT ALL, rather than a `guarded?: never` — the concept is
 *     absent, not disabled.
 *   userId — profiles.id. `set_language` (language.ts:39) needs it to write one
 *     manager's dial; a worker has no profile and must not be able to write
 *     anyone's.
 *   actor — 'manager' | 'capo', recorded as tasks.source. A worker is neither.
 *   locales — the two-dial LocaleContext, one of whose dials is the COMPANY's
 *     stored-text language. A worker gets one locale: the language spoken to
 *     THEM. They cannot move what the company stores.
 *
 * The escalation path is closed by the type checker rather than by vigilance:
 * `createProposal` (propose.ts) takes a `ToolContext`, and no worker tool can
 * construct one. A worker therefore cannot manufacture an approval card for the
 * manager to tap.
 */
export interface WorkerContext {
  /**
   * ALWAYS the service-role client. There is no session on this path — the
   * WhatsApp webhook is a system caller and auth.uid() is null — so RLS
   * enforces NOTHING here. Every scoping filter below is doing work that RLS
   * does elsewhere; none of them is defence in depth.
   */
  db: Db;
  /** From workers.company_id, resolved by PHONE (or BSUID). Never from input. */
  companyId: string;
  /** From workers.id, resolved by PHONE (or BSUID). Never from input. */
  workerId: string;
  conversationId: string;
  /** workers.language ?? companies.language. One dial, theirs. */
  locale: Locale;
  /**
   * The ONLY task ids this turn may touch, computed BEFORE the model runs from
   * this worker's own open rows on `task_board`.
   *
   * Never widened by anything the model or the worker says. A guessed uuid —
   * including a real one belonging to a colleague in the same company — is
   * refused in-process, so it never reaches the database at all and cannot be
   * timed as an existence oracle.
   */
  scope: { taskIds: readonly string[] };
  /** The evening ask this reply belongs to; null for an unprompted message. */
  checkinId: string | null;
  /**
   * Every photo this crew member has sent that no task has claimed yet, loaded
   * fresh from `worker_photo_inbox` at the start of the turn (0047).
   *
   * NOT this message's photos. That was the old shape and it was the bug: a
   * photo sent on its own, explained a minute later, was already gone by the
   * second turn, and three photos sent as three messages left only the last.
   *
   * Ids and arrival times only. No bytes, no dimensions, no filename, and
   * nothing read out of the image: the model is told a photo exists, never what
   * is in it.
   */
  pendingPhotos: readonly InboxPhoto[];
  /**
   * THE FALLBACK, and normally empty (0047 + fix round 1).
   *
   * Staging a photo into the inbox can fail: a deploy that lands before 0047 is
   * applied answers 42P01 on every query, and Storage can refuse a write for an
   * afternoon. When it does, the route hands the bytes it already downloaded
   * straight through here instead of losing them, and `declare_task_done`
   * writes them with `storeWorkerTaskPhoto` — the pre-0047 path, which touches
   * no table 0047 creates.
   *
   * Every id in here also appears in `pendingPhotos`, so the model sees ONE
   * list and cannot tell the two apart. It should not have to: which storage
   * mechanism kept a photo is not a fact about the crew member's day.
   *
   * REQUIRED rather than optional, for `confirmPosture`'s reason: a new call
   * site that forgot it would silently lose photos in exactly the window this
   * field exists for, and an empty array has to be written out on purpose.
   */
  unstagedPhotos: readonly PendingPhoto[];
  /** Model turns this worker has left today. Informational inside the loop —
   *  the cap is enforced before the loop starts, where refusing costs nothing. */
  budget: number;
}

/**
 * The worker roster contract.
 *
 * `execute` is a FUNCTION-TYPED PROPERTY, not a method. That is not a style
 * choice: TypeScript checks method parameters BIVARIANTLY even under
 * `strictFunctionTypes`, and only a property gets the contravariant check that
 * makes a wrong context type an error. `CapoTool.execute` is a method, so the
 * incompatibility has to come from the context types themselves — which is why
 * they are mutually unassignable rather than merely different.
 *
 * `audience` is the belt to that braces. It is required here and absent from
 * `CapoTool`, so no manager tool can ever satisfy this interface no matter what
 * later happens to the two context shapes. It costs one line per tool and it
 * survives refactors that structural reasoning would not.
 *
 * There is NO `guarded` field. See WorkerContext above.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface WorkerTool<In = any, Out = any> {
  readonly audience: 'worker';
  name: string;
  description: string;
  inputSchema: z.ZodType<In>;
  execute: (input: In, ctx: WorkerContext) => Promise<Out>;
}

/**
 * What a worker tool returns when it refuses. Deliberately terse and
 * MACHINE-FACING: the model renders the refusal to the worker in their own
 * language, and a message that quoted an id back would turn a refusal into an
 * oracle about which ids exist.
 */
export interface WorkerToolError {
  status: 'error';
  message: string;
}

export type { InboxPhoto } from '../../media/photo-inbox';

export function workerToolError(message: string): WorkerToolError {
  return { status: 'error', message };
}
