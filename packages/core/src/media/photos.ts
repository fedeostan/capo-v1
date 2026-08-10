// The one place the task-photo intake rules are written in TypeScript.
//
// Two paths take photos in, and they must not drift apart:
//
//   the manager — apps/web/app/(app)/_tasks, browser → server action → Storage
//   the worker  — PRD 4, WhatsApp → downloadMedia() → Storage
//
// The second one is why this module lives in @capo/core rather than in
// apps/web: `TASK_PHOTO_MAX_BYTES` is meant to be passed straight through as
// `downloadMedia`'s `maxBytes` (packages/core/src/channels/whatsapp-media.ts),
// so a single constant bounds both. downloadMedia's own 16 MiB default is
// Meta's cap for media in general — audio, video, documents — and stays where
// it is; it is the wrong number for a photo we intend to keep.
//
// These constants are the INNERMOST of three statements of the same two rules.
// The Storage bucket's file_size_limit/allowed_mime_types and the CHECK
// constraints on task_photos (both in 0023_task_photos.sql) restate them, and
// those two bind even if this file is bypassed entirely. Change a value here
// and you MUST write a migration; nothing in CI will notice if you do not.
//
// Deliberately dependency-free. The completion sheet is a client component and
// imports this for its pre-flight check, so anything imported here lands in the
// browser bundle.

export const TASK_PHOTO_BUCKET = 'task-photos';

/**
 * 5 MiB. Matches Meta's own cap for an inbound WhatsApp image, which is what
 * makes it the right ceiling for both intake paths rather than a number picked
 * for the browser's convenience.
 */
export const TASK_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * No HEIC, and that is not an oversight: iOS hands HEIC to a file input, but
 * the browser re-encodes to JPEG on the way out (see downscaleToJpeg in the
 * completion sheet), so nothing that reaches Storage is ever HEIC. Widening
 * this list to accept it would mean storing images that most desktop browsers
 * cannot display.
 */
export const TASK_PHOTO_MIME_ALLOWLIST = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type TaskPhotoMime = (typeof TASK_PHOTO_MIME_ALLOWLIST)[number];

/**
 * How many photos one completion may attach. Not a safety limit — it is what
 * keeps a batch inside the Server Action body limit (see
 * `experimental.serverActions.bodySizeLimit` in apps/web/next.config.ts) and
 * keeps an upload finishing on site 4G.
 */
export const TASK_PHOTO_MAX_PER_UPLOAD = 6;

/**
 * The cap on a whole BATCH, not on one file — and unlike TASK_PHOTO_MAX_BYTES
 * this one is not about photos at all. It exists because the manager's batch
 * travels as a single Server Action request body, capped by
 * `experimental.serverActions.bodySizeLimit` in apps/web/next.config.ts (4 MB,
 * itself under Vercel's 4.5 MB request ceiling). 3.5 MiB leaves room for the
 * multipart boundaries and part headers that ride along.
 *
 * Normally slack: the sheet re-encodes each photo to ~200–500 KB before it
 * counts. It bites on the fallback path, where a browser could not decode an
 * image and the original goes up untouched — and there it turns an opaque
 * "request entity too large" (which Next rejects before the action ever runs,
 * so no server code can produce a good message) into a sentence the manager
 * can act on.
 *
 * Raise bodySizeLimit and this together, or neither.
 */
export const TASK_PHOTO_MAX_BATCH_BYTES = Math.floor(3.5 * 1024 * 1024);

export function isTaskPhotoMime(mime: string): mime is TaskPhotoMime {
  return (TASK_PHOTO_MIME_ALLOWLIST as readonly string[]).includes(mime);
}

const EXTENSIONS: Record<TaskPhotoMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function taskPhotoExtension(mime: TaskPhotoMime): string {
  return EXTENSIONS[mime];
}

/**
 * `{company_id}/{task_id}/{uuid}.{ext}` — the convention the storage.objects
 * policies read as a tenant boundary (they compare segment 1 against
 * private.current_company_id()) and the task_photos_path_scoped CHECK
 * re-derives. Build every key through here; a hand-rolled path that puts the
 * segments in another order is not merely untidy, it is unreadable to its
 * owner and unwritable in the first place.
 *
 * `id` is supplied by the caller rather than generated here so this stays a
 * pure function — the browser passes crypto.randomUUID(), the WhatsApp path
 * will pass the media id or its own uuid.
 */
export function taskPhotoPath(companyId: string, taskId: string, id: string, mime: TaskPhotoMime): string {
  return `${companyId}/${taskId}/${id}.${taskPhotoExtension(mime)}`;
}

/**
 * Server-side gate. Returns null when the file is acceptable, or a short
 * machine-readable reason the caller turns into copy in the manager's own
 * language — this module holds no user-facing strings, because @capo/core is
 * not where UI copy lives (see the i18n split in AGENTS.md).
 */
export type TaskPhotoRejection = 'mime' | 'too_large' | 'empty';

export function checkTaskPhoto(mime: string, byteSize: number): TaskPhotoRejection | null {
  if (!isTaskPhotoMime(mime)) return 'mime';
  if (byteSize <= 0) return 'empty';
  if (byteSize > TASK_PHOTO_MAX_BYTES) return 'too_large';
  return null;
}
