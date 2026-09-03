import type { Db } from '@capo/db/client';
import {
  TASK_PHOTO_BUCKET,
  checkTaskPhoto,
  taskPhotoInboxPath,
  type TaskPhotoMime,
} from './photos';
import { errorText, logPhotoStoreFailure } from './photo-log';

// The photo inbox: every image a crew member sends, kept from the moment it
// arrives (0047).
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// A task photo's object key is `{company_id}/{task_id}/{uuid}.{ext}` and
// segment 1 of it IS the tenant boundary the storage.objects policies read
// (0023). So the bytes could not be written anywhere legitimate until the TASK
// was known, and on the agent path the task is only known when the model calls
// `declare_task_done` — in the same turn or never. The bytes therefore lived in
// memory for one turn and were then dropped. A crew member who sent the photo
// and named the job a minute later lost the photo; one who sent three photos as
// three messages kept only the last. On 3 September that produced "I tried 3
// times now. Is not working", which is exactly what it looked like from a
// building site.
//
// Staging under `{company_id}/inbox/{worker_id}/…` needs no new storage policy
// (segment 1 is still the company) and writes no `task_photos` row, so nothing
// about what counts as EVIDENCE changes: a photo becomes evidence when it is
// attached to a task, and not before.
//
// ── PHOTOS ARE STILL NEVER SHOWN TO A MODEL ────────────────────────────────
// Nothing in this file returns bytes and nothing reads the bucket back. The
// model learns a count, a handle and a time. An inbound image can carry text
// and text is instructions, so a vision pass anywhere near this path would be a
// prompt-injection surface with nothing in front of it.

/**
 * How long a staged photo is worth offering back to its sender.
 *
 * 24 hours, and deliberately LONGER than `PHOTO_REQUEST_TTL_MS` (3 hours,
 * apps/web/lib/checkin-photo.ts) even though the two look alike. That one bounds
 * what an unlabelled photo may be BELIEVED to be about, which is a claim about
 * evidence and has to be tight. This one bounds only how long Capo keeps
 * offering somebody their own photo back, so it is sized by the working day: a
 * photo taken at 08:00 and explained at 17:00 still works, and nothing survives
 * to be filed as proof of the following day's work.
 *
 * Enforced by the READER. Nothing sweeps the table and nothing sweeps the
 * objects behind it, which 0047 states out loud rather than implying.
 */
export const PHOTO_INBOX_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How many waiting photos one turn will carry into the prompt and offer to a
 * completion claim.
 *
 * A cap rather than a page: the block it feeds is re-sent on every request of
 * every turn, and a crew member who photographs a whole staircase should not
 * make their own conversation expensive. Oldest first, so the earliest photo of
 * a batch is the one that survives the cap rather than the newest.
 */
export const MAX_INBOX_PHOTOS = 20;

export function photoInboxExpiry(now: number): string {
  return new Date(now + PHOTO_INBOX_TTL_MS).toISOString();
}

/**
 * Whether a staged photo is still worth offering.
 *
 * An unparseable or absent timestamp reads as EXPIRED. Fail closed: the cost in
 * this direction is that a photo has to be sent again, and in the other it is a
 * photo of yesterday's work filed as proof of today's.
 */
export function photoInboxLive(expiresAt: string | null | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at > now;
}

/**
 * One waiting photo, as the agent loop and the model see it.
 *
 * `id` is the `worker_photo_inbox` row id and it is the ONLY member the model
 * ever sees besides the time. It is a handle for `declare_task_done`, nothing
 * more: it names no object key, no media id and no task, and the model has no
 * fetch capability, so a photo it was not told about does not exist as far as
 * it is concerned.
 */
export interface InboxPhoto {
  id: string;
  /** ISO timestamp. Rendered into the prompt so "the one from this morning" is answerable. */
  receivedAt: string;
}

export interface StageInboxPhotoInput {
  companyId: string;
  workerId: string;
  photo: { id: string; mime: TaskPhotoMime; bytes: Uint8Array; byteSize: number };
  /** The caption the image arrived with, if any. Never shown to a model from here. */
  caption?: string | null;
  now: number;
}

/**
 * Put one just-downloaded photo into the inbox. Returns the inbox row id, or
 * null on any refusal or failure.
 *
 * OBJECT FIRST, ROW SECOND, the same ordering `storeWorkerTaskPhoto` takes and
 * for the same reason: `storage_path` is unique and CHECK-constrained, so a row
 * written first would name bytes that may never arrive. A dead object with no
 * row is invisible and harmless; a row with no object is a photo Capo offers
 * and cannot deliver.
 *
 * Never throws. It runs before every branch on the worker path, and a failure
 * here must cost the photo and nothing else.
 */
