'use client';

import { useState, useTransition } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { markAllRead } from './actions';

/**
 * The one control on the inbox. A client component only because a failed
 * mark-read has to say so — a button that silently does nothing on a dropped
 * request would leave the manager tapping it forever.
 */
export default function MarkAllRead({ locale }: { locale: Locale }) {
  // A plain string, not a catalog: the catalog holds functions, which cannot
  // cross the server→client boundary.
  const t = getCatalog(locale).notifications;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="text-right">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            try {
              await markAllRead();
            } catch {
              setError(t.failed);
            }
          });
        }}
        className="rounded-lg border border-zinc-500/30 px-2 py-1 text-xs hover:bg-zinc-500/10 disabled:opacity-50"
      >
        {t.markAllRead}
      </button>
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
