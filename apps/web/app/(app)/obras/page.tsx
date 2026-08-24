import type { Metadata } from 'next';
import Link from 'next/link';
import { loadObras, loadOverdueByObra } from '@/app/dashboard-data';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { ObrasList, ScreenShell } from '@capo/ui/dashboard-ui';
import PullToRefresh from '@/app/pull-to-refresh';
import { MaterialsView } from './materials-view';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.screens.jobs.title) };
}

// Obras now holds TWO views, because Materiais left the tab bar.
//
// A SWITCH RATHER THAN A LINK, and the difference is discoverability rather
// than taps — both cost one. Materiais was a tab yesterday, so the word was
// visible without any action. A link inside the scroller demotes it twice: one
// tap, and the word vanishing until you scroll to wherever it sits. A switch
// demotes it once. That matters more here than it usually would, because the
// buy-list is consulted BEFORE leaving for the supplier — the moment the
// manager is already thinking about something else and needs reminding it
// exists at all.
//
// The objection, recorded because it is real: a switch implies Materiais is a
// filtered view of the sites list, and it is not — it is a different question
// (what to buy, by day) about the same work. Judged the smaller cost, and
// trivially reversible if Materiais is ever promoted back to a tab.
//
// The view is a SEARCH PARAM rather than client state, so it survives a
// refresh, can be bookmarked or added to a home screen, and needs no
// JavaScript to change.
export default async function ObrasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ctx, locale, t } = await requireAuthT();
  const raw = (await searchParams).vista;
  // Anything that is not exactly 'materiais' is the sites list. An unknown
  // value has to land somewhere real rather than render an empty screen.
  const view = (Array.isArray(raw) ? raw[0] : raw) === 'materiais' ? 'materiais' : 'obras';

  const [obras, overdueByObra] = view === 'obras'
    ? await Promise.all([loadObras(ctx), loadOverdueByObra(ctx)])
    : [[], {}];

  return (
    <ScreenShell
      title={view === 'obras' ? t.screens.jobs.title : t.screens.materials.title}
      subtitle={view === 'obras' ? t.screens.jobs.subtitle : t.screens.materials.subtitle}
    >
      {/* Links, not SegmentedControl. That component is a radio group built for
          SAVING a value — its `value` prop sets the initial selection only. This
          navigates, so <a> is the honest element and it works with no
          JavaScript by construction. */}
      <div role="tablist" className="mx-4 mt-3 grid shrink-0 grid-cols-2 gap-1 rounded-full bg-surface-sunken p-1">
        {(['obras', 'materiais'] as const).map(v => (
          <Link
            key={v}
            href={v === 'obras' ? '/obras' : '/obras?vista=materiais'}
            role="tab"
            aria-selected={view === v}
            className={`flex min-h-10 items-center justify-center rounded-full text-body no-underline transition-colors ease-out outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
              view === v ? 'bg-surface font-semibold text-fg shadow-float' : 'font-medium text-fg-muted'
            }`}
          >
            {v === 'obras' ? t.nav.jobs : t.nav.materials}
          </Link>
        ))}
      </div>

      <PullToRefresh locale={locale}>
        {view === 'obras' ? (
          <ObrasList obras={obras} empty={t.screens.jobs.empty} locale={locale} overdueByObra={overdueByObra} />
        ) : (
          <MaterialsView ctx={ctx} />
        )}
      </PullToRefresh>
    </ScreenShell>
  );
}
