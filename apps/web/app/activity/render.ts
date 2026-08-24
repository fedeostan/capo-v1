import type { Catalog } from '@capo/i18n/catalog';
import type { ActivityEvent } from './feed';

// One event → one sentence, and this is the ONLY place that mapping exists.
// The Atividade tab and Home's widget both call it, so the two surfaces
// physically cannot describe the same event differently — the failure mode
// that rule exists for is a manager reading two accounts of one thing and
// having no way to tell which is true.
//
// The subject is always the TASK TITLE, which is company data, and the verb is
// always ours. Worker names come from `workers.name`, typed by the MANAGER on
// the team screen — never from anything a crew member wrote. That boundary is
// the same one #47 draws around thread events, and for the same reason.
export function activitySentence(event: ActivityEvent, t: Catalog): string {
  const task = event.taskTitle ?? t.notifications.noSubject;
  const who = event.workerName;
  switch (event.kind) {
    case 'task_claimed':
      // Anonymous when no worker is attached — that is the manager declaring a
      // task finished himself, and "null says it is finished" is the bug this
      // branch exists to refuse.
      return who ? t.activity.claimed(task, who) : t.activity.claimedAnon(task);
    case 'task_approved':
      return t.activity.approved(task);
    case 'task_rejected':
      return t.activity.rejected(task);
    case 'photos_added':
      return t.activity.photos(event.count, task);
    case 'checkin_done':
      return who ? t.activity.checkinDone(who) : t.activity.claimedAnon(task);
    case 'checkin_not_done':
      return who ? t.activity.checkinNotDone(who) : t.activity.claimedAnon(task);
  }
}

/** Europe/Lisbon, never the reader's device clock — the same rule every other
 *  time in this app follows, so an event stamped 07:02 means the same thing as
 *  the 07:00 briefing beside it. Only the FORMATTING follows the locale. */
export function activityTime(iso: string, t: Catalog): string {
  return new Intl.DateTimeFormat(t.meta.dateLocale, {
    timeZone: 'Europe/Lisbon',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** The day heading. `todayIso` comes from lisbon_today() rather than being
 *  derived here: one clock, and this screen must agree with the board about
 *  which day it is. */
export function activityDayLabel(iso: string, todayIso: string | null, t: Catalog): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(new Date(iso));
  if (todayIso && day === todayIso) return t.activity.today;
  if (todayIso) {
    const yesterday = new Date(`${todayIso}T12:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    if (day === yesterday.toISOString().slice(0, 10)) return t.activity.yesterday;
  }
  return new Intl.DateTimeFormat(t.meta.dateLocale, {
    timeZone: 'Europe/Lisbon',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(iso));
}

/** Group into day buckets, preserving the newest-first order the loader
 *  already established. Returns an array rather than a Map so the render order
 *  is explicit instead of relying on insertion order. */
export function groupByDay(
  events: ActivityEvent[],
  todayIso: string | null,
  t: Catalog,
): { label: string; events: ActivityEvent[] }[] {
  const out: { label: string; events: ActivityEvent[] }[] = [];
  for (const event of events) {
    const label = activityDayLabel(event.at, todayIso, t);
    const last = out[out.length - 1];
    if (last && last.label === label) last.events.push(event);
    else out.push({ label, events: [event] });
  }
  return out;
}
