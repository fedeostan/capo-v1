import type { Metadata } from 'next';
import { Badge } from '@capo/ui/badge';
import { Card } from '@capo/ui/card';
import type { Catalog } from '@capo/i18n/catalog';
import { ButtonLink, ListRow } from '@/app/_ui/nav';
import { loadHome, type CrewCheckin, type HomeData } from './home-data';
import { activitySentence, activityTime } from '@/app/activity/render';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { TabScreen } from '@/app/_ui/tab-screen';
import PullToRefresh from '@/app/pull-to-refresh';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.nav.home) };
}

// A section: a heading, an optional right-aligned link, then the card.
function Section({
  title,
  link,
  children,
}: {
  title: string;
  link?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h2 className="text-callout font-semibold text-fg">{title}</h2>
        {link && (
          <Link href={link.href} className="shrink-0 text-caption font-medium text-brand no-underline">
            {link.label}
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

// Lisbon, not the device clock — the same rule as every other time in the app.
// The greeting has to agree with the 07:00 briefing about what "morning" is.
function greeting(name: string | null, t: Catalog): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', hour: '2-digit', hour12: false }).format(
      new Date(),
    ),
  );
  const first = name?.trim().split(/\s+/)[0] ?? '';
  if (hour < 12) return t.home.greetingMorning(first);
  if (hour < 19) return t.home.greetingAfternoon(first);
  return t.home.greetingEvening(first);
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(p => p[0]!.toUpperCase())
    .join('');
}

// The crew strip. A circle per active crew member, amber for anyone who has
// not answered today's check-in — which is the whole reason the widget exists,
// so the silent ones must be the ones that stand out.
function CrewStrip({ crew, t }: { crew: CrewCheckin[]; t: Catalog }) {
  const answered = crew.filter(c => c.answer !== null).length;
  const silent = crew.length - answered;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-callout font-semibold text-fg">{t.home.checkedIn(answered, crew.length)}</span>
        {silent > 0 && <Badge tone="warn">{t.home.silent(silent)}</Badge>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {crew.map(person => (
          <span
            key={person.workerId}
            // The name is on the circle for a screen reader and on hover for a
            // mouse; two initials alone are not identification.
            title={person.name}
            aria-label={person.name}
            className={`grid h-9 w-9 place-items-center rounded-full text-micro font-semibold ${
              person.answer === null ? 'bg-warn-quiet text-warn' : 'bg-surface-sunken text-fg-muted'
            }`}
          >
            {initials(person.name)}
          </span>
        ))}
      </div>
    </Card>
  );
}

// The one decision Home puts a button on.
//
// TWO BUTTONS AND NEITHER IS "APPROVE". The handoff drew a "Confirm" primary
// straight on the card, and that is exactly the write this product refuses to
// make casually: approving a completion claim is a manager verifying work, it
// goes through resolve_task_review() in one transaction, and it is the kind of
// thing the confirm-posture setting exists to slow down. So Home LINKS to the
// task, where the real review control lives with the photos beside it. A
// launchpad's job is to point, not to decide.
function DecisionCard({ home, t }: { home: HomeData; t: Catalog }) {
  if (!home.topReview) return null;
  const { review, task } = home.topReview;
  const more = home.pendingReviewCount - 1;
  return (
    <Section title={t.home.decision}>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone="review">{t.dashboard.taskStatus.pending_review}</Badge>
          <span className="text-micro text-fg-faint">
            {activityTime(review.declaredAt, t)}
            {more > 0 && ` · ${t.home.decisionMore(more)}`}
          </span>
        </div>
        <p className="mt-2 text-body text-fg" style={{ textWrap: 'pretty' }}>
          {review.declaredByName
            ? t.activity.claimed(task?.title ?? t.notifications.noSubject, review.declaredByName)
            : t.activity.claimedAnon(task?.title ?? t.notifications.noSubject)}
        </p>
        {/* The worker's own words, attributed as a quote — never rendered as
            UI copy. Same rule the inbox follows. */}
        {review.note && (
          <p className="mt-2 border-l-2 border-hairline pl-3 text-callout text-fg-muted italic">
            “{review.note}”
          </p>
        )}
        <div className="mt-3">
          <ButtonLink href={task ? `/tarefas/${task.id}` : '/tarefas'} variant="secondary">
            {t.home.openTask}
          </ButtonLink>
        </div>
      </Card>
    </Section>
  );
}

// Home. A launchpad rather than a list: every widget is a summary that hands
// off to the screen that owns it, and NONE of them re-derives anything — see
// home-data.ts for why that is the whole design.
export default async function HomePage() {
  const { ctx, locale, t } = await requireAuthT();
  const home = await loadHome(ctx);

  return (
    <TabScreen
      title={greeting(ctx.fullName, t)}
      subtitle={t.home.summary(home.activeSiteCount, home.openTaskCount)}
    >
      <PullToRefresh locale={locale}>
        <div className="flex flex-col gap-6">
          <Section title={t.home.nextUp} link={{ href: '/tarefas', label: t.home.allTasks }}>
            {home.todayTasks.length === 0 ? (
              <Card>
                <p className="text-callout text-fg-muted">{t.home.nothingToday}</p>
              </Card>
            ) : (
              <Card padding="none">
                {home.todayTasks.map(task => (
                  <ListRow
                    key={task.id}
                    href={`/tarefas/${task.id}`}
                    title={task.title}
                    meta={[task.job_name ?? t.dashboard.noJob, task.worker_name ?? t.dashboard.noAssignee]
                      .filter(Boolean)
                      .join(' · ')}
                    // The board's own overdue flag, not a date compared here.
                    danger={task.overdue}
                  />
                ))}
              </Card>
            )}
          </Section>

          <DecisionCard home={home} t={t} />

          {home.recent.length > 0 && (
            <Section title={t.home.whatHappened} link={{ href: '/atividade', label: t.home.seeActivity }}>
              <Card>
                <div className="flex flex-col">
                  {home.recent.map((event, i) => (
                    <div
                      key={event.id}
                      className={`flex gap-3 py-2 ${i > 0 ? 'border-t border-hairline' : ''}`}
                    >
                      <span className="w-10 shrink-0 pt-px text-micro tabular-nums text-fg-faint">
                        {activityTime(event.at, t)}
                      </span>
                      <span className="min-w-0 flex-1 text-callout text-fg">
                        {activitySentence(event, t)}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            </Section>
          )}

          {home.crew.length > 0 && (
            <Section title={t.home.crew}>
              <CrewStrip crew={home.crew} t={t} />
            </Section>
          )}

          {home.materials.length > 0 && (
            <Section
              title={t.home.materialsLow}
              link={{ href: '/obras?vista=materiais', label: t.home.allMaterials }}
            >
              <Card padding="none">
                {home.materials.map(group => (
                  <ListRow
                    key={group.obraName}
                    href="/obras?vista=materiais"
                    title={group.items.map(i => i.material).join(', ')}
                    meta={group.obraName}
                  />
                ))}
              </Card>
            </Section>
          )}
        </div>
      </PullToRefresh>
    </TabScreen>
  );
}
