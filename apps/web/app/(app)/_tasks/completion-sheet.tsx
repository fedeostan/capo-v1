'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import {
  TASK_PHOTO_MAX_BATCH_BYTES,
  TASK_PHOTO_MAX_BYTES,
  TASK_PHOTO_MAX_PER_UPLOAD,
  isTaskPhotoMime,
} from '@capo/core/media/photos';
import { completeTaskWithPhotos, completeTaskWithoutPhotos } from './actions';

// The photo sheet: what "Concluir" opens now instead of completing outright.
//
// That is one extra tap on the flow a manager uses most, and the trade was
// made deliberately — a completed task with no photo is the thing this whole
// PRD exists to make visible. "Concluir sem fotos" is therefore a real,
// unhidden button, not a link in small print: the escape hatch must never feel
// like a punishment, or managers will stop using the app rather than stop
// skipping proof.

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

interface Staged {
  key: string;
  file: File;
  previewUrl: string;
}

/**
 * Re-encode through a canvas before upload. Three things this buys, all of
 * them load-bearing rather than nice-to-have:
 *
 *  1. SIZE. A modern phone camera produces 3–8 MB per shot. Six of those do
 *     not fit in a Server Action body (capped in next.config.ts, itself under
 *     Vercel's 4.5 MB request ceiling) and would not finish uploading on site
 *     4G. At 1600px/q0.82 a photo lands around 200–500 KB.
 *  2. FORMAT. iOS hands a file input HEIC, which is not in the mime allowlist
 *     and which most desktop browsers cannot display. Safari decodes it, the
 *     canvas re-encodes it, and JPEG is what leaves the device — which is why
 *     the allowlist can stay narrow.
 *  3. EXIF. The canvas drops it, so GPS coordinates from a manager's phone
 *     never reach the bucket. `imageOrientation: 'from-image'` is passed
 *     explicitly so dropping EXIF does not also mean losing the rotation flag
 *     and storing every portrait photo sideways.
 */
async function downscaleToJpeg(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob) throw new Error('canvas encode failed');

    const base = file.name.replace(/\.[^./\\]+$/, '') || 'foto';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
  } finally {
    bitmap.close();
  }
}

