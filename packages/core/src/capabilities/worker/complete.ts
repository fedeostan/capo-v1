import { z } from 'zod';
import {
  TASK_PHOTO_BUCKET,
  checkTaskPhoto,
  taskPhotoPath,
} from '../../media/photos';
import type { PendingPhoto, WorkerContext, WorkerTool } from './types';
import { workerToolError } from './types';

// "Acabei" — a worker declaring a task finished, with proof.
//
// Everything about this tool is arranged around one sentence from the PRD:
// PHOTOS ARE MANDATORY AT THE SCHEMA LEVEL, NEVER BY PROMPT INSTRUCTION. A
// prompt rule is negotiable by anyone who can write text, and the person on the
// other end of this conversation can write any text they like. `.min(1)` is
// not: the tool call is rejected before `execute` is entered, by the same
// validation the AI SDK applies to every argument, and there is no phrasing
// that gets past it. That is the difference the whole feature turns on.
//
// What a successful call produces is a CLAIM, not a completion. The task moves
// to `pending_review` and stays visible on the manager's board, still counted
// overdue if its dates say so (task_board.is_open is a denylist — 0013:71). A
// worker who lies is loud, never silent. The manager approves, rejects or
// dismisses it from the board; 0024's trigger has already put it in their inbox
// and 0026 has already pushed it to their phone, with no edit needed here.

const uuid = z.string().uuid();

export const declareTaskDoneInput = z.object({
  task_id: uuid.describe('From my_tasks. Must be one of THIS crew member\'s own open tasks.'),
  photo_ids: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      // The description explains the rule; the .min(1) above ENFORCES it. If
      // you ever find yourself relaxing the schema and moving the requirement
      // into this sentence, you have removed the feature.
      'Ids of photos received in this conversation, from the "# Photos received" block. At least one is required — a completion cannot be recorded without proof, and there is no way to call this tool without it.',
    ),
  note: z
    .string()
    .max(500)
    .optional()
    .describe(
      "The worker's own words about the job, copied as they wrote them — never your summary of them. The manager reads this as a quote attributed to them. Leave it out if they said nothing beyond \"done\".",
    ),
});

type DeclareTaskDoneInput = z.infer<typeof declareTaskDoneInput>;

interface StoredPhoto {
  photo: PendingPhoto;
  path: string;
}

/**
 * Write one photo's bytes into the bucket and record the row that points at it.
 *
 * Object first, row second, and the order is forced: `task_photos.storage_path`
 * is `unique` and its `task_photos_path_scoped` CHECK re-derives the key, so a
 * row written first would name bytes that may never arrive. A dead object with
 * no row is invisible and harmless; a row with no object renders a broken frame
 * on the manager's screen forever.
 *
 * `source: 'worker'` and `worker_id` are written HERE, on the service role,
 * which bypasses the column-scoped INSERT grant that stops a manager writing
 * them (0023). That grant is what makes "the crew sent proof" unforgeable by a
 * tenant; this is the one caller entitled to say it, and it says it because it
 * resolved the worker from their phone number, not from anything in the model's
 * arguments.
 *
 * `uploaded_by` is deliberately left to its `auth.uid()` default, which is NULL
 * for the service role — exactly what a worker-sourced row should carry. Do not
 * fill it with anything; there is no profile behind this write.
 */
async function storePhoto(
  ctx: WorkerContext,
  taskId: string,
  photo: PendingPhoto,
): Promise<StoredPhoto | null> {
  // Re-checked here even though the route checks on download. The route's check
  // protects the download; this one protects the write, and the two are far
  // enough apart in the call graph that sharing one check would be sharing an
  // assumption.
  if (checkTaskPhoto(photo.mime, photo.byteSize) !== null) return null;

  const path = taskPhotoPath(ctx.companyId, taskId, photo.id, photo.mime);
  const { error: uploadError } = await ctx.db.storage
    .from(TASK_PHOTO_BUCKET)
    .upload(path, photo.bytes, { contentType: photo.mime, upsert: false });
  if (uploadError) return null;

  const { error: rowError } = await ctx.db.from('task_photos').insert({
    company_id: ctx.companyId,
    task_id: taskId,
    storage_path: path,
    source: 'worker',
    worker_id: ctx.workerId,
    mime: photo.mime,
    byte_size: photo.byteSize,
  });
  if (rowError) return null;

  return { photo, path };
}

