'use client';

import { useState, useTransition } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { approveReview, dismissReview, rejectReview } from './actions';

/**
 * The control item, rendered onto the Tarefas board row of the task it is
 * about — not as a second row, because a pending_review task is already on the
 * board (task_board.is_open is a denylist) and a union would show it twice.
 *
 * The worker's note is rendered as an ATTRIBUTED QUOTE and never as UI copy.
 * It is the one place worker-authored text reaches the manager, and the
 * attribution is what keeps "cancela tudo" reading as something José typed
 * rather than something the app is telling them.
 */
export default function ReviewActions({
  reviewId,
  note,
  declaredByWorker,
  declaredByName,
  photoCount,
  photoWaived,
  locale,
}: {
  reviewId: string;
  note: string | null;
  /** true when a worker filed this claim, even if their name did not
   *  resolve. Branch the header on THIS, not on declaredByName — a worker
   *  whose name is missing must still read as a worker's claim, never as the
   *  manager's own check. */
  declaredByWorker: boolean;
  /** null when either the manager opened this check, or a worker did but
   *  their name did not resolve — see declaredByWorker. */
  declaredByName: string | null;
  /** How many photos are attached to the task (issue #52), counted at read
   *  time. Rendered as a plain FACT, never as a warning: a claim with no
   *  photo is ordinary, and the manager is about to decide whether to walk
   *  over and look. */
  photoCount: number;
  /** True when the claim was filed WITHOUT a photo on purpose (0049): the crew
   *  member was asked twice and said they could not send one, and their reason
   *  is the quote above. This is the ONE thing here rendered in the danger
   *  tone, and the exception is earned — `photoCount === 0` means "nothing has
   *  arrived yet", which is ordinary, while this means "there will not be one",
   *  which is the manager's cue to walk over and look. */
  photoWaived: boolean;
  // A plain string, not a catalog: the catalog holds functions, which cannot
  // cross the server→client boundary.
  locale: Locale;
}) {
  const t = getCatalog(locale).screens.taskReview;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: (id: string) => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await action(reviewId);
      } catch (e) {
        setError(e instanceof Error ? e.message : t.failed);
      }
    });
  }

  return (
    // relative z-10 lifts this out of the row's stretched navigation link
    // (the after:inset-0 anchor in TaskBoardList), exactly as the action
    // column does — otherwise every button here would just open the task.
    <div className="relative z-10 mt-2 rounded-lg border border-violet-600/30 bg-violet-600/5 p-2">
      <p className="text-[11px] font-medium text-violet-700">
        {declaredByWorker ? (declaredByName ? t.declaredBy(declaredByName) : t.declaredByUnknownWorker) : t.declaredByManager}
      </p>
      {note && (
        <blockquote className="mt-0.5 whitespace-pre-line break-words text-xs italic text-zinc-600 line-clamp-6">
          “{note}”
        </blockquote>
      )}
      {/* Whether the claim came with proof (issue #52). Deliberately the same
          muted zinc as the note beneath it and NOT a warning colour: "no
          photos attached" is a true statement about a record, not a complaint
          about a person. Most claims have no photo for perfectly ordinary
          reasons. The photos themselves live on the task detail screen. */}
      {/* A waived claim says so LOUDLY and everything else stays muted. The
          badge is a shape, the sentence beside it is the fact, and neither
          blames anybody: the crew member said they could not photograph the
          work and Capo took their word for it after asking twice. A photo that
          arrives later still counts, so the count wins once there is one. */}
      {photoWaived && photoCount === 0 ? (
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-red-600">
          <span className="rounded bg-red-600/10 px-1.5 py-0.5 font-semibold uppercase tracking-wide">
            {t.proofWaivedBadge}
          </span>
          {t.proofWaived}
        </p>
      ) : (
        <p className="mt-1 text-[11px] text-zinc-500">
          {photoCount > 0 ? t.proofPhotos(photoCount) : t.proofNone}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(approveReview)}
          className="rounded-lg bg-emerald-600 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {t.approve}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(rejectReview)}
          className="rounded-lg border border-red-600/40 px-2 py-1 text-xs text-red-600 hover:bg-red-600/10 disabled:opacity-50"
        >
          {t.reject}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(dismissReview)}
          className="rounded-lg border border-zinc-500/30 px-2 py-1 text-xs hover:bg-zinc-500/10 disabled:opacity-50"
        >
          {t.dismiss}
        </button>
      </div>
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
