import type { Metadata } from 'next';
import { Card } from '@capo/ui/card';
import { Badge } from '@capo/ui/badge';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { DAY_LINK_PARAM } from '../../lib/day-link';
import { taskDetailLines, taskHeadline, type BriefingTask } from '../notifications/briefing';
import { loadWorkerDay } from './day-data';

// THE CREW DAY PAGE (issue #114) — the only screen in Capo that a person with
// no account ever reads.
//
// ── WHY IT IS NOT UNDER (public) ───────────────────────────────────────────
// That group's layout renders LanguageSwitch, which writes the visitor's locale
// COOKIE. This page's language is not a visitor preference: it is
// `workers.language ?? companies.language`, the third dial, which the crew
// member sets by replying PT/ES/EN to their briefing. A switch here would
// either do nothing or silently disagree with every WhatsApp message they get,
// which is exactly the drift issue #55 exists to stop. So it sits at the top
// level and takes the root layout alone.
//
// ── FORCE-DYNAMIC IS LOAD-BEARING, NOT A HABIT ─────────────────────────────
// The URL carries a bearer token and the body is one crew member's live work. A
// statically rendered or cached response here would serve one person's day to
// whoever asked next. `revalidate = 0` says the same thing twice on purpose.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// A page addressed by a secret must never be indexed, and `nofollow` matters as
// much as `noindex`: the token is IN the URL, so a crawler that follows the link
// out of a scraped chat export puts it in somebody's logs.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function DiaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params[DAY_LINK_PARAM];
  // A repeated query parameter arrives as an array. Refused rather than
  // resolved to the first element: two tokens in one URL is not something a
  // message Capo sent can produce.
  const token = typeof raw === 'string' ? raw : null;

  const day = await loadWorkerDay(token);

  // ONE screen for unknown, expired, malformed and unreadable alike. Rendered
  // in the cookie/Accept-Language locale, because with no valid token there is
  // no worker whose dial we could read — the one place on this page where the
  // browser gets a say.
  if (!day) return <ExpiredNotice />;

  const t = getCatalog(day.locale).dia;

  return (
    // `lang` on the subtree rather than on <html>: the root layout stamps the
    // VISITOR's locale there and is shared with every other route. A screen
    // reader takes the nearest lang, so this is what makes a Portuguese list
    // read correctly to somebody whose browser is in Spanish.
    <main lang={day.locale} className="mx-auto flex w-full max-w-lg flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-fg">{day.name}</h1>
        <p className="text-caption text-fg-muted">{t.dateLine(formatDay(day.today, day.locale))}</p>
      </header>

      {day.today_tasks.length === 0 && day.overdue_tasks.length === 0 ? (
        <Card>
          <p className="text-body text-fg-muted">{t.nothing}</p>
        </Card>
      ) : null}

      {day.overdue_tasks.length > 0 ? (
        // OVERDUE FIRST, and this is the whole point of the page rather than a
        // layout preference: these tasks are in neither daily WhatsApp send
        // (task_board.active_today is false once a due date is behind us), so
        // for the person doing the work this is the first they hear of them.
        <Section
          heading={t.overdueHeading(day.overdue_tasks.length)}
          tasks={day.overdue_tasks}
          locale={day.locale}
          tone="danger"
        />
      ) : null}

      {day.today_tasks.length > 0 ? (
        <Section
          heading={t.todayHeading(day.today_tasks.length)}
          tasks={day.today_tasks}
          locale={day.locale}
        />
      ) : null}

      {/* No control, and the copy says where the controls are. This page cannot
          mark anything done — declaring a task finished goes through the crew
          member's own WhatsApp thread, where Capo can ask for a photo and file
          the claim against the right task. A button here would need a write
          path authorised by a token in a URL. */}
      <p className="text-caption text-fg-subtle">{t.askOnWhatsApp}</p>
    </main>
  );
}

function Section({
  heading,
  tasks,
  locale,
  tone,
}: {
  heading: string;
  tasks: BriefingTask[];
  locale: Locale;
  tone?: 'danger';
}) {
  const t = getCatalog(locale).reminders;
  return (
    <section className="flex flex-col gap-3">
      <h2 className={`text-caption font-semibold ${tone === 'danger' ? 'text-danger' : 'text-fg-muted'}`}>
        {heading}
      </h2>
      <ul className="flex flex-col gap-3">
        {tasks.map(task => {
          // THE SAME RENDERERS THE 07:00 MESSAGE USES. taskHeadline carries the
          // obra and the #44 role clause ("a ajudar Miguel"); taskDetailLines
          // carries address, description, materials and dependencies. Writing
          // fresh JSX for either would let a helper read that a job is theirs
          // here and that it is Miguel's in WhatsApp, with no way to tell which
          // was right — the same defect two fan-outs would cause.
          const lines = taskDetailLines(task, t);
          return (
            <li key={task.id}>
              <Card padding="sm">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-body font-medium text-fg">{taskHeadline(task, t)}</p>
                  {task.awaiting_review ? (
                    <Badge tone="review" reading="sentence">
                      {t.freeFormAwaitingReview}
                    </Badge>
                  ) : null}
                </div>
                {lines.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1">
                    {lines.map(line => (
                      <li key={line} className="text-caption text-fg-muted">
                        {line}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

async function ExpiredNotice() {
  const { publicCatalog } = await import('@/lib/i18n');
  const { t } = await publicCatalog();
  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold text-fg">{t.dia.expiredTitle}</h1>
      <p className="text-body text-fg-muted">{t.dia.expired}</p>
    </main>
  );
}

/**
 * The day, written out.
 *
 * `day.today` is `lisbon_today()`'s own answer — a bare `YYYY-MM-DD` with no
 * zone — so it is formatted with `timeZone: 'UTC'`. Formatting it in the
 * server's local zone would shift it a day for anybody west of Greenwich, which
 * is the same Lisbon-vs-UTC trap `pnpm activity-check` pins for the feed.
 */
function formatDay(today: string, locale: Locale): string {
  if (!today) return '';
  const meta = getCatalog(locale).meta;
  return new Intl.DateTimeFormat(meta.dateLocale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${today}T00:00:00Z`));
}
