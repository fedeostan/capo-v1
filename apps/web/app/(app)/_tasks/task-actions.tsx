'use client';

import { useState, useTransition } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { reopenTask, requestReview } from './actions';
import CompletionSheet from './completion-sheet';

export default function TaskActions({
  taskId,
  status,
  locale,
  allowRequestReview,
}: {
  taskId: string;
  status: string;
  // A plain string, not a catalog: the catalog holds functions, which cannot
  // cross the server→client boundary.
  locale: Locale;
  /** Show "Pedir controlo" beside Concluir. On the detail screen only —
   *  the board row has no space and this is a deliberate, not a routine, act. */
  allowRequestReview?: boolean;
}) {
  const catalog = getCatalog(locale);
  const t = catalog.screens.taskActions;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // "Concluir" no longer completes; it asks for proof first. The sheet owns
  // both outcomes (with photos, and the "sem fotos" escape) so this component
  // keeps exactly one job: deciding which controls a task's status earns.
  const [sheetOpen, setSheetOpen] = useState(false);

  function run(action: (id: string) => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await action(taskId);
      } catch (e) {
        setError(e instanceof Error ? e.message : t.failed);
      }
    });
  }

  if (status === 'cancelled') return null;

  // pending_review has its own control (ReviewActions, rendered full-width
  // below the row). Offering "Concluir" here as well would let the manager
  // close the task while leaving the review row stranded at 'pending'.
  if (status === 'pending_review') return null;

  if (status === 'done') {
    return (
      <button
        type="button"
        disabled={pending}
        onClick={() => run(reopenTask)}
        className="shrink-0 rounded-lg border border-zinc-500/30 px-2 py-1 text-xs hover:bg-zinc-500/10 disabled:opacity-50"
      >
        {t.reopen}
      </button>
    );
  }

  return (
    <span className="inline-flex flex-col items-end">
      {allowRequestReview && (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(requestReview)}
          className="mb-1 shrink-0 rounded-lg border border-violet-600/40 px-2 py-1 text-xs text-violet-700 hover:bg-violet-600/10 disabled:opacity-50"
        >
          {catalog.screens.taskReview.request}
        </button>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() => setSheetOpen(true)}
        className="shrink-0 rounded-lg bg-emerald-600 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {t.complete}
      </button>
      {error && <span className="mt-1 text-[11px] text-red-600">{error}</span>}
      {sheetOpen && (
        <CompletionSheet taskId={taskId} locale={locale} onClose={() => setSheetOpen(false)} />
      )}
    </span>
  );
}
