import type { Db } from '@capo/db/client';
import {
  TASK_PHOTO_BUCKET,
  checkTaskPhoto,
  taskPhotoPath,
  type TaskPhotoMime,
} from './photos';

// The ONE writer of a crew-sourced task photo.
//
// Two paths now put a worker's photo into Storage — the restricted agent's
// `declare_task_done` (issue #22) and the check-in photo follow-up (issue #52)
// — and they must not drift, because what they write is an ATTRIBUTION. A
// `task_photos` row saying `source: 'worker'` is the claim "the crew sent
// this", and 0023 makes that claim unforgeable at the GRANT layer: `source`,
// `worker_id` and `uploaded_by` are absent from the tenant's column-scoped
// INSERT grant, so only a service-role caller can set them. Both callers here
// are that caller. Having one function say it means there is one place to read
// to know who is entitled to.
//
// Deliberately separate from ./photos.ts, which is dependency-free because the
// manager's completion sheet is a CLIENT component and imports it for its
// pre-flight check. Anything imported there lands in the browser bundle; `Db`
// must not.
//
// PHOTOS ARE NEVER SHOWN TO A MODEL. Nothing in this file returns bytes to a
// caller and nothing reads the bucket back. An inbound image can carry text and
// text is instructions, so a vision pass anywhere near this path would be a
// prompt-injection surface with nothing in front of it (0023, AGENTS.md).

/**
 * One already-downloaded photo, held in memory for the duration of the request
 * that received it.
 *
 * Structurally identical to `PendingPhoto` (capabilities/worker/types.ts) and
 * deliberately NOT an import of it: this module must stay importable from the
 * WhatsApp route without dragging the worker tool contract along, and the
 * worker package must not have to import a writer to describe a photo.
 */
export interface StorableTaskPhoto {
  /** Ours, never Meta's media id — see PendingPhoto for why that matters. */
  id: string;
  mime: TaskPhotoMime;
  bytes: Uint8Array;
  byteSize: number;
}

export interface StoreWorkerPhotoInput {
  companyId: string;
  taskId: string;
  workerId: string;
  photo: StorableTaskPhoto;
}

/**
 * Write one photo's bytes into the bucket and record the row that points at it.
 * Returns the object key on success, or null on any refusal or failure.
 *
 * OBJECT FIRST, ROW SECOND, and the order is forced rather than chosen:
 * `task_photos.storage_path` is `unique` and its `task_photos_path_scoped`
 * CHECK re-derives the key, so a row written first would name bytes that may
 * never arrive. A dead object with no row is invisible and harmless — nothing
 * lists the bucket. A row with no object renders a broken frame on the
 * manager's screen forever, and there is no DELETE policy to clear it with.
 *
 * `uploaded_by` is deliberately left to its `auth.uid()` default, which is NULL
 * for the service role — exactly what a crew-sourced row should carry. Do not
 * fill it in; there is no profile behind this write.
 *
 * Never throws. Both callers are inside a WhatsApp turn where a failed photo
 * must cost the photo and nothing else: the agent path still has a claim to
 * file, and the check-in path still owes the worker an answer.
 */
export async function storeWorkerTaskPhoto(
  db: Db,
  { companyId, taskId, workerId, photo }: StoreWorkerPhotoInput,
): Promise<string | null> {
  // Re-checked here even though every caller checks on download. The caller's
  // check protects the DOWNLOAD; this one protects the WRITE, and the two are
  // far enough apart in the call graph that sharing one check would be sharing
  // an assumption. The bucket's own file_size_limit/allowed_mime_types and the
  // CHECK constraints on task_photos are the two that bind regardless.
  if (checkTaskPhoto(photo.mime, photo.byteSize) !== null) return null;

  const path = taskPhotoPath(companyId, taskId, photo.id, photo.mime);
  try {
    const { error: uploadError } = await db.storage
      .from(TASK_PHOTO_BUCKET)
      .upload(path, photo.bytes, { contentType: photo.mime, upsert: false });
    if (uploadError) return null;

    const { error: rowError } = await db.from('task_photos').insert({
      company_id: companyId,
      task_id: taskId,
      storage_path: path,
      source: 'worker',
      worker_id: workerId,
      mime: photo.mime,
      byte_size: photo.byteSize,
    });
    if (rowError) return null;
  } catch {
    return null;
  }

  return path;
}

/**
 * Record that this task's completion has photographic proof behind it.
 *
 * `tasks.completion_proof` was the completion sheet's column until #52 (0023),
 * where 'photos' meant "the manager attached some". Both crew paths now write
 * it at the moment proof is attached — which is BEFORE the task is closed at
 * all, since a crew photo rides a `pending_review` CLAIM rather than a
 * completion. The column therefore answers "does this task's completion have
 * proof", which is the question every reader was already asking of it. 0034
 * restates the column comment accordingly.
 *
 * 'skipped' is NOT written here and must never be: only the manager can decline
 * proof, and only through the sheet. NULL still means UNKNOWN.
 *
 * Best-effort and never throws. The photo is already in the bucket and already
 * recorded in `task_photos` by the time this runs, and `task_photos` — not this
 * column — is what the board and the inbox count when they tell the manager
 * whether a claim has proof. Losing this write costs a denormalised convenience,
 * never the evidence.
 */
export async function markTaskProofPhotos(
  db: Db,
  companyId: string,
  taskId: string,
): Promise<void> {
  try {
    await db
      .from('tasks')
      .update({ completion_proof: 'photos' })
      .eq('id', taskId)
      // Defence in depth: the caller resolved this task within the tenant
      // already, and this makes a mis-wired call site fail closed rather than
      // write across companies. Note it deliberately does NOT touch `status` —
      // an update of status would fire tasks_supersede_review (0020) and
      // supersede the very claim the photo is proof for.
      .eq('company_id', companyId);
  } catch {
    // Swallowed on purpose — see the note above.
  }
}
