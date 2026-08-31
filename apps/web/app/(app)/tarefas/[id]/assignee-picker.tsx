'use client';

import { useState, useTransition } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { Button } from '@capo/ui/button';
import { Sheet } from '@/app/_ui/sheet';
import type { AssignableWorker } from '@/app/dashboard-data';
import { assignTask } from './assign-actions';

// The assignee line on /tarefas/[id], made tappable (issue #56).
//
// Deliberately NOT a <select>. Each row has to carry a second line — the trade,
// and whether that person already has work on this task's day — and an option
// element can hold nothing but text. It is the shared bottom Sheet, for the
// same reason the completion flow portals: the app shell is overflow-hidden
// and PullToRefresh puts a transform on <main>, which would become the
// containing block for anything position:fixed rendered in place.
//
// The list is never filtered down to the free workers. A manager sometimes has
// to double-book, and a picker that hides the only person who can do the job is
// a picker they route around. Availability is a LABEL here, never a gate.

function Availability({ busyOn, locale }: { busyOn: number | null; locale: Locale }) {
  const t = getCatalog(locale).screens.taskDetail;
  // null is "we could not tell" and renders nothing at all — see the comment on
  // AssignableWorker.busyOn. Saying "free" on a guess is the one outcome this
  // whole feature must not produce.
  if (busyOn === null) return null;
  if (busyOn === 0) return <span className="text-caption text-success">{t.assignFree}</span>;
  return <span className="text-caption text-warn">{t.assignBusy(busyOn)}</span>;
}

export default function AssigneePicker({
  taskId,
  currentWorkerId,
  currentWorkerName,
  workers,
  /** The day availability was computed for, already formatted by the server —
   *  formatting it here would pull the date helpers into the client bundle. */
  dateLabel,
  locale,
}: {
  taskId: string;
  currentWorkerId: string | null;
  currentWorkerName: string | null;
  workers: AssignableWorker[];
  dateLabel: string | null;
  // A plain string, not a catalog: the catalog holds functions, which cannot
  // cross the server→client boundary.
  locale: Locale;
}) {
  const t = getCatalog(locale).screens.taskDetail;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Escape and the focus trap come from the Sheet; this only guards against
  // dismissing while the write is in flight.
  function close() {
    if (pending) return;
    setOpen(false);
    setError(null);
  }

  function choose(workerId: string | null) {
    if (workerId === currentWorkerId) {
      close();
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await assignTask(taskId, workerId);
        setOpen(false);
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : t.assignFailed);
      }
    });
  }

  // "Nobody is free" is stated out loud rather than left to be inferred from a
  // wall of amber. Only claimable when availability was actually computed:
  // with no date, every worker is `null` and the honest answer is "cannot tell".
  const known = workers.filter(w => w.busyOn !== null);
  const noneFree = known.length > 0 && known.every(w => (w.busyOn ?? 0) > 0);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={pending}
        className={`-mx-1 inline-flex min-h-11 items-center rounded-chip px-1 py-1 text-left text-callout underline decoration-dotted underline-offset-4 outline-none transition-colors ease-out hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50 ${
          currentWorkerName ? 'text-fg' : 'text-fg-muted'
        }`}
      >
        {currentWorkerName ?? t.assignUnassigned}
      </button>
      {error && !open && <p className="mt-1 text-caption text-danger">{error}</p>}

      <Sheet open={open} onClose={close} title={t.assignTitle}>
        <h2 className="text-heading font-semibold text-fg">{t.assignTitle}</h2>
        <p className="mt-1 text-caption text-fg-muted">
          {dateLabel ? t.assignAvailabilityOn(dateLabel) : t.assignAvailabilityUnknown}
        </p>

        {workers.length === 0 ? (
          <p className="mt-3 text-callout text-fg-muted">{t.assignNoWorkers}</p>
        ) : (
          <>
            {noneFree && <p className="mt-3 text-callout text-warn">{t.assignNoneFree}</p>}
            <ul className="mt-3 divide-y divide-hairline rounded-control border border-hairline">
              {workers.map(w => (
                <li key={w.id}>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => choose(w.id)}
                    aria-current={w.id === currentWorkerId ? 'true' : undefined}
                    className="flex min-h-14 w-full items-center justify-between gap-2 p-3 text-left outline-none transition-colors ease-out hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:opacity-50"
                  >
                    <span>
                      <span className="block text-body text-fg">{w.name}</span>
                      {w.trade && <span className="block text-caption text-fg-muted">{w.trade}</span>}
                    </span>
                    <span className="shrink-0 text-right">
                      <Availability busyOn={w.busyOn} locale={locale} />
                      {w.id === currentWorkerId && (
                        <span className="block text-caption text-fg-muted">{t.assignCurrent}</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {error && <p className="mt-2 text-caption text-danger">{error}</p>}

        <div className="mt-4 space-y-2">
          {currentWorkerId && (
            <Button variant="secondary" fullWidth disabled={pending} onClick={() => choose(null)}>
              {t.assignRemove}
            </Button>
          )}
          <Button variant="tertiary" fullWidth disabled={pending} onClick={close}>
            {t.assignCancel}
          </Button>
        </div>
      </Sheet>
    </>
  );
}