export const declareTaskDone: WorkerTool<DeclareTaskDoneInput> = {
  audience: 'worker',
  name: 'declare_task_done',
  description:
    'Record that this crew member has finished one of THEIR OWN tasks, with the photos they just sent. This does NOT mark the task done — it files a claim that the manager must approve, and the task stays on their board until they do. Requires at least one photo; if none have arrived, ask for one and do not call this tool.',
  inputSchema: declareTaskDoneInput,
  execute: async (input, ctx) => {
    // ── the in-process scope check, BEFORE any query ─────────────────────────
    // ctx.scope.taskIds was computed from this worker's own open rows before
    // the model ran, and nothing the model or the worker says can widen it. A
    // uuid that is not in it never reaches the database at all — so a valid id
    // belonging to a colleague in the same company is refused without a round
    // trip, which also means it cannot be TIMED as an existence oracle.
    //
    // The three .eq() filters below are the second boundary, not the first, and
    // two of the three are values the model never supplies.
    if (!ctx.scope.taskIds.includes(input.task_id)) {
      return workerToolError('That task is not one of yours. Call my_tasks and use an id from it.');
    }

    // ── the second boundary: three filters, two of them phone-derived ────────
    // ONE query, so "no such task", "not your company" and "not assigned to
    // you" collapse into a single silent outcome with no timing difference to
    // read as an existence oracle. Same shape as the proposal-ownership read on
    // the manager's button path.
    //
    // Not redundant with the scope check above, and this is the case that
    // motivates it: `scope` was computed at the START of the turn, and the
    // manager may have reassigned or closed the task since. Without this, a
    // conversation left open while the board changed underneath would file a
    // claim against work that is no longer this person's. Everything below runs
    // on the service role, so nothing else re-checks it.
    const { data: task } = await ctx.db
      .from('tasks')
      .select('id')
      .eq('id', input.task_id)
      .eq('company_id', ctx.companyId)
      .eq('assignee_worker_id', ctx.workerId)
      .maybeSingle();
    if (!task) {
      return workerToolError('That task is not one of yours. Call my_tasks and use an id from it.');
    }

    // Only photos that arrived in THIS turn exist. The model has no fetch
    // capability and no way to name bytes it was not handed, so this is a
    // consistency check rather than a boundary — but it is what keeps a
    // hallucinated id from producing a claim with nothing behind it.
    const byId = new Map(ctx.pendingPhotos.map(p => [p.id, p]));
    const requested = [...new Set(input.photo_ids)].map(id => byId.get(id)).filter((p): p is PendingPhoto => !!p);
    if (requested.length === 0) {
      return workerToolError(
        'None of those photo ids arrived in this conversation. Ask the worker to send the photo again, in the same message as their message.',
      );
    }

    // ── photos first, claim second ───────────────────────────────────────────
    // Dying between the two leaves proof with no claim: untidy, visible, and
    // recoverable by the worker saying so again. The reverse order would leave
    // a claim with no proof — precisely the state `.min(1)` exists to make
    // impossible, reached by a crash instead of by an argument.
    const stored: StoredPhoto[] = [];
    for (const photo of requested) {
      const result = await storePhoto(ctx, input.task_id, photo);
      if (result) stored.push(result);
    }
    if (stored.length === 0) {
      return workerToolError('The photos could not be saved. Ask the worker to send them again.');
    }

    // open_task_review moves the task to pending_review and files the claim in
    // ONE transaction (0018). Never two client-side updates: a half-applied
    // state — a review with the task still open, or a task in review with no
    // review row — is exactly what this feature exists to prevent.
    //
    // p_worker is ctx.workerId, phone-derived. It is what makes the claim
    // attributable, and it is not something the model can supply.
    const { data: reviewId, error } = await ctx.db.rpc('open_task_review', {
      p_task: input.task_id,
      p_worker: ctx.workerId,
      // Left OFF the payload when absent rather than sent as null: the RPC's
      // own default is null, and PostgREST types the argument as optional.
      p_note: input.note,
    });

    if (error) {
      // task_reviews_one_pending_idx (0018) is the throttle: a second
      // declaration while one is outstanding trips a unique violation. That is
      // not an error the worker caused twice — it is Capo already having their
      // claim — so it gets its own answer rather than "something went wrong".
      // The photos above are already attached to the task either way, which is
      // the right outcome: more proof on a claim already waiting.
      const duplicate = error.code === '23505' || /task_reviews_one_pending/.test(error.message);
      return workerToolError(
        duplicate
          ? 'This task is already waiting for the manager to approve it. Tell them so, and that the new photos were added.'
          : 'Could not record the completion. Tell the worker to speak to their manager.',
      );
    }

    return {
      status: 'ok' as const,
      review_id: reviewId,
      photos_attached: stored.length,
      // Model-facing, and the one thing it MUST get across: the task is not
      // done. A worker told "feito" who then sees it still on tomorrow's 07:00
      // message will conclude Capo is broken.
      instruction:
        'Recorded and sent to the manager for approval. Tell the worker briefly that it is with the manager now and NOT yet closed — never say the task is done or closed. Do not restate the photo count as a number they did not ask for.',
    };
  },
};
