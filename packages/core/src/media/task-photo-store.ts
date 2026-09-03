import type { Db } from '@capo/db/client';
import {
  TASK_PHOTO_BUCKET,
  checkTaskPhoto,
  isTaskPhotoMime,
  taskPhotoPath,
  type TaskPhotoMime,
} from './photos';
import { errorText, logPhotoStored, logPhotoStoreFailure } from './photo-log';
import { photoInboxLive } from './photo-inbox';

// The ONE writer of a crew-sourced task photo.
//
// TWO functions here put bytes into the bucket, and the difference between them
// is only WHERE THE BYTES ARE COMING FROM:
//
//   attachInboxPhotos    the normal path since 0047. The photo is already in
//                        Storage, staged under the company's inbox prefix, and
//                        is MOVED into the task's folder.
//   storeWorkerTaskPhoto the FALLBACK, and the pre-0047 path. The bytes are in
//                        memory for this request and are uploaded straight to
//                        the task's folder. It is what runs when staging failed
//                        — a deploy that landed before 0047, or a transient
//                        Storage error — so a photo that the pre-0047 product
//                        would have kept is still kept.
//
// ⚠ NEITHER OF THEM WRITES THE ROW. Both call `insertTaskPhotoRow` below, and
// that is deliberate: what a `task_photos` row carries is an ATTRIBUTION.
// `source: 'worker'` is the claim "the crew sent this", and 0023 makes that
// claim unforgeable at the GRANT layer — `source`, `worker_id` and
// `uploaded_by` are absent from the tenant's column-scoped INSERT grant, so
// only a service-role caller can set them. Every caller here is that caller.
// Two functions asserting an attribution would eventually assert it
// differently; one function asserting it means there is one place to read to
// know who is entitled to what.
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
 * The ONE place a crew-sourced `task_photos` row is written.
 *
 * Both writers above end here. `source: 'worker'` and `worker_id` are the
 * ATTRIBUTION, and 0023 makes them unforgeable at the grant layer by leaving
 * them out of the tenant's column-scoped INSERT grant; only the service role
 * can set them, and every caller of this function is the service role.
 *
 * `uploaded_by` is deliberately left to its `auth.uid()` default, which is NULL
 * for the service role — exactly what a crew-sourced row should carry. Do not
 * fill it in; there is no profile behind this write.
 *
 * Returns the Postgres error message on failure, or null on success. It does
 * not log: the caller knows which stage it is in and which photo it was for.
 */
