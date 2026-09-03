import { randomUUID } from 'node:crypto';
import type { Db } from '@capo/db/client';
import { downloadMedia } from '@capo/core/channels/whatsapp-media';
import { TASK_PHOTO_MAX_BYTES, isTaskPhotoMime } from '@capo/core/media/photos';
import { countInboxPhotos, stageInboxPhoto } from '@capo/core/media/photo-inbox';
import type { PendingPhoto } from '@capo/core/capabilities/worker';
import {
  photoBatchPayload,
  sendWhatsAppButtons,
  sendWhatsAppText,
  type WhatsAppSendConfig,
} from '@capo/core/channels/whatsapp';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { logEvent } from './log';

// Taking a crew member's photo in, before anything decides what it is of.
//
// ── THE BUG ────────────────────────────────────────────────────────────────
// On 3 September a crew member said "Ok is done!", Capo asked for a photo, they
// sent it twice, and then wrote "I tried 3 times now. Is not working". Every
// part behaved as designed. A bare photo with no open check-in request fell
// through to the restricted agent; the bytes were held in memory for that one
// turn; the model, which has no way to know which job an unlabelled photo shows,
// asked which task; and by the time the answer arrived the photo was gone.
//
// The download therefore moved to the FRONT of the worker branch and its result
// goes into the inbox (0047) rather than into a variable. Everything below is
// about that one move and what it makes possible.
//
// ── WHY THE DOWNLOAD HAPPENS ONCE, HERE ────────────────────────────────────
// Hop 1's media URL from the Graph API lasts about five minutes and is
// effectively single-use, so there is no retrying it later and no downloading it
// twice. Before this file the route could do exactly that: the check-in photo
// branch downloaded, and on a fall-through the agent branch downloaded again.
//
// ── PHOTOS ARE NEVER SHOWN TO A MODEL ──────────────────────────────────────
// Nothing here returns bytes to a caller. An inbound image can carry text and
// text is instructions, so a vision pass anywhere near this path would be a
// prompt-injection surface with nothing in front of it (0023, AGENTS.md).

/** The half of an inbound message this file needs. Deliberately not the whole shape. */
interface InboundImage {
  id: string;
  type: string;
  image?: { id: string; caption?: string };
}

interface PhotoWorker {
  id: string;
  company_id: string;
}

export interface StagedPhoto {
  /** The `worker_photo_inbox` row id, or null when nothing was staged. */
  photoId: string | null;
  /**
   * The downloaded bytes, whenever the download itself worked — set even when
   * `photoId` is null, and that is the point.
   *
   * ⚠ THIS IS THE PRE-0047 SAFETY NET. Staging fails whenever
   * `worker_photo_inbox` is unreachable, which is EVERY request between
   * deploying 0047 and applying it (42P01), and on this project a migration has
   * sat merged and unapplied for three weeks while the app half was live. In
   * that window the caller must fall back to what the product did before: write
   * the bytes straight to the task through `storeWorkerTaskPhoto`, or hand them
   * to the agent turn as this turn's photos. A photo the old product would have
   * kept must never be lost by the change that was meant to stop losing photos.
   *
   * Held only for the duration of this request, exactly as before 0047.
   */
  photo: PendingPhoto | null;
  /**
   * True when a photo was there and it did not reach the inbox. Read together
   * with `photo`: bytes present means "fall back", bytes absent means the
   * download itself failed and the crew member owes a sentence, because
   * somebody told nothing assumes the photo landed and stops trying.
   */
  failed: boolean;
}

/**
 * Download the image on this message and stage it in the inbox.
 *
 * `TASK_PHOTO_MAX_BYTES` rather than downloadMedia's 16 MiB default: one
 * constant bounds both intake paths (the manager's browser upload and this one)
 * and it matches Meta's own 5 MiB cap for an inbound image, which is what makes
 * it the right number rather than a convenient one.
 *
 * Never throws. A message with no image answers `{ photoId: null, failed: false }`,
 * which every caller reads as "nothing to do".
 */
