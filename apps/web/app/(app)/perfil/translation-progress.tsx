'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

// The one JS-dependent piece of the language feature, and it is deliberately
// only a DRIVER, not the mechanism: a batch also completes without this
// component ever mounting (the proposals route kicks it via after(), and any
// later POST to the run route resumes it). With JS off, the manager sees the
// same progress numbers a page reload later.
//
// Takes `locale` rather than a catalog because catalog values are functions,
// and functions cannot cross the RSC server→client boundary.

type Status = {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'reverted';
  done: number;
  total: number;
};

export function TranslationProgress({
  batchId,
  initialDone,
  initialTotal,
  initialStatus,
  locale,
}: {
  batchId: string;
  initialDone: number;
  initialTotal: number;
  initialStatus: Status['status'];
  locale: Locale;
}) {
  const t = getCatalog(locale).settings;
  const router = useRouter();
  const [state, setState] = useState<Status>({ status: initialStatus, done: initialDone, total: initialTotal });
  // Bumping this is what restarts the run loop — the effect keys off it. A
  // router.refresh() alone would not, since its deps would be unchanged.
  const [attempt, setAttempt] = useState(0);
  // React 19 StrictMode mounts effects twice in dev; without this the second
  // mount starts a parallel run loop against the same batch.
  const startedAttempt = useRef(-1);

  useEffect(() => {
    if (startedAttempt.current === attempt) return;
    startedAttempt.current = attempt;
    let cancelled = false;

    (async () => {
      for (;;) {
        let next: Status;
        try {
          const res = await fetch(`/api/translation/${batchId}/run`, { method: 'POST' });
          if (!res.ok) throw new Error(String(res.status));
          next = (await res.json()) as Status;
        } catch {
          // Network blip or a killed function. Leave the last known numbers on
          // screen; the batch row is still the source of truth and a reload
          // picks it back up.
          if (!cancelled) setState(s => ({ ...s, status: 'failed' }));
          return;
        }
        if (cancelled) return;
        setState(next);
        if (next.status !== 'running' && next.status !== 'pending') {
          // Pull the freshly translated titles into the rest of the page.
          router.refresh();
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [batchId, router, attempt]);

  if (state.status === 'completed') {
    return <p className="text-caption text-success">{t.translationDone(state.done)}</p>;
  }

  const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;

  return (
    <div className="space-y-2">
      <p className="text-caption text-fg-muted">
        {state.status === 'failed' ? t.translationFailed : t.translationRunning({ done: state.done, total: state.total })}
      </p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      {state.status === 'failed' && (
        <button
          type="button"
          onClick={() => {
            // Resume is the same call as start — runTranslationBatch simply
            // picks up whatever items are still pending.
            setState(s => ({ ...s, status: 'running' }));
            setAttempt(a => a + 1);
          }}
          className="text-caption font-medium text-brand underline"
        >
          {t.translationResume}
        </button>
      )}
    </div>
  );
}