async function insertTaskPhotoRow(
  db: Db,
  row: { companyId: string; taskId: string; workerId: string; path: string; mime: TaskPhotoMime; byteSize: number },
): Promise<string | null> {
  const { error } = await db.from('task_photos').insert({
    company_id: row.companyId,
    task_id: row.taskId,
    storage_path: row.path,
    source: 'worker',
    worker_id: row.workerId,
    mime: row.mime,
    byte_size: row.byteSize,
  });
  return error ? error.message : null;
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
 * THE FALLBACK PATH, and the reason it was not deleted when 0047 landed. It
 * runs when staging a photo into the inbox failed — most importantly on a
 * deploy that lands before 0047 is applied, where every query on
 * `worker_photo_inbox` answers 42P01. This function touches no table 0047
 * creates, so a photo that the pre-0047 product would have kept is still kept,
 * by both crew paths. On this project a migration has sat merged and unapplied
 * for three weeks while the app half was live; that window must not be one
 * where nobody can attach a photo to anything.
 *
 * Never throws. Every caller is inside a WhatsApp turn where a failed photo
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

    const rowError = await insertTaskPhotoRow(db, {
      companyId,
      taskId,
      workerId,
      path,
      mime: photo.mime,
      byteSize: photo.byteSize,
    });
    if (rowError) {
      logPhotoStoreFailure({ stage: 'row', companyId, workerId, taskId, error: rowError });
      return null;
    }
  } catch (err) {
    logPhotoStoreFailure({ stage: 'exception', companyId, workerId, taskId, error: errorText(err) });
    return null;
  }

  logPhotoStored({ companyId, workerId, taskId, path, photoId: photo.id });
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

      const rowError = await insertTaskPhotoRow(db, {
        companyId,
        taskId,
        workerId,
        path,
        mime: row.mime,
        byteSize: row.byte_size,
      });
      if (rowError) {
        logPhotoStoreFailure({ stage: 'row', companyId, workerId, taskId, photoId: row.id, error: rowError });
        continue;
      }
      attached += 1;
      logPhotoStored({ companyId, workerId, taskId, path, photoId: row.id });

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
    // The `error` is READ rather than relied on being thrown. supabase-js
    // reports a refused statement as a VALUE, so the catch below never saw a
    // PostgREST refusal at all and this function reported success on every one
    // of them — a revoked grant, an unapplied migration and a healthy write
    // were indistinguishable from the outside. The catch stays for a genuine
    // transport failure, which is the only thing that actually throws here.
    const { error } = await db
      .from('tasks')
      .update({ completion_proof: 'photos' })
      .eq('id', taskId)
      // Defence in depth: the caller resolved this task within the tenant
      // already, and this makes a mis-wired call site fail closed rather than
      // write across companies. Note it deliberately does NOT touch `status` —
      // an update of status would fire tasks_supersede_review (0020) and
      // supersede the very claim the photo is proof for.
      .eq('company_id', companyId);
    if (error) {
      logPhotoStoreFailure({ stage: 'proof', companyId, taskId, error: error.message });
    }
  } catch (err) {
    // Still swallowed on purpose — see the note above. Said out loud, though:
    // this column is a denormalised convenience and losing it costs no
    // evidence, but a table that quietly stops filling in is exactly the shape
    // of silence this file exists to end.
    logPhotoStoreFailure({ stage: 'proof', companyId, taskId, error: errorText(err) });
  }
}

/**
 * Record that this task's completion has NO photographic proof behind it
 * (0049, the no-photo waiver).
 *
 * NULL, never 'skipped'. Those are different sentences and only one of them is
 * ours to write: 'skipped' is the MANAGER declining proof through the
 * completion sheet, and 0034's column comment says so. NULL is UNKNOWN, which
 * is the honest value for a claim filed by somebody who could not photograph
 * anything — the manager may still walk over and look, and a photo sent later
 * still attaches, because a task in `pending_review` is still open
 * (task_board.is_open is a denylist, 0013) and nothing on the photo path reads
 * its status.
 *
 * Unconditional within the task, and that is deliberate rather than careless.
 * The column answers "does THIS completion have proof", and this one does not;
 * a 'photos' left over from an earlier, superseded claim on the same task is a
 * statement about a different moment. Nothing evidential is lost either way:
 * the board and the inbox count `task_photos` at read time, which is what
 * actually tells the manager whether there is anything to look at.
 *
 * Best-effort and never throws, for markTaskProofPhotos' reason, and like it
 * this deliberately does NOT touch `status` — an update of status would fire
 * tasks_supersede_review (0020) and supersede the claim it is about.
 */
export async function markTaskProofUnknown(
  db: Db,
  companyId: string,
  taskId: string,
): Promise<void> {
  try {
    // Reads `error` for markTaskProofPhotos' reason, and it is the same latent
    // defect: 0049 copied that function's shape, catch and all, so the bug was
    // duplicated before it was found. Fixing one and not the other would leave
    // a copy of it behind in the path taken by the crew members who could not
    // photograph anything, which is the half nobody watches.
    const { error } = await db
      .from('tasks')
      .update({ completion_proof: null })
      .eq('id', taskId)
      .eq('company_id', companyId);
    if (error) {
      logPhotoStoreFailure({ stage: 'proof', companyId, taskId, error: error.message });
    }
  } catch (err) {
    // Still swallowed on purpose — see the note above.
    logPhotoStoreFailure({ stage: 'proof', companyId, taskId, error: errorText(err) });
  }
}
