'use client';

import { useState, useTransition } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { completeTask, reopenTask } from './actions';

export default function TaskActions({
  taskId,
  status,
  locale,
}: {
  taskId: string;
  status: string;
  // A plain string, not a catalog: the catalog holds functions, which cannot
  // cross the server→client boundary.
  locale: Locale;
}) {
  const t = getCatalog(locale).screens.taskActions;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

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
      <button
        type="button"
        disabled={pending}
        onClick={() => run(completeTask)}
        className="shrink-0 rounded-lg bg-emerald-600 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {t.complete}
      </button>
      {error && <span className="mt-1 text-[11px] text-red-600">{error}</span>}
    </span>
  );
}
