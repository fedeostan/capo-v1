import type { Metadata } from 'next';
import { requireAuth } from '@capo/db/session';
import { loadDayLabel, loadMaterials } from '@/app/dashboard-data';
import { MaterialsList, ScreenShell } from '@capo/ui/dashboard-ui';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Materiais — Capo' };

// The anticipation screen. From 00_VISION/02-solution-mvp.md: "Anticipation is
// the killer feature. 'Check tomorrow's materials today' directly kills the
// manager-as-runner pattern." tasks.materials has existed since migration 0010
// and nothing ever read it — this is that panel.
//
// Two horizons, deliberately: tomorrow is what you buy tonight; the week is
// what you ORDER tonight, because anything with a lead time is already late by
// the time it shows up on the tomorrow list.
export default async function MateriaisPage() {
  const ctx = await requireAuth();
  const [tomorrow, week, label] = await Promise.all([
    loadMaterials(ctx, 'active_tomorrow'),
    loadMaterials(ctx, 'active_this_week'),
    loadDayLabel(ctx, 1),
  ]);

  // Anything already covered by the tomorrow list would only be noise in the
  // week list — the week section is about what is NOT yet urgent.
  const tomorrowKeys = new Set(tomorrow.flatMap(g => g.items.map(i => `${g.obraName}::${i.material}`)));
  const laterOnly = week
    .map(group => ({
      ...group,
      items: group.items.filter(item => !tomorrowKeys.has(`${group.obraName}::${item.material}`)),
    }))
    .filter(group => group.items.length > 0);

  return (
    <ScreenShell title="Materiais" subtitle="O que tem de estar em obra">
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Para amanhã</h2>
          <p className="text-xs text-zinc-500">{label ?? 'O trabalho de amanhã'}</p>
        </div>
        <MaterialsList
          groups={tomorrow}
          empty="Nada por confirmar para amanhã. Se houver trabalho agendado sem materiais registados, pergunta ao Capo o que falta."
        />
      </section>

      {laterOnly.length > 0 && (
        <section className="space-y-3 border-t border-zinc-500/20 pt-5">
          <div>
            <h2 className="text-sm font-semibold">Resto da semana</h2>
            <p className="text-xs text-zinc-500">Para encomendar já — o que tem prazo de entrega não espera.</p>
          </div>
          <MaterialsList groups={laterOnly} empty="" />
        </section>
      )}
    </ScreenShell>
  );
}
