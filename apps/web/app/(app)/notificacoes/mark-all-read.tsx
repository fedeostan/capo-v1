'use client';

import { useState, useTransition } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { Button } from '@capo/ui/button';
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
      <Button
        variant="secondary"
        size="sm"
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
      >
        {t.markAllRead}
      </Button>
      {error && <p className="mt-1 text-caption text-danger">{error}</p>}
    </div>
  );
}