export default function CompletionSheet({
  taskId,
  locale,
  onClose,
}: {
  taskId: string;
  // A plain string, not a catalog: the catalog holds functions, which cannot
  // cross the server→client boundary.
  locale: Locale;
  onClose: () => void;
}) {
  const t = getCatalog(locale).screens.taskPhotos;
  const [staged, setStaged] = useState<Staged[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = pending || preparing;

  // Object URLs are a manual allocation. Revoke on unmount, and on every
  // individual removal below, or a manager who opens and closes the sheet a
  // few times leaks the decoded bitmaps for the life of the tab.
  //
  // The mirror ref exists because the cleanup has to run ONCE, at unmount,
  // with whatever is staged by then — a `[staged]` cleanup would revoke live
  // URLs on every add. Writing the ref in its own effect rather than during
  // render is what react-hooks/refs (the React Compiler lint) requires, and it
  // is also simply correct: a render can be discarded, an effect cannot.
  const stagedRef = useRef<Staged[]>([]);
  useEffect(() => {
    stagedRef.current = staged;
  }, [staged]);
  useEffect(() => () => stagedRef.current.forEach(s => URL.revokeObjectURL(s.previewUrl)), []);

  const close = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files ?? []);
    // Reset immediately: without this, picking the same file twice in a row
    // fires no change event the second time.
    event.target.value = '';
    if (chosen.length === 0) return;

    setError(null);
    setPreparing(true);
    try {
      const room = TASK_PHOTO_MAX_PER_UPLOAD - staged.length;
      if (chosen.length > room) setError(t.errors.too_many);

      const next: Staged[] = [];
      for (const original of chosen.slice(0, Math.max(0, room))) {
        let file: File;
        try {
          file = await downscaleToJpeg(original);
        } catch {
          // A format this browser cannot decode. Fall back to the original if
          // it is already something we accept — better a large upload than a
          // manager who cannot attach the photo they just took — and refuse
          // only when the original is unusable too.
          if (!isTaskPhotoMime(original.type) || original.size > TASK_PHOTO_MAX_BYTES) {
            setError(t.errors.mime);
            continue;
          }
          file = original;
        }
        if (file.size > TASK_PHOTO_MAX_BYTES) {
          setError(t.errors.too_large);
          continue;
        }
        next.push({
          key: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          previewUrl: URL.createObjectURL(file),
        });
      }
      if (next.length > 0) setStaged(current => [...current, ...next]);
    } finally {
      setPreparing(false);
    }
  }

  function remove(key: string) {
    setStaged(current => {
      const gone = current.find(s => s.key === key);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return current.filter(s => s.key !== key);
    });
  }

  function submitWithPhotos() {
    if (staged.length === 0) return;
    // The batch, not the file. Next rejects an over-sized Server Action body
    // before the action runs, so nothing on the server can turn that into a
    // message the manager understands — this is the only place it can be said
    // in words. Only reachable via the fallback path in onPick, where a photo
    // went up un-re-encoded.
    const total = staged.reduce((sum, s) => sum + s.file.size, 0);
    if (total > TASK_PHOTO_MAX_BATCH_BYTES) {
      setError(t.errors.too_large);
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const form = new FormData();
        form.set('taskId', taskId);
        for (const s of staged) form.append('photos', s.file);
        await completeTaskWithPhotos(form);
        onClose();
      } catch (e) {
        // The action already translated TaskPhotoError into the manager's
        // language; anything else is a genuine surprise and gets the generic
        // line rather than a raw Postgres string.
        setError(e instanceof Error && e.message ? e.message : t.errors.generic);
      }
    });
  }

  function submitWithoutPhotos() {
    setError(null);
    startTransition(async () => {
      try {
        await completeTaskWithoutPhotos(taskId);
        onClose();
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : t.errors.generic);
      }
    });
  }

  // No "have we mounted yet?" guard before touching document.body: this
  // component is only ever rendered once TaskActions' sheetOpen flips, and
  // that flip can only come from a click. It therefore never renders on the
  // server and never participates in hydration, so `document` is always there.
  // (A guard would also be a setState-in-effect, which the React Compiler lint
  // rejects outright.)
  //
  // Portalled to <body>, and that is NOT cosmetic. The app shell wraps every
  // screen in overflow-hidden, and PullToRefresh puts a `transform` on <main>
  // — a transformed ancestor becomes the containing block for position:fixed,
  // so a sheet rendered in place would be positioned against <main>, clipped
  // by the shell, and painted under the tab bar. The shell's own comment
  // predicted exactly this ("a future custom dropdown would need to live
  // elsewhere"). This is elsewhere.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
      onClick={close}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.sheetTitle}
        onClick={e => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl"
      >
        <h2 className="text-sm font-semibold">{t.sheetTitle}</h2>
        <p className="mt-1 text-xs text-zinc-500">{t.sheetIntro}</p>

        {staged.length > 0 && (
          <ul className="mt-3 grid grid-cols-3 gap-2">
            {staged.map(s => (
              <li key={s.key} className="relative">
                {/* Plain <img>, not next/image: the source is a blob: URL of a
                    file that exists only in this tab. The optimizer cannot
                    fetch it, and there is nothing to optimise — the browser
                    just re-encoded it. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={s.previewUrl}
                  alt=""
                  className="aspect-square w-full rounded-lg object-cover"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => remove(s.key)}
                  aria-label={t.remove}
                  className="absolute right-1 top-1 rounded-full bg-black/60 px-1.5 text-xs leading-5 text-white disabled:opacity-50"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <input
          ref={inputRef}
          type="file"
          // image/* rather than the allowlist: iOS offers HEIC either way, and
          // downscaleToJpeg is what converts it. Narrowing here would only
          // grey out the manager's own photos in the picker.
          accept="image/*"
          multiple
          className="hidden"
          onChange={onPick}
        />
        <button
          type="button"
          disabled={busy || staged.length >= TASK_PHOTO_MAX_PER_UPLOAD}
          onClick={() => inputRef.current?.click()}
          className="mt-3 w-full rounded-lg border border-dashed border-zinc-500/40 px-3 py-3 text-sm hover:bg-zinc-500/5 disabled:opacity-50"
        >
          {preparing ? t.preparing : t.addPhotos}
        </button>
        <p className="mt-1 text-[11px] text-zinc-500">
          {t.limitHint(TASK_PHOTO_MAX_PER_UPLOAD, Math.round(TASK_PHOTO_MAX_BYTES / (1024 * 1024)))}
        </p>

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

        <div className="mt-4 space-y-2">
          <button
            type="button"
            disabled={busy || staged.length === 0}
            onClick={submitWithPhotos}
            className="w-full rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {pending ? t.sending : t.confirm(staged.length)}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={submitWithoutPhotos}
            className="w-full rounded-lg border border-zinc-500/30 px-3 py-2.5 text-sm hover:bg-zinc-500/10 disabled:opacity-50"
          >
            {t.skip}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={close}
            className="w-full px-3 py-1.5 text-xs text-zinc-500 disabled:opacity-50"
          >
            {t.cancel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
