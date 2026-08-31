'use client';

import { useState, useTransition } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { Button } from '@capo/ui/button';
import { Sheet } from '@/app/_ui/sheet';
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
// Everything else — the shared bottom Sheet, the availability labels, the
// never-filter rule — is AssigneePicker's, for AssigneePicker's reasons. See
// its header.

function Availability({ busyOn, locale }: { busyOn: number | null; locale: Locale }) {
  const t = getCatalog(locale).screens.taskDetail;
  // null is "we could not tell" and renders nothing at all. Saying "free" on a
  // guess is the one outcome this whole family of controls must not produce.
  if (busyOn === null) return null;
  if (busyOn === 0) return <span className="text-caption text-success">{t.assignFree}</span>;
  return <span className="text-caption text-warn">{t.assignBusy(busyOn)}</span>;
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

  // Escape and the focus trap come from the Sheet; this only guards against
  // dismissing while the write is in flight.
  function close() {
    if (pending) return;
    setOpen(false);
    setError(null);
  }

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
        className="-mx-1 inline-flex min-h-11 items-center rounded-chip px-1 py-1 text-left text-callout text-fg-muted underline decoration-dotted underline-offset-4 outline-none transition-colors ease-out hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50"
      >
        {t.collaboratorsTitle}
      </button>
      {error && !open && <p className="mt-1 text-caption text-danger">{error}</p>}

      <Sheet open={open} onClose={close} title={t.collaboratorsTitle}>
        <h2 className="text-heading font-semibold text-fg">{t.collaboratorsTitle}</h2>
        {/* Says out loud that the assignee is unaffected and that the
            materials are not duplicated. Both are the questions this
            feature exists to answer, and neither is obvious from a list
            of names with checkboxes. */}
        <p className="mt-1 text-caption text-fg-muted">{t.collaboratorsHint}</p>
        <p className="mt-1 text-caption text-fg-muted">
          {dateLabel ? t.assignAvailabilityOn(dateLabel) : t.assignAvailabilityUnknown}
        </p>

        {workers.length === 0 ? (
          <p className="mt-3 text-callout text-fg-muted">{t.assignNoWorkers}</p>
        ) : (
          <ul className="mt-3 divide-y divide-hairline rounded-control border border-hairline">
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
                    className="flex min-h-14 w-full items-center justify-between gap-2 p-3 text-left outline-none transition-colors ease-out hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:opacity-50"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={`inline-block h-4 w-4 shrink-0 rounded border ${
                          checked ? 'border-success bg-success' : 'border-control'
                        }`}
                      />
                      <span>
                        <span className="block text-body text-fg">{w.name}</span>
                        {w.trade && <span className="block text-caption text-fg-muted">{w.trade}</span>}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <Availability busyOn={w.busyOn} locale={locale} />
                      {isLead && (
                        <span className="block text-caption text-fg-muted">{t.collaboratorsLead}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {error && <p className="mt-2 text-caption text-danger">{error}</p>}

        <div className="mt-4 space-y-2">
          <Button variant="secondary" fullWidth disabled={pending} onClick={save}>
            {t.collaboratorsSave}
          </Button>
          <Button variant="tertiary" fullWidth disabled={pending} onClick={close}>
            {t.assignCancel}
          </Button>
        </div>
      </Sheet>
    </>
  );
}
