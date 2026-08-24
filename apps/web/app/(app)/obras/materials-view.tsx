import type { AuthContext } from '@capo/db/session';
import { getCatalog } from '@capo/i18n/catalog';
import { loadDayLabel, loadMaterials, loadToday } from '@/app/dashboard-data';
import { MaterialsList, type MaterialsGroup } from '@capo/ui/dashboard-ui';
import MaterialsEditor from '@/app/(app)/_tasks/materials-editor';

// The anticipation screen, lifted whole out of /materiais when Materiais left
// the tab bar. From 00_VISION/02-solution-mvp.md: "Anticipation is the killer
// feature. 'Check tomorrow's materials today' directly kills the
// manager-as-runner pattern."
//
// Two horizons, deliberately: tomorrow is what you BUY tonight; the week is
// what you ORDER tonight, because anything with a lead time is already late by
// the time it shows up on the tomorrow list.
//
// It is a component rather than a page now because it renders BESIDE the sites
// list under one route, behind the switch on /obras. The body below is
// unchanged from the page it came from — only the shell around it moved.
export async function MaterialsView({ ctx }: { ctx: AuthContext }) {
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
    // The week section is a surplus list: a group left with nothing after the
    // tomorrow items are removed has nothing to say. Adding still happens from
    // the tomorrow section, which now carries every obra with work.
    .filter(group => group.items.length > 0);

  const te = t.screens.materialsEdit;

  // Both sections get the same two controls, so they are built once. Materials
  // hang off a TASK, never off an obra — so the "add" control is handed the
  // group's whole task list and the editor asks which one when there is more
  // than one. A material already on the list is tappable too: it knows exactly
  // which tasks carry it, so it pre-selects when that is a single task and
  // otherwise asks, same as adding.
  const groupAction = (group: MaterialsGroup) => (
    <MaterialsEditor tasks={group.tasks} label={te.add} locale={ctx.locale} />
  );
  const itemAction = (item: MaterialsGroup['items'][number]) => (
    <MaterialsEditor
      tasks={item.forTasks}
      label={item.material}
      variant="inline"
      initialTaskId={item.forTasks.length === 1 ? item.forTasks[0].id : null}
      locale={ctx.locale}
    />
  );

  return (
    <>
      <section className="space-y-3">
        <div>
          <h2 className="text-callout font-semibold">{t.screens.materials.tomorrow}</h2>
          <p className="text-caption text-fg-muted">{label ?? ''}</p>
        </div>
        <MaterialsList
          groups={tomorrow}
          empty={t.screens.materials.emptyTomorrow}
          noJobLabel={t.dashboard.noJob}
          forLabel={t.screens.materials.forTasks}
          countLabel={te.groupCount}
          emptyGroupLabel={te.groupEmpty}
          seeJobLabel={te.seeJob}
          renderGroupAction={groupAction}
          renderItem={itemAction}
        />
      </section>

      {laterOnly.length > 0 && (
        <section className="space-y-3 border-t border-hairline pt-6">
          <div>
            <h2 className="text-callout font-semibold">{t.screens.materials.week}</h2>
            <p className="text-caption text-fg-muted">{t.screens.materials.weekHint}</p>
          </div>
          <MaterialsList
            groups={laterOnly}
            empty=""
            noJobLabel={t.dashboard.noJob}
            forLabel={t.screens.materials.forTasks}
            countLabel={te.groupCount}
            seeJobLabel={te.seeJob}
            renderGroupAction={groupAction}
            renderItem={itemAction}
          />
        </section>
      )}
    </>
  );
}