export async function stageInboxPhoto(
  db: Db,
  { companyId, workerId, photo, caption, now }: StageInboxPhotoInput,
): Promise<string | null> {
  // Re-checked here even though the download checked the mime. The caller's
  // check protects the DOWNLOAD; this one protects the WRITE. The bucket's own
  // file_size_limit/allowed_mime_types and 0047's CHECK constraints are the two
  // that bind regardless.
  const rejection = checkTaskPhoto(photo.mime, photo.byteSize);
  if (rejection !== null) {
    logPhotoStoreFailure({ stage: 'check', companyId, workerId, error: rejection });
    return null;
  }

  const path = taskPhotoInboxPath(companyId, workerId, photo.id, photo.mime);
  try {
    const { error: uploadError } = await db.storage
      .from(TASK_PHOTO_BUCKET)
      .upload(path, photo.bytes, { contentType: photo.mime, upsert: false });
    if (uploadError) {
      logPhotoStoreFailure({ stage: 'upload', companyId, workerId, error: uploadError.message });
      return null;
    }

    const { data, error: rowError } = await db
      .from('worker_photo_inbox')
      .insert({
        company_id: companyId,
        worker_id: workerId,
        storage_path: path,
        mime: photo.mime,
        byte_size: photo.byteSize,
        // Trimmed to nothing rather than stored as an empty string: "no caption"
        // and "a caption of spaces" are the same fact and should read the same.
        caption: caption?.trim() ? caption.trim() : null,
        expires_at: photoInboxExpiry(now),
      })
      .select('id')
      .single();
    if (rowError || !data) {
      // Expected, and harmless, on any deploy landing before 0047 is applied:
      // "relation worker_photo_inbox does not exist". The whole feature then
      // degrades to the pre-0047 product.
      logPhotoStoreFailure({ stage: 'row', companyId, workerId, error: rowError?.message ?? 'no row' });
      return null;
    }
    return data.id;
  } catch (err) {
    logPhotoStoreFailure({ stage: 'exception', companyId, workerId, error: errorText(err) });
    return null;
  }
}

/**
 * This crew member's photos that are still waiting for a task.
 *
 * ── THE TENANT BOUNDARY, AGAIN IN TYPESCRIPT ───────────────────────────────
 * Everything on this path runs on the SERVICE-ROLE client, so RLS enforces
 * nothing at all. `company_id` and `worker_id` are both phone-derived and both
 * filters are what keeps one crew member's photos out of another's turn. There
 * is no colleague case to worry about only because both are applied.
 *
 * Expiry is filtered in SQL AND re-checked here through `photoInboxLive`. Two
 * statements of one rule on purpose: the SQL filter is what keeps the page of
 * rows small, and the pure function is what `pnpm whatsapp-check` can assert
 * with no credentials.
 *
 * Never throws, and answers an empty list on any failure — including 42P01
 * before 0047 is applied. A turn that cannot read the inbox is a turn where the
 * model is told no photos arrived, which is the pre-0047 product.
 */
export async function loadInboxPhotos(
  db: Db,
  companyId: string,
  workerId: string,
  now: number,
): Promise<InboxPhoto[]> {
  try {
    const { data, error } = await db
      .from('worker_photo_inbox')
      .select('id, received_at, expires_at')
      .eq('company_id', companyId)
      .eq('worker_id', workerId)
      .is('attached_task_id', null)
      .gt('expires_at', new Date(now).toISOString())
      .order('received_at', { ascending: true })
      .limit(MAX_INBOX_PHOTOS);
    if (error) {
      logPhotoStoreFailure({ stage: 'read', companyId, workerId, error: error.message });
      return [];
    }
    return (data ?? [])
      .filter(row => photoInboxLive(row.expires_at, now))
      .map(row => ({ id: row.id, receivedAt: row.received_at }));
  } catch (err) {
    logPhotoStoreFailure({ stage: 'exception', companyId, workerId, error: errorText(err) });
    return [];
  }
}

/**
 * How many photos are waiting. Used by the deterministic branch that asks
 * "more photos, or is that everything?" and by the acknowledgement that answers
 * it, so the number a crew member reads is the number the next claim will file.
 */
export async function countInboxPhotos(
  db: Db,
  companyId: string,
  workerId: string,
  now: number,
): Promise<number> {
  return (await loadInboxPhotos(db, companyId, workerId, now)).length;
}
