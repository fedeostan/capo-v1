'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import type { AssignableWorker } from '@/app/dashboard-data';
import { setCollaborators } from './assign-actions';

// "Who else is on this task" on /tarefas/[id] (issue #44).
//
// The sibling of AssigneePicker, and deliberately a different shape in the two
// ways that matter:
//
//   * it is a MULTI-select with an explicit save, not tap-and-close. The
//     underlying write replaces the whole set in one transaction (0035's
//     set_task_collaborators), so the sheet has to let the manager assemble the
//     whole set before anything is sent. Saving on every tap would fire N
//     writes and brief the wrong people if one of them failed.
//   * the ASSIGNEE is listed but not tappable. Hiding them would read as a bug
//     ("where is Miguel?"), and allowing them would mean somebody helping
//     themselves — which the database drops anyway, silently, leaving a sheet
//     that appears to have accepted a choice it did not.
//
// Everything else — the portalled bottom sheet, the availability labels, the
// never-filter rule — is AssigneePicker's, for AssigneePicker's reasons. See
// its header.

function Availability({ busyOn, locale }: { busyOn: number | null; locale: Locale }) {
  const t = getCatalog(locale).screens.taskDetail;
  // null is "we could not tell" and renders nothing at all. Saying "free" on a
  // guess is the one outcome this whole family of controls must not produce.
  if (busyOn === null) return null;
  if (busyOn === 0) return <span className="text-[11px] text-emerald-600">{t.assignFree}</span>;
  return <span className="text-[11px] text-amber-600">{t.assignBusy(busyOn)}</span>;
}

export default function CollaboratorsPicker({
  taskId,
  leadWorkerId,
  currentIds,
  workers,
  dateLabel,
  locale,
}: {
  taskId: string;
  /** `tasks.assignee_worker_id` — the person in charge, shown and locked. */
  leadWorkerId: string | null;
  /** Who is helping right now. The sheet opens on this and edits a copy. */
  currentIds: string[];
  workers: AssignableWorker[];
  /** Already formatted by the server; formatting here would pull the date
   *  helpers into the client bundle. */
  dateLabel: string | null;
  // A plain string, not a catalog: the catalog holds functions, which cannot
  // cross the server→client boundary.
  locale: Locale;
}) {
  const t = getCatalog(locale).screens.taskDetail;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // The DRAFT. Initialised on open rather than held in sync with `currentIds`,
  // so cancelling genuinely discards — and so a server re-render mid-edit
  // cannot silently rewrite what the manager has ticked.
  const [draft, setDraft] = useState<string[]>(currentIds);

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

  function start() {
    setDraft(currentIds);
    setError(null);
    setOpen(true);
  }

  function toggle(workerId: string) {
    setDraft(prev => (prev.includes(workerId) ? prev.filter(id => id !== workerId) : [...prev, workerId]));
  }

  function save() {
    setError(null);
    startTransition(async () => {
      try {
        await setCollaborators(taskId, draft);
        setOpen(false);
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : t.collaboratorsFailed);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={start}
        disabled={pending}
        className="-mx-1 rounded-lg px-1 py-0.5 text-left text-sm text-zinc-500 underline decoration-dotted underline-offset-4 hover:bg-zinc-500/10 disabled:opacity-50"
      >
        {t.collaboratorsTitle}
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
              aria-label={t.collaboratorsTitle}
              onClick={e => e.stopPropagation()}
              className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl"
            >
              <h2 className="text-sm font-semibold">{t.collaboratorsTitle}</h2>
              {/* Says out loud that the assignee is unaffected and that the
                  materials are not duplicated. Both are the questions this
                  feature exists to answer, and neither is obvious from a list
                  of names with checkboxes. */}
              <p className="mt-1 text-xs text-zinc-500">{t.collaboratorsHint}</p>
              <p className="mt-1 text-xs text-zinc-500">
                {dateLabel ? t.assignAvailabilityOn(dateLabel) : t.assignAvailabilityUnknown}
              </p>

              {workers.length === 0 ? (
                <p className="mt-3 text-sm text-zinc-500">{t.assignNoWorkers}</p>
              ) : (
                <ul className="mt-3 divide-y divide-zinc-500/15 rounded-xl border border-zinc-500/20">
                  {workers.map(w => {
                    const isLead = w.id === leadWorkerId;
                    const checked = draft.includes(w.id);
                    return (
                      <li key={w.id}>
                        <button
                          type="button"
                          // The lead is shown for context and cannot be picked:
                          // the database drops them from the set anyway, and a
                          // control that appears to accept a choice it silently
                          // discards is worse than one that says no.
                          disabled={pending || isLead}
                          onClick={() => toggle(w.id)}
                          aria-pressed={isLead ? undefined : checked}
                          className="flex w-full items-center justify-between gap-2 p-3 text-left hover:bg-zinc-500/5 disabled:opacity-50"
                        >
                          <span className="flex items-center gap-2">
                            <span
                              aria-hidden
                              className={`inline-block h-4 w-4 shrink-0 rounded border ${
                                checked
                                  ? 'border-emerald-600 bg-emerald-600'
                                  : 'border-zinc-500/40'
                              }`}
                            />
                            <span>
                              <span className="block text-sm">{w.name}</span>
                              {w.trade && <span className="block text-[11px] text-zinc-500">{w.trade}</span>}
                            </span>
                          </span>
                          <span className="shrink-0 text-right">
                            <Availability busyOn={w.busyOn} locale={locale} />
                            {isLead && (
                              <span className="block text-[11px] text-zinc-500">{t.collaboratorsLead}</span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

              <div className="mt-4 space-y-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={save}
                  className="w-full rounded-lg border border-zinc-500/30 px-3 py-2.5 text-sm hover:bg-zinc-500/10 disabled:opacity-50"
                >
                  {t.collaboratorsSave}
                </button>
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
