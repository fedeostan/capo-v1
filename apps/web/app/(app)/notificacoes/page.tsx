import type { Metadata } from 'next';
import Link from 'next/link';
import type { Catalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { whenLabel } from '@/lib/worker-request';
import { EmptyState } from '@capo/ui/dashboard-ui';
import { AppBar } from '@/app/_ui/nav';
import { loadInbox, type InboxItem } from '@/app/notifications/inbox';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { vapidPublicKey } from '@/lib/push';
import PullToRefresh from '@/app/pull-to-refresh';
import MarkAllRead from './mark-all-read';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.notifications.title) };
}

// Europe/Lisbon, not the reader's device clock. Same rule as everything else
// that shows a time in this app: one clock, so a notification stamped 07:02
// means the same thing as the 07:00 briefing it is sitting next to. Only the
// FORMATTING follows the reader's locale.
function stamp(iso: string, t: Catalog): string {
  return new Intl.DateTimeFormat(t.meta.dateLocale, {
    timeZone: 'Europe/Lisbon',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

// The sentence. `kind` comes from the DB, whose check constraint and this
// catalog Record are meant to hold the same set — but a row written by a
// newer deploy can reach an older bundle mid-rollout, so an unknown kind
// degrades to the bare subject instead of rendering "undefined".
function headline(item: InboxItem, t: Catalog): string {
  const subject = item.title ?? t.notifications.noSubject;
  const line = t.notifications.kind[item.kind as keyof typeof t.notifications.kind];
  return line ? line(subject) : subject;
}

function Item({ item, t, locale }: { item: InboxItem; t: Catalog; locale: Locale }) {
  const unread = item.readAt === null;
  const body = (
    <>
      <div className="flex items-start gap-2">
        {/* The blue dot. aria-hidden with a text label beside it: colour
            alone is not a signal a screen reader can hear. */}
        {unread && (
          <span aria-hidden className="mt-2 h-2 w-2 shrink-0 rounded-full bg-info" />
        )}
        <div className={`min-w-0 flex-1 ${unread ? 'text-fg' : 'text-fg-muted'}`}>
          <p className="text-body">{headline(item, t)}</p>
          <p className="mt-1 text-caption text-fg-faint">
            {unread && <span className="sr-only">{t.notifications.unread} · </span>}
            {stamp(item.createdAt, t)}
            {/* Whether the claim came with proof (issue #52). The SAME two
                catalog keys the board's review control renders, so the two
                surfaces cannot say different things about one claim — and in
                the same muted tone, because "no photos attached" is a fact
                about a record and not a complaint about a person. */}
            {item.photoCount !== null && (
              <>
                {' · '}
                {item.photoCount > 0
                  ? t.screens.taskReview.proofPhotos(item.photoCount)
                  : item.photoWaived
                    ? t.screens.taskReview.proofWaived
                    : t.screens.taskReview.proofNone}
              </>
            )}
            {/* When a crew request is needed FOR (issue #152) — the whole
                ranking signal, and the one fact the headline cannot carry.
                Derived from the date and never from tone; "sem data" is shown
                as a fact rather than hidden, because Capo asked once and did
                not guess. */}
            {item.requestWhen && (
              <>
                {' · '}
                {whenLabel(item.requestWhen.kind, item.requestWhen.date, locale)}
              </>
            )}
          </p>
        </div>
      </div>
      {/* The worker's own words, quoted and attributed — never merged into
          the sentence above. Same rule as the review control, because it is
          the same class of text: task_reviews.note and, since issue #152,
          worker_requests.text — the two places worker-authored prose reaches
          the manager. A request names the person in its label as well as in
          the headline, because on that kind the quote IS the content and it
          has to be unmistakably theirs. */}
      {item.body && (
        <div className="mt-2 border-l-2 border-hairline pl-2">
          <p className="text-caption font-medium text-fg-muted">
            {item.kind === 'worker_request' && item.title
              ? t.requests.quoteLabel(item.title)
              : t.notifications.noteLabel}
          </p>
          <blockquote className="whitespace-pre-line break-words text-callout italic text-fg-muted line-clamp-6">
            “{item.body}”
          </blockquote>
        </div>
      )}
    </>
  );

  const className = `block rounded-card border p-3 ${
    unread ? 'border-info/50 bg-info-quiet' : 'border-hairline bg-surface'
  }`;

  // No link when the subject no longer resolves — a dead end reads as a bug.
  if (!item.href) return <div className={className}>{body}</div>;
  return (
    <Link
      href={item.href}
      className={`${className} no-underline transition-colors ease-out outline-none hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`}
    >
      {body}
      <span className="mt-2 inline-block text-caption text-brand underline">{t.notifications.openSubject}</span>
    </Link>
  );
}

/**
 * The inbox. Reachable from the shell strip (when something is unread) and
 * from /perfil (always) — it has no tab of its own; see the note in
 * (app)/layout.tsx for why.
 *
 * Read state is cleared two ways, and neither is "you scrolled past it":
 * resolving the review retires its notification through the 0023 trigger, and
 * this screen's one button clears the rest.
 */
export default async function NotificacoesPage() {
  const { ctx, locale, t } = await requireAuthT();
  const items = await loadInbox(ctx);
  const unread = items.filter(item => item.readAt === null).length;
  // Every preview deploy, and production until the VAPID keys are set (see
  // docs/human-todo.md §14), has push switched off entirely — the /perfil
  // card does not even render. Inviting someone to turn on alerts on a
  // screen where no card exists to receive that tap is worse than saying
  // nothing.
  const pushAvailable = vapidPublicKey() !== null;

  return (
    // A drill-down since Atividade took the tab: the inbox is what needs YOU
    // and is markable as read, while the feed is a record of the site and is
    // neither. Reached from the unread strip and from Privacidade, so it needs
    // Back — an explicit destination rather than router.back(), because
    // browser history can lead out of the app.
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col overflow-hidden">
      <AppBar
        title={t.notifications.title}
        subtitle={t.notifications.subtitle}
        backHref="/"
        backLabel={t.nav.home}
      />
      <PullToRefresh locale={locale}>
        {items.length === 0 ? (
          <EmptyState text={t.notifications.empty} />
        ) : (
          <>
            {unread > 0 && <MarkAllRead locale={locale} />}
            <div className="space-y-2">
              {items.map(item => (
                <Item key={item.id} item={item} t={t} locale={locale} />
              ))}
            </div>
          </>
        )}

        {/* Points at the opt-in without triggering anything. The permission
            prompt is one-shot, so it must stay behind a deliberate press on
            /perfil — a prompt raised from here would spend that one chance
            on someone who only came to read their notifications. Gated on
            push being configured at all: without it /perfil's card does not
            render, so this link would land on nothing. */}
        {pushAvailable && (
          <p className="mt-6 text-center text-caption text-fg-muted">
            {t.notifications.pushNudge}{' '}
            <Link href="/perfil" className="text-brand underline">
              {t.notifications.pushNudgeLink}
            </Link>
          </p>
        )}
      </PullToRefresh>
    </div>
  );
}
