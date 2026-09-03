import type { Db } from '@capo/db/client';
import {
  TASK_PHOTO_BUCKET,
  checkTaskPhoto,
  isTaskPhotoMime,
  taskPhotoPath,
  type TaskPhotoMime,
} from './photos';
import { errorText, logPhotoStoreFailure } from './photo-log';
import { photoInboxLive } from './photo-inbox';

// The ONE writer of a crew-sourced task photo.
//
// Three paths now put a worker's photo into Storage — the restricted agent's
// `declare_task_done` (issue #22), the check-in photo follow-up (issue #52) and
// the photo inbox (0047), which since 0047 is how the first two actually get
// their bytes — and they must not drift, because what they write is an
// ATTRIBUTION. A
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
  const rejection = checkTaskPhoto(photo.mime, photo.byteSize);
  if (rejection !== null) {
    logPhotoStoreFailure({ stage: 'check', companyId, workerId, taskId, error: rejection });
    return null;
  }

  const path = taskPhotoPath(companyId, taskId, photo.id, photo.mime);
  try {
    const { error: uploadError } = await db.storage
      .from(TASK_PHOTO_BUCKET)
      .upload(path, photo.bytes, { contentType: photo.mime, upsert: false });
    if (uploadError) {
      logPhotoStoreFailure({ stage: 'upload', companyId, workerId, taskId, error: uploadError.message });
      return null;
    }

    const { error: rowError } = await db.from('task_photos').insert({
      company_id: companyId,
      task_id: taskId,
      storage_path: path,
      source: 'worker',
      worker_id: workerId,
      mime: photo.mime,
      byte_size: photo.byteSize,
    });
    if (rowError) {
      logPhotoStoreFailure({ stage: 'row', companyId, workerId, taskId, error: rowError.message });
      return null;
    }
  } catch (err) {
    logPhotoStoreFailure({ stage: 'exception', companyId, workerId, taskId, error: errorText(err) });
    return null;
  }

  return path;
}

/**
 * Attach photos that have been WAITING in the inbox (0047) to a task.
 *
 * The second way a crew-sourced `task_photos` row is written, and deliberately
 * in this file rather than beside the inbox reader: what a `source: 'worker'`
 * row asserts is an ATTRIBUTION that 0023 makes unforgeable at the grant layer,
 * and two places writing that claim would eventually disagree about it.
 *
 * ── THE TENANT BOUNDARY IS THESE FILTERS ───────────────────────────────────
 * The caller runs on the service role, so RLS enforces nothing. `company_id`
 * and `worker_id` are both phone-derived and both are applied to the inbox read
 * below, in ONE query, so a photo id belonging to a colleague, another company,
 * or nobody at all collapses into the same silent miss with no timing
 * difference to read as an existence oracle. The TASK has already been proven
 * to be this worker's own by the caller (three filters, the same shape
 * `declare_task_done` and `seekPhotoTarget` both use); this function does not
 * re-prove it and must never be called without it.
 *
 * ── OBJECT, ROW, THEN BOOKKEEPING ──────────────────────────────────────────
 * Move the bytes, write the row, stamp the inbox. Every ordering here is chosen
 * for what a crash in the middle leaves behind:
 *   - move then row: an object in a task folder with no row is invisible and
 *     harmless, exactly as `storeWorkerTaskPhoto`'s upload-then-insert is. A row
 *     first would name bytes that may never arrive, and there is no DELETE
 *     policy to clear it with.
 *   - row then stamp: the photo IS attached at that point, and a lost stamp
 *     only means the inbox goes on offering it until it expires. The next
 *     attempt's move fails (the object has gone), so it cannot be double
 *     attached; it is logged, not silent.
 *
 * Never throws, and one photo failing must never abort the others. A batch is a
 * batch of independent photos, and a claim with two of three photos is far
 * better than a claim with none.
 */
export interface AttachInboxPhotosInput {
  photoIds: readonly string[];
  taskId: string;
  companyId: string;
  workerId: string;
  /** For the expiry re-check. Passed in so this stays testable and single-clocked. */
  now?: number;
}

export async function attachInboxPhotos(
  db: Db,
  { photoIds, taskId, companyId, workerId, now = Date.now() }: AttachInboxPhotosInput,
): Promise<{ attached: number }> {
  const ids = [...new Set(photoIds)];
  if (ids.length === 0) return { attached: 0 };

  let rows: { id: string; storage_path: string; mime: string; byte_size: number; expires_at: string }[];
  try {
    const { data, error } = await db
      .from('worker_photo_inbox')
      .select('id, storage_path, mime, byte_size, expires_at')
      .in('id', ids)
      .eq('company_id', companyId)
      .eq('worker_id', workerId)
      .is('attached_task_id', null);
    if (error) {
      logPhotoStoreFailure({ stage: 'read', companyId, workerId, taskId, error: error.message });
      return { attached: 0 };
    }
    rows = data ?? [];
  } catch (err) {
    logPhotoStoreFailure({ stage: 'exception', companyId, workerId, taskId, error: errorText(err) });
    return { attached: 0 };
  }

  let attached = 0;
  for (const row of rows) {
    // Re-checked here as well as in the reader, because a prompt built minutes
    // ago can still name an id that has since gone stale. Fail closed, for
    // `photoInboxLive`'s own reason.
    if (!photoInboxLive(row.expires_at, now)) continue;
    if (!isTaskPhotoMime(row.mime)) {
      logPhotoStoreFailure({ stage: 'check', companyId, workerId, taskId, photoId: row.id, error: 'mime' });
      continue;
    }
    // The object's new name is the inbox row's own id, so the key in the bucket
    // and the row that produced it name each other. Nothing is derived from the
    // old basename.
    const path = taskPhotoPath(companyId, taskId, row.id, row.mime);
    try {
      const { error: moveError } = await db.storage
        .from(TASK_PHOTO_BUCKET)
        .move(row.storage_path, path);
      if (moveError) {
        logPhotoStoreFailure({ stage: 'move', companyId, workerId, taskId, photoId: row.id, error: moveError.message });
        continue;
      }

      const { error: rowError } = await db.from('task_photos').insert({
        company_id: companyId,
        task_id: taskId,
        storage_path: path,
        source: 'worker',
        worker_id: workerId,
        mime: row.mime,
        byte_size: row.byte_size,
      });
      if (rowError) {
        logPhotoStoreFailure({ stage: 'row', companyId, workerId, taskId, photoId: row.id, error: rowError.message });
        continue;
      }
      attached += 1;

      const { error: stampError } = await db
        .from('worker_photo_inbox')
        .update({ storage_path: path, attached_task_id: taskId, attached_at: new Date(now).toISOString() })
        .eq('id', row.id);
      if (stampError) {
        logPhotoStoreFailure({ stage: 'stamp', companyId, workerId, taskId, photoId: row.id, error: stampError.message });
      }
    } catch (err) {
      logPhotoStoreFailure({ stage: 'exception', companyId, workerId, taskId, photoId: row.id, error: errorText(err) });
    }
  }

  return { attached };
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
