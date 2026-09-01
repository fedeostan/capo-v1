import type { AuthContext } from '@capo/db/session';
import { getCatalog } from '@capo/i18n/catalog';
import { loadDayLabel, loadMaterialChecks, loadMaterials, loadToday, materialCheckKey } from '@/app/dashboard-data';
import { MaterialsList, type MaterialsGroup } from '@capo/ui/dashboard-ui';
import MaterialsEditor from '@/app/(app)/_tasks/materials-editor';
import MaterialCheck from './material-check';

// The anticipation screen, lifted whole out of /materiais when Materiais left
// the tab bar. From 00_VISION/02-solution-mvp.md: "Anticipation is the killer
// feature. 'Check tomorrow's materials today' directly kills the
// manager-as-runner pattern."
//
// Two horizons of ANTICIPATION, deliberately: tomorrow is what you BUY
// tonight; the week is what you ORDER tonight, because anything with a lead
// time is already late by the time it shows up on the tomorrow list. Both are
// kept, in that order, beneath the third.
//
// The third horizon (issue #154) sits ABOVE them and asks a different question
// entirely. At 06:40 the manager is not asking what to buy — they are asking
// whether it is there. That is why TODAY is the only section with ticks, and
// why it is first: the buy list is consulted the night before, the walk-around
// is done as the day starts.
//
// It is a component rather than a page now because it renders BESIDE the sites
// list under one route, behind the switch on /obras.
export async function MaterialsView({ ctx }: { ctx: AuthContext }) {
  const t = getCatalog(ctx.locale);

  const today = await loadToday(ctx);
  const [todayGroups, tomorrow, week, todayLabel, label, checks] = await Promise.all([
    loadMaterials(ctx, 'hoje', today),
    loadMaterials(ctx, 'amanha', today),
    loadMaterials(ctx, 'semana', today),
    loadDayLabel(ctx, 0),
    loadDayLabel(ctx, 1),
    loadMaterialChecks(ctx, today),
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

  // The tick, on the today section only. It is keyed on the obra and the exact
  // material string — the same key loadMaterialChecks builds — so the control
  // and the row it sits on cannot come apart.
  const checkAction = (item: MaterialsGroup['items'][number], group: MaterialsGroup) => (
    <MaterialCheck
      obraId={group.obraId}
      material={item.material}
      state={checks[materialCheckKey(group.obraId, item.material)] ?? null}
      locale={ctx.locale}
    />
  );

  // A tally rather than a progress bar: this is a list of facts a person
  // gathered, not a task with a completion percentage. "Missing" counts as
  // answered and deliberately does not count as on site.
  const todayTotal = todayGroups.reduce((n, group) => n + group.items.length, 0);
  const todayOnSite = todayGroups.reduce(
    (n, group) =>
      n + group.items.filter(item => checks[materialCheckKey(group.obraId, item.material)] === 'on_site').length,
    0,
  );

  return (
    <>
      <section className="space-y-3">
        <div>
          <h2 className="text-callout font-semibold">{t.screens.materials.today}</h2>
          <p className="text-caption text-fg-muted">
            {todayLabel ?? ''}
            {todayTotal > 0 && ` · ${t.screens.materials.checkedCount(todayOnSite, todayTotal)}`}
          </p>
          <p className="mt-1 text-caption text-fg-faint">{t.screens.materials.todayHint}</p>
        </div>
        <MaterialsList
          groups={todayGroups}
          empty={t.screens.materials.emptyToday}
          noJobLabel={t.dashboard.noJob}
          forLabel={t.screens.materials.forTasks}
          countLabel={te.groupCount}
          emptyGroupLabel={te.groupEmpty}
          seeJobLabel={te.seeJob}
          renderGroupAction={groupAction}
          // The name stays tappable here too: correcting a typo in a material
          // is something a manager does exactly when they are standing in front
          // of the thing, which is now.
          renderItem={itemAction}
          renderItemAction={checkAction}
        />
      </section>

      <section className="space-y-3 border-t border-hairline pt-6">
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