export async function stageInboundPhoto(
  db: Db,
  message: InboundImage,
  worker: PhotoWorker,
  accessToken: string,
): Promise<StagedPhoto> {
  if (message.type !== 'image' || !message.image?.id) return { photoId: null, photo: null, failed: false };

  try {
    const media = await downloadMedia(message.image.id, { accessToken, maxBytes: TASK_PHOTO_MAX_BYTES });
    if (!isTaskPhotoMime(media.mediaType)) {
      // The HEIC / webp-sticker case. iOS never sends HEIC over WhatsApp itself,
      // so this is rare in practice and worth its own event when it happens.
      logEvent('whatsapp.worker_photo_rejected', {
        companyId: worker.company_id,
        workerId: worker.id,
        messageId: message.id,
        mediaType: media.mediaType,
      });
      return { photoId: null, photo: null, failed: true };
    }

    const photo: PendingPhoto = {
      // Ours, never Meta's media id: the object key is derived from it, and a
      // Graph API media id anywhere downstream is a value that could be
      // replayed against the Graph API.
      id: randomUUID(),
      mime: media.mediaType,
      bytes: media.bytes,
      byteSize: media.byteLength,
    };

    const photoId = await stageInboxPhoto(db, {
      companyId: worker.company_id,
      workerId: worker.id,
      photo,
      caption: message.image.caption,
      now: Date.now(),
    });

    if (!photoId) {
      // stageInboxPhoto has already logged task_photo.store_failed with the
      // stage it failed at, which is the detail this event cannot carry.
      // The bytes travel back with the failure. The caller writes them the
      // pre-0047 way rather than telling the crew member to send it again.
      logEvent('whatsapp.worker_photo_stage_failed', {
        companyId: worker.company_id,
        workerId: worker.id,
        messageId: message.id,
        fallback: true,
      });
      return { photoId: null, photo, failed: true };
    }

    logEvent('whatsapp.worker_photo_staged', {
      companyId: worker.company_id,
      workerId: worker.id,
      messageId: message.id,
      captioned: !!message.image.caption?.trim(),
    });
    return { photoId, photo, failed: false };
  } catch (err) {
    logEvent('whatsapp.worker_photo_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { photoId: null, photo: null, failed: true };
  }
}

/**
 * "Recebi a foto. Mais alguma ou é tudo?" — the deterministic answer to a bare
 * photo that no check-in request was waiting for.
 *
 * ZERO MODEL CALLS, which is the point. The old behaviour was a model turn that
 * asked which task the photo was of, and that question could not be answered
 * without losing the photo. This one asks the question the photo itself raises:
 * is there another one coming.
 *
 * The count is every photo of theirs still waiting, not just this one, so
 * somebody sending four in a row watches the number climb and knows all four
 * landed. That is the difference between "it worked" and "I tried 3 times now".
 *
 * FREE, and free by SHAPE: an interactive message is a session message, so Meta
 * bills nothing for it. It is also refused outright outside the 24-hour window,
 * which cannot bite here because the photo we are answering opened one a second
 * ago.
 *
 * Never throws. A failed send costs the prompt and nothing else: the photo is
 * already kept, and the next thing the crew member writes finds it waiting.
 */
export async function askAboutMorePhotos(
  db: Db,
  worker: PhotoWorker,
  locale: Locale,
  sendConfig: WhatsAppSendConfig,
): Promise<void> {
  const t = getCatalog(locale).whatsapp;
  try {
    const waiting = await countInboxPhotos(db, worker.company_id, worker.id, Date.now());
    // Nothing waiting means the staging write failed, and the crew member has
    // already been told so. A receipt for zero photos would contradict it.
    if (waiting === 0) return;

    await sendWhatsAppButtons(
      t.photoBatchAsk(waiting),
      [
        { id: photoBatchPayload('more'), title: t.photoBatchMoreButton },
        { id: photoBatchPayload('done'), title: t.photoBatchDoneButton },
      ],
      sendConfig,
    );
    logEvent('whatsapp.worker_photo_batch_asked', {
      companyId: worker.company_id,
      workerId: worker.id,
      waiting,
    });
  } catch (err) {
    // An interactive send can fail for a reason that is OURS (a malformed
    // payload, a limit we got wrong) or theirs (131047, outside the window).
    // Either way the fallback is a plain line rather than silence: silence
    // after a photo is exactly the failure this whole feature exists to end,
    // and it is the same fallback ladder deliverBriefing walks for the guided
    // list. THE SAME WORDS, so a crew member who reads it has been asked the
    // same question and can answer it by typing.
    logEvent('whatsapp.worker_photo_batch_failed', {
      companyId: worker.company_id,
      workerId: worker.id,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      const waiting = await countInboxPhotos(db, worker.company_id, worker.id, Date.now());
      if (waiting === 0) return;
      await sendWhatsAppText(t.photoBatchAsk(waiting), sendConfig);
      logEvent('whatsapp.worker_photo_batch_text_fallback', {
        companyId: worker.company_id,
        workerId: worker.id,
        waiting,
      });
    } catch {
      // 131047 refuses plain text as well, so this is where an out-of-window
      // photo genuinely ends. Nothing is lost: the photo is already staged and
      // the next thing they write finds it waiting.
    }
  }
}
