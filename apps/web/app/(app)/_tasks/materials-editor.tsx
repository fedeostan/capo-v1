'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import type { MaterialsTask } from '@capo/ui/dashboard-ui';
import { setTaskMaterials } from './materials-actions';

// Adding and editing a task's materials (issue #60), from two places:
//   * /tarefas/[id] — one candidate task, so the sheet opens straight on it.
//   * /materiais    — a group covers a whole obra, which is usually several
//                     tasks, so the sheet asks WHICH task first.
//
// That question is the reason this component exists at all rather than a
// simple inline form. Materials live on `tasks.materials`; an obra has no
// material list of its own. Attaching to "the first task in the group" would
// silently put tomorrow's cement on whichever task happened to sort first, and
// nothing on the screen would show that it had.
//
// Portalled bottom sheet, like the assignee picker and the completion sheet,
// for the same mechanical reason: the app shell is overflow-hidden and
// PullToRefresh puts a transform on <main>, which would otherwise become the
// containing block for anything position:fixed rendered in place.

export default function MaterialsEditor({
  tasks,
  label,
  /** 'button' is the standalone "Add material" control on /materiais;
   *  'inline' is a material name on the list, made tappable in place. */
  variant = 'button',
  /** Pre-selects a task, skipping the chooser. Used when the manager tapped a
   *  material that belongs to exactly one task. */
  initialTaskId = null,
  locale,
}: {
  tasks: MaterialsTask[];
  label: string;
  variant?: 'button' | 'inline';
  initialTaskId?: string | null;
  // A plain string, not a catalog: the catalog holds interpolation functions,
  // which cannot cross the server→client boundary.
  locale: Locale;
}) {
  const t = getCatalog(locale).screens.materialsEdit;
  const [open, setOpen] = useState(false);
  // Which task is being edited. With a single candidate there is nothing to
  // choose, so the chooser is skipped entirely.
  const [taskId, setTaskId] = useState<string | null>(initialTaskId ?? (tasks.length === 1 ? tasks[0].id : null));
  const [draft, setDraft] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const selected = tasks.find(task => task.id === taskId) ?? null;

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
    const only = initialTaskId ?? (tasks.length === 1 ? tasks[0].id : null);
    setTaskId(only);
    // An empty trailing row so a manager who came here to ADD something has
    // somewhere to type without hunting for a button first.
    const current = tasks.find(task => task.id === only)?.materials ?? [];
    setDraft(only ? [...current, ''] : []);
    setError(null);
    setOpen(true);
  }

  function choose(task: MaterialsTask) {
    setTaskId(task.id);
    setDraft([...task.materials, '']);
    setError(null);
  }

  function save() {
    if (!taskId) return;
    setError(null);
    startTransition(async () => {
      try {
        // Empties are dropped server-side too — this is only so the manager is
        // not told "saved" about a blank line they never filled in.
        await setTaskMaterials(
          taskId,
          draft.map(value => value.trim()).filter(Boolean),
        );
        setOpen(false);
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : t.failed);
      }
    });
  }

  const trigger =
    variant === 'inline' ? (
      <button
        type="button"
        onClick={start}
        disabled={pending}
        className="-mx-1 rounded px-1 text-left text-sm font-medium underline decoration-dotted underline-offset-4 hover:bg-zinc-500/10 disabled:opacity-50"
      >
        {label}
      </button>
    ) : (
      <button
        type="button"
        onClick={start}
        disabled={pending}
        className="rounded-lg border border-zinc-500/30 px-3 py-1.5 text-xs font-medium hover:bg-zinc-500/10 disabled:opacity-50"
      >
        {label}
      </button>
    );

  return (
    <>
      {trigger}
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
              aria-label={selected ? t.title(selected.title) : t.pickTask}
              onClick={e => e.stopPropagation()}
              className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl"
            >
              {selected === null ? (
                <>
                  <h2 className="text-sm font-semibold">{t.pickTask}</h2>
                  <p className="mt-1 text-xs text-zinc-500">{t.pickTaskHint}</p>
                  {tasks.length === 0 ? (
                    <p className="mt-3 text-sm text-zinc-500">{t.noTasks}</p>
                  ) : (
                    <ul className="mt-3 divide-y divide-zinc-500/15 rounded-xl border border-zinc-500/20">
                      {tasks.map(task => (
                        <li key={task.id}>
                          <button
                            type="button"
                            onClick={() => choose(task)}
                            className="flex w-full items-center justify-between gap-2 p-3 text-left hover:bg-zinc-500/5"
                          >
                            <span className="min-w-0 text-sm">{task.title}</span>
                            <span className="shrink-0 text-[11px] text-zinc-500">
                              {t.taskCount(task.materials.length)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <>
                  <h2 className="text-sm font-semibold">{t.title(selected.title)}</h2>
                  {draft.length === 0 && <p className="mt-2 text-sm text-zinc-500">{t.empty}</p>}

                  <ul className="mt-3 space-y-2">
                    {draft.map((value, index) => (
                      // The index IS the identity here: the rows are a
                      // positional draft of one text[], two rows can legally
                      // hold the same text mid-edit, and keying on the value
                      // would make React reuse the wrong input as it is typed.
                      <li key={index} className="flex items-center gap-2">
                        <input
                          value={value}
                          onChange={e =>
                            setDraft(rows => rows.map((row, i) => (i === index ? e.target.value : row)))
                          }
                          placeholder={t.placeholder}
                          maxLength={120}
                          disabled={pending}
                          className="min-w-0 flex-1 rounded-lg border border-zinc-500/30 bg-transparent px-3 py-2 text-sm disabled:opacity-50"
                        />
                        <button
                          type="button"
                          aria-label={t.removeRow}
                          title={t.removeRow}
                          disabled={pending}
                          onClick={() => setDraft(rows => rows.filter((_, i) => i !== index))}
                          className="shrink-0 rounded-lg border border-zinc-500/30 px-2.5 py-2 text-sm text-zinc-500 hover:bg-zinc-500/10 disabled:opacity-50"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>

                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setDraft(rows => [...rows, ''])}
                    className="mt-2 rounded-lg border border-dashed border-zinc-500/40 px-3 py-2 text-xs text-zinc-500 hover:bg-zinc-500/10 disabled:opacity-50"
                  >
                    + {t.addRow}
                  </button>

                  {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

                  <div className="mt-4 space-y-2">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={save}
                      className="w-full rounded-lg bg-emerald-700 px-3 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                    >
                      {pending ? t.saving : t.save}
                    </button>
                    {/* Only offered when there was a choice to go back to. */}
                    {tasks.length > 1 && initialTaskId === null && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => setTaskId(null)}
                        className="w-full rounded-lg border border-zinc-500/30 px-3 py-2 text-xs hover:bg-zinc-500/10 disabled:opacity-50"
                      >
                        {t.back}
                      </button>
                    )}
                  </div>
                </>
              )}

              <button
                type="button"
                disabled={pending}
                onClick={close}
                className="mt-3 w-full px-3 py-1.5 text-xs text-zinc-500 disabled:opacity-50"
              >
                {t.cancel}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
