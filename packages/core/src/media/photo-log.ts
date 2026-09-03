// One log line for every way a crew photo can fail to be kept.
//
// It exists because of a blind spot rather than a preference. Before 0047,
// `storeWorkerTaskPhoto` swallowed a failed mime check, a Storage upload error,
// a `task_photos` insert error and any thrown exception into the SAME `null`
// return, with no logging of its own. One of its two callers logged the null;
// the other (`declare_task_done`) logged nothing at all. So a systemic Storage
// failure on the agent path produced zero `task_photos` rows and zero events:
// invisible to any log-based monitoring and indistinguishable from a quiet day.
// The crew member, meanwhile, was told "send it again" every time.
//
// The `stage` field is the whole point. "The photo was not kept" is not
// actionable; "the upload was refused" and "the row was rejected" are different
// problems with different fixes, and the difference is free to record.
//
// @capo/core cannot import apps/web's logEvent, so this emits the same one-line
// JSON shape by hand, exactly as agent/usage.ts does for `ai_usage.write_failed`
// and for the same reason.

/** Where in the pipeline the photo was lost. */
export type PhotoStoreStage =
  /** Refused by checkTaskPhoto: wrong mime, empty, or over the 5 MiB cap. */
  | 'check'
  /** The Storage upload was refused. A missing bucket looks like this. */
  | 'upload'
  /** The `task_photos` or `worker_photo_inbox` insert was rejected. 42P01 while a migration is unapplied looks like this. */
  | 'row'
  /** Moving a staged object into its task folder was refused. */
  | 'move'
  /** The photo IS attached; only the inbox row's bookkeeping failed. */
  | 'stamp'
  /** Reading the inbox failed. */
  | 'read'
  /**
   * The photo IS attached and recorded; only `tasks.completion_proof` failed.
   *
   * The least damaging stage in this union and the one that hid the longest.
   * `markTaskProofPhotos` wrapped its UPDATE in a try/catch and never read the
   * returned `error`, and supabase-js reports a refused statement as a VALUE
   * rather than by throwing, so that catch could not fire and the function
   * reported success on every PostgREST refusal it ever had.
   */
  | 'proof'
  /** Something threw. */
  | 'exception';

export interface PhotoStoreFailure {
  stage: PhotoStoreStage;
  companyId: string;
  workerId?: string;
  taskId?: string;
  photoId?: string;
  error?: string;
}

/**
 * Never throws, never awaits. Every call site is inside a path where a failed
 * photo must cost the photo and nothing else.
 */
export function logPhotoStoreFailure(failure: PhotoStoreFailure): void {
  try {
    console.warn(JSON.stringify({ evt: 'task_photo.store_failed', ...failure }));
  } catch {
    // A logger that can break a WhatsApp turn is worse than no logger.
  }
}

/**
 * One photo BECAME EVIDENCE: the bytes are in the task's folder and the
 * `task_photos` row that points at them exists.
 *
 * Success is logged, and that is the point rather than noise. Every line above
 * this one records a photo being lost, so on their own they cannot tell "the
 * photo path is broken" from "the crew did not send anything today" — those two
 * produce the identical empty log, which is exactly how `task_photos` stayed
 * empty for the life of the product without anybody noticing. A run of intake
 * events (`whatsapp.worker_photo_staged`) with no `task_photo.stored` behind it
 * is the shape of the failure, and it is unreadable without this line.
 *
 * Emitted by the ONE row writer, so it fires for both writers and every caller:
 * the check-in tap, the agent's `declare_task_done`, the inbox attach and the
 * pre-0047 fallback alike.
 *
 * Carries the object key, which holds only the company and task ids. Never the
 * bytes, never a caption, never anything a crew member wrote.
 */
export function logPhotoStored(stored: {
  companyId: string;
  workerId: string;
  taskId: string;
  path: string;
  photoId?: string;
}): void {
  try {
    console.log(JSON.stringify({ evt: 'task_photo.stored', ...stored }));
  } catch {
    // A logger that can break a WhatsApp turn is worse than no logger.
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
