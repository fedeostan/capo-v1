import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import {
  renderWorkerFreeForm,
  taskHeadline,
  type BriefingTask,
  type WorkerBriefing,
} from '../app/notifications/briefing';

// The PURE half of "your boss just gave you a new task for today" (issue W7):
// the two things a crew member actually reads, and nothing else.
//
// Here rather than beside the drain in app/notifications/task-assigned.ts for
// the same reason apps/web/lib/worker-request.ts is here: `pnpm whatsapp-check`
// can only import a module with no Db, no clock and no path aliases in it, and
// this is the only automated coverage these sentences will ever get. The drain
// keeps the database, the consent gate and the Graph API; this keeps the words.
//
// It lives in apps/web rather than @capo/core because it needs the USER copy
// catalog, which must never enter the agent bundle (AGENTS.md).

/**
 * The message a crew member reads INSIDE their own 24-hour window.
 *
 * ── ONE RENDERER, SHARED WITH THE 07:00 BRIEFING, DELIBERATELY ─────────────
 * Everything below the first line is `renderWorkerFreeForm`, unchanged: the
 * same headline, the same address, the same materials, the same "a ajudar
 * Miguel" role clause, the same /dia link. A second renderer here would
 * eventually describe a task differently from the morning message, and the crew
 * member reading both would have no way to tell which was right — the exact
 * failure `taskHeadline` and `taskDetailLines` were extracted to prevent
 * (#44, #49).
 *
 * Two things are this message's own, and only two:
 *
 *   THE OPENER, because `freeFormGreeting` says "Bom dia", which is a lie at
 *   three in the afternoon and says nothing about why a message just arrived.
 *
 *   THE MARK on the tasks that were just handed over. The whole day is sent
 *   rather than only the new task, because somebody told "you have a new task"
 *   and nothing else then has to ask what they were supposed to be doing — but
 *   a day with nothing marked would make them hunt for the change.
 */
export function renderAssignmentMessage(
  briefing: WorkerBriefing,
  newTaskIds: ReadonlySet<string>,
  options: { dayLinkUrl?: string } = {},
): string {
  const t = getCatalog(briefing.locale).reminders;
  const marked: BriefingTask[] = briefing.tasks.map(task =>
    newTaskIds.has(task.id) ? { ...task, title: t.taskNewlyAssigned(task.title) } : task,
  );
  return renderWorkerFreeForm(
    { ...briefing, tasks: marked },
    { greeting: t.assignmentGreeting(briefing.name), dayLinkUrl: options.dayLinkUrl },
  );
}

/**
 * The paid template's {{2}}: the tasks that were just assigned, and only those.
 *
 * NOT the whole day, unlike the free-form path, and that is a constraint rather
 * than a choice — a template parameter is one flat line (Meta rejects a newline
 * with 132000) and a day does not fit in one. So the template names what is new
 * and asks for a reply; the reply opens the free window, and #108's existing
 * "OK" keyword answers it with the full formatted day. One flow, reached two
 * ways.
 *
 * `toTemplateParam` is applied by the CALLER, not here, so this stays free of
 * @capo/core and the cap is applied once, at the envelope.
 */
export function renderAssignmentTemplateParam(
  tasks: readonly BriefingTask[],
  locale: Locale,
): string {
  const t = getCatalog(locale).reminders;
  return tasks.map(task => taskHeadline(task, t)).join(t.taskSeparator);
}
