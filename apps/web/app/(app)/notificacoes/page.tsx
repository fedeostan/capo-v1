import type { Metadata } from 'next';
import Link from 'next/link';
import type { Catalog } from '@capo/i18n/catalog';
import { EmptyState, ScreenShell } from '@capo/ui/dashboard-ui';
import { loadInbox, type InboxItem } from '@/app/notifications/inbox';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
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

function Item({ item, t }: { item: InboxItem; t: Catalog }) {
  const unread = item.readAt === null;
  const body = (
    <>
      <div className="flex items-start gap-2">
        {/* The blue dot. aria-hidden with a text label beside it: colour
            alone is not a signal a screen reader can hear. */}
        {unread && (
          <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-blue-600" />
        )}
        <div className={`min-w-0 flex-1 ${unread ? '' : 'text-zinc-500'}`}>
          <p className="text-sm">{headline(item, t)}</p>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            {unread && <span className="sr-only">{t.notifications.unread} · </span>}
            {stamp(item.createdAt, t)}
          </p>
        </div>
      </div>
      {/* The worker's own words, quoted and attributed — never merged into
          the sentence above. Same rule as the review control, because it is
          the same text: task_reviews.note, the one place worker-authored
          text reaches the manager. */}
      {item.body && (
        <div className="mt-2 border-l-2 border-zinc-500/30 pl-2">
          <p className="text-[11px] font-medium text-zinc-500">{t.notifications.noteLabel}</p>
          <blockquote className="whitespace-pre-line break-words text-xs italic text-zinc-600 line-clamp-6 dark:text-zinc-400">
            “{item.body}”
          </blockquote>
        </div>
      )}
    </>
  );

  const className = `block rounded-xl border p-3 ${
    unread ? 'border-blue-600/30 bg-blue-600/5' : 'border-zinc-500/20'
  }`;

  // No link when the subject no longer resolves — a dead end reads as a bug.
  if (!item.href) return <div className={className}>{body}</div>;
  return (
    <Link href={item.href} className={`${className} hover:bg-zinc-500/5`}>
      {body}
      <span className="mt-2 inline-block text-xs text-orange-600 underline">{t.notifications.openSubject}</span>
    </Link>
  );
}

/**
 * The inbox. Reachable from the shell strip (when something is unread) and
 * from /perfil (always) — it has no tab of its own; see the note in
 * (app)/layout.tsx for why.
 *
 * Read state is cleared two ways, and neither is "you scrolled past it":
 * resolving the review retires its notification through the 0022 trigger, and
 * this screen's one button clears the rest.
 */
export default async function NotificacoesPage() {
  const { ctx, locale, t } = await requireAuthT();
  const items = await loadInbox(ctx);
  const unread = items.filter(item => item.readAt === null).length;

  return (
    <ScreenShell title={t.notifications.title} subtitle={t.notifications.subtitle}>
      <PullToRefresh locale={locale}>
        {items.length === 0 ? (
          <EmptyState text={t.notifications.empty} />
        ) : (
          <>
            {unread > 0 && <MarkAllRead locale={locale} />}
            <div className="space-y-2">
              {items.map(item => (
                <Item key={item.id} item={item} t={t} />
              ))}
            </div>
          </>
        )}
      </PullToRefresh>
    </ScreenShell>
  );
}
