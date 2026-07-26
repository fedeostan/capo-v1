import type { Metadata } from 'next';
import { requireAuth } from '@capo/db/session';
import { getCatalog } from '@capo/i18n/catalog';
import { loadDayLabel, loadMaterials, loadToday } from '@/app/dashboard-data';
import { MaterialsList, ScreenShell } from '@capo/ui/dashboard-ui';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await requireAuth();
  const t = getCatalog(ctx.locale);
  return { title: `${t.screens.materials.title} — ${t.meta.titleSuffix}` };
}

// The anticipation screen. From 00_VISION/02-solution-mvp.md: "Anticipation is
// the killer feature. 'Check tomorrow's materials today' directly kills the
// manager-as-runner pattern." tasks.materials has existed since migration 0010
// and nothing in the product ever read it — this is that panel.
//
// Two horizons, deliberately: tomorrow is what you BUY tonight; the week is
// what you ORDER tonight, because anything with a lead time is already late by
// the time it shows up on the tomorrow list.
export default async function MateriaisPage() {
  const ctx = await requireAuth();
  const t = getCatalog(ctx.locale);

  const today = await loadToday(ctx);
  const [tomorrow, week, label] = await Promise.all([
    loadMaterials(ctx, 'amanha', today),
    loadMaterials(ctx, 'semana', today),
    loadDayLabel(ctx, 1),
  ]);

  // Anything already on the tomorrow list would only be noise in the week
  // list — the week section is about what is not yet urgent.
  const tomorrowKeys = new Set(tomorrow.flatMap(g => g.items.map(i => `${g.obraName}::${i.material}`)));
  const laterOnly = week
    .map(group => ({
      ...group,
      items: group.items.filter(item => !tomorrowKeys.has(`${group.obraName}::${item.material}`)),
    }))
    .filter(group => group.items.length > 0);

  return (
    <ScreenShell title={t.screens.materials.title} subtitle={t.screens.materials.subtitle}>
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">{t.screens.materials.tomorrow}</h2>
          <p className="text-xs text-zinc-500">{label ?? ''}</p>
        </div>
        <MaterialsList
          groups={tomorrow}
          empty={t.screens.materials.emptyTomorrow}
          noJobLabel={t.dashboard.noJob}
          forLabel={t.screens.materials.forTasks}
        />
      </section>

      {laterOnly.length > 0 && (
        <section className="space-y-3 border-t border-zinc-500/20 pt-5">
          <div>
            <h2 className="text-sm font-semibold">{t.screens.materials.week}</h2>
            <p className="text-xs text-zinc-500">{t.screens.materials.weekHint}</p>
          </div>
          <MaterialsList
            groups={laterOnly}
            empty=""
            noJobLabel={t.dashboard.noJob}
            forLabel={t.screens.materials.forTasks}
          />
        </section>
      )}
    </ScreenShell>
  );
}
