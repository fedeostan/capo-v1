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
  declaredByName,
  locale,
}: {
  reviewId: string;
  note: string | null;
  /** null = the manager opened this check themselves. */
  declaredByName: string | null;
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
        {declaredByName ? t.declaredBy(declaredByName) : t.declaredByManager}
      </p>
      {note && <blockquote className="mt-0.5 text-xs italic text-zinc-600">“{note}”</blockquote>}
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
