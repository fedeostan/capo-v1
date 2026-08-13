'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import type { AssignableWorker } from '@/app/dashboard-data';
import { assignTask } from './assign-actions';

// The assignee line on /tarefas/[id], made tappable (issue #56).
//
// Deliberately NOT a <select>. Each row has to carry a second line — the trade,
// and whether that person already has work on this task's day — and an option
// element can hold nothing but text. It is the same portalled bottom sheet the
// completion flow uses, for the same reason: the app shell is overflow-hidden
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
  if (busyOn === 0) return <span className="text-[11px] text-emerald-600">{t.assignFree}</span>;
  return <span className="text-[11px] text-amber-600">{t.assignBusy(busyOn)}</span>;
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

  const close = useCallback(() => {
    if (pending) return;
    setOpen(false);
    setError(null);
  }, [pending]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

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
        className={`-mx-1 rounded-lg px-1 py-0.5 text-left text-sm underline decoration-dotted underline-offset-4 hover:bg-zinc-500/10 disabled:opacity-50 ${
          currentWorkerName ? '' : 'text-zinc-500'
        }`}
      >
        {currentWorkerName ?? t.assignUnassigned}
      </button>
      {error && !open && <p className="mt-1 text-[11px] text-red-600">{error}</p>}

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
            onClick={close}
            role="presentation"
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t.assignTitle}
              onClick={e => e.stopPropagation()}
              className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl"
            >
              <h2 className="text-sm font-semibold">{t.assignTitle}</h2>
              <p className="mt-1 text-xs text-zinc-500">
                {dateLabel ? t.assignAvailabilityOn(dateLabel) : t.assignAvailabilityUnknown}
              </p>

              {workers.length === 0 ? (
                <p className="mt-3 text-sm text-zinc-500">{t.assignNoWorkers}</p>
              ) : (
                <>
                  {noneFree && <p className="mt-3 text-sm text-amber-600">{t.assignNoneFree}</p>}
                  <ul className="mt-3 divide-y divide-zinc-500/15 rounded-xl border border-zinc-500/20">
                    {workers.map(w => (
                      <li key={w.id}>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => choose(w.id)}
                          aria-current={w.id === currentWorkerId ? 'true' : undefined}
                          className="flex w-full items-center justify-between gap-2 p-3 text-left hover:bg-zinc-500/5 disabled:opacity-50"
                        >
                          <span>
                            <span className="block text-sm">{w.name}</span>
                            {w.trade && <span className="block text-[11px] text-zinc-500">{w.trade}</span>}
                          </span>
                          <span className="shrink-0 text-right">
                            <Availability busyOn={w.busyOn} locale={locale} />
                            {w.id === currentWorkerId && (
                              <span className="block text-[11px] text-zinc-500">{t.assignCurrent}</span>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

              <div className="mt-4 space-y-2">
                {currentWorkerId && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => choose(null)}
                    className="w-full rounded-lg border border-zinc-500/30 px-3 py-2.5 text-sm hover:bg-zinc-500/10 disabled:opacity-50"
                  >
                    {t.assignRemove}
                  </button>
                )}
                <button
                  type="button"
                  disabled={pending}
                  onClick={close}
                  className="w-full px-3 py-1.5 text-xs text-zinc-500 disabled:opacity-50"
                >
                  {t.assignCancel}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
