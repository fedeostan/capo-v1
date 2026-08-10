import { randomUUID } from 'node:crypto';
import type { AuthContext } from '@capo/db/session';
import {
  TASK_PHOTO_BUCKET,
  TASK_PHOTO_MAX_PER_UPLOAD,
  checkTaskPhoto,
  isTaskPhotoMime,
  taskPhotoPath,
  type TaskPhotoMime,
} from '@capo/core/media/photos';

// Server-side intake for task photos. Everything the browser sends is
// untrusted — the mime string, the byte count, the pixels themselves — so the
// browser's own checks in the completion sheet are a courtesy, and this file
// is the gate.
//
// Read on the RLS-scoped client from AuthContext, never getDb(): the Storage
// upload has to run under the manager's own session or the storage.objects
// INSERT policy (0022) has no identity to check the path segment against.

/**
 * Reasons a photo or a batch is refused, in the same machine-readable shape as
 * checkTaskPhoto's. The caller maps these to copy in the manager's language;
 * this module holds no user-facing strings.
 */
export type TaskPhotoFailure =
  | 'mime' // not jpeg/png/webp, or the bytes disagree with the declared type
  | 'too_large'
  | 'empty'
  | 'too_many'
  | 'unknown_task'
  | 'upload_failed';

export class TaskPhotoError extends Error {
  constructor(readonly reason: TaskPhotoFailure, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'TaskPhotoError';
  }
}

// ── magic bytes ────────────────────────────────────────────────────────────
// `file.type` is whatever the browser (or a hand-rolled POST) says it is. The
// bucket's allowed_mime_types checks the SAME claimed string, so neither the
// allowlist nor the bucket can tell a renamed file from a real one. Reading the
// first bytes is the only check that looks at the thing itself.
//
// Low stakes on their own — Storage serves objects with their stored
// content-type, so a mislabelled file renders as a broken image rather than
// executing — but "rejected server-side, not just in the browser" should mean
// the server actually looked.
function sniffImageMime(bytes: Uint8Array): TaskPhotoMime | null {
  // FF D8 FF — JPEG (SOI plus the first marker).
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // 89 'P' 'N' 'G' 0D 0A 1A 0A — the full 8-byte PNG signature.
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'image/png';
  // 'RIFF' ....size.... 'WEBP' — the four size bytes in between are skipped.
  const ascii = (offset: number, text: string) =>
    bytes.length >= offset + text.length &&
    [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return null;
}

export interface UploadedTaskPhoto {
  storagePath: string;
  mime: TaskPhotoMime;
  byteSize: number;
  takenAt: string | null;
}

/**
 * Validate → upload the bytes → record the rows. Returns how many landed.
 *
 * Ordering matters and is the reverse of what feels natural: every byte is
 * written to Storage BEFORE any task_photos row exists, and the caller marks
 * the task done only after this returns. Dying between the two writes leaks an
 * object nothing points at — invisible, since nothing lists the bucket, and
 * cheap. Dying in the other order would leave a row promising a photo that was
 * never stored, which the detail screen renders as a broken frame the manager
 * cannot clear. Same "write the thing before recording the thing" rule the
 * translation applier follows (AGENTS.md).
 *
 * Everything is validated before anything is uploaded, so a batch with one bad
 * file leaves no partial upload behind at all.
 */
export async function uploadTaskPhotos(
  { db, companyId }: AuthContext,
  taskId: string,
  files: File[],
): Promise<number> {
  if (files.length === 0) return 0;
  if (files.length > TASK_PHOTO_MAX_PER_UPLOAD) throw new TaskPhotoError('too_many');

  // Confirm the task is ours BEFORE writing objects. The task_photos insert
  // would catch a foreign or missing task anyway (RLS, the FK, and the 0022
  // trigger all would), but only after the bytes are already in the bucket —
  // and the storage.objects policy alone would happily accept
  // {own company}/{a uuid that is not a task}/… as a place to park files.
  const { data: task, error: taskError } = await db
    .from('tasks')
    .select('id')
    .eq('id', taskId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (taskError) throw new TaskPhotoError('unknown_task', taskError.message);
  if (!task) throw new TaskPhotoError('unknown_task');

  const staged: (UploadedTaskPhoto & { bytes: Uint8Array })[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const declared = file.type.split(';')[0].trim().toLowerCase();

    const rejection = checkTaskPhoto(declared, bytes.byteLength);
    if (rejection) throw new TaskPhotoError(rejection);
    // Re-narrow for the type checker: checkTaskPhoto already returned null,
    // which is only possible when isTaskPhotoMime(declared) held.
    if (!isTaskPhotoMime(declared)) throw new TaskPhotoError('mime');

    // The declared type must match what the bytes actually are. Not just
    // "is it an image" — a PNG announced as image/jpeg would be stored with
    // the wrong content-type and served as a broken image forever.
    if (sniffImageMime(bytes) !== declared) throw new TaskPhotoError('mime');

    staged.push({
      bytes,
      storagePath: taskPhotoPath(companyId, taskId, randomUUID(), declared),
      mime: declared,
      byteSize: bytes.byteLength,
      takenAt: normalizeTakenAt(file.lastModified),
    });
  }

  for (const photo of staged) {
    const { error } = await db.storage.from(TASK_PHOTO_BUCKET).upload(photo.storagePath, photo.bytes, {
      contentType: photo.mime,
      // Never overwrite. The path carries a fresh uuid, so a collision means
      // something is wrong; silently replacing an existing photo would destroy
      // evidence the schema otherwise makes undeletable.
      upsert: false,
    });
    if (error) throw new TaskPhotoError('upload_failed', error.message);
  }

  // One insert for the batch: either every photo is recorded or none is, so
  // the manager never sees half a proof set. `source`, `worker_id` and
  // `uploaded_by` are omitted on purpose — the column-scoped INSERT grant in
  // 0022 does not include them, and PostgREST rejects (42501) a request that
  // names them. Their defaults ('manager', auth.uid(), NULL) are the honest
  // values and cannot be talked out of.
  const { error: insertError } = await db.from('task_photos').insert(
    staged.map(p => ({
      company_id: companyId,
      task_id: taskId,
      storage_path: p.storagePath,
      mime: p.mime,
      byte_size: p.byteSize,
      taken_at: p.takenAt,
    })),
  );
  if (insertError) throw new TaskPhotoError('upload_failed', insertError.message);

  return staged.length;
}

/**
 * `file.lastModified` — the file's own timestamp, which for a camera capture
 * is when the shutter fired. Not EXIF: the sheet re-encodes through a canvas
 * before upload, which strips EXIF entirely.
 *
 * Clamped, because it is client input: anything in the future or older than
 * ~10 years is a wrong device clock or a fabrication, and a null reads more
 * honestly than a wrong date. Nothing keys on this column; created_at is the
 * clock that counts.
 */
function normalizeTakenAt(lastModified: number): string | null {
  if (!Number.isFinite(lastModified) || lastModified <= 0) return null;
  const now = Date.now();
  const tenYears = 10 * 365 * 24 * 60 * 60 * 1000;
  if (lastModified > now || lastModified < now - tenYears) return null;
  return new Date(lastModified).toISOString();
}
