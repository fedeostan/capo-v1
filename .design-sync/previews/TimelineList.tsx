import { TimelineList, type TimelineTask } from '@capo/ui';

const task = (t: Partial<TimelineTask> & Pick<TimelineTask, 'id' | 'title' | 'start_date'>): TimelineTask => ({
  status: 'pending', due_date: t.start_date, duration_days: 1, materials: null,
  assignee_name: null, depends_on_titles: [], ...t,
});

/** A plan laid out day by day — the agenda view of the same work. */
export function TheWeekAhead() {
  return (
    <TimelineList
      locale="pt-PT" empty="Nada planeado."
      tasks={[
        task({ id: '1', title: 'Betonilha do piso térreo', start_date: '2026-08-24', duration_days: 2, assignee_name: 'Miguel' }),
        task({ id: '2', title: 'Assentar azulejos', start_date: '2026-08-26', due_date: '2026-08-27', assignee_name: 'Zé', depends_on_titles: ['Betonilha do piso térreo'] }),
        task({ id: '3', title: 'Selar juntas', start_date: '2026-08-28', assignee_name: 'Zé', depends_on_titles: ['Assentar azulejos'] }),
      ]}
    />
  );
}

/** Materials attached to the day they are needed, not the day they are bought. */
export function WithMaterials() {
  return (
    <TimelineList
      locale="pt-PT" empty="Nada planeado."
      tasks={[
        task({ id: '1', title: 'Pintar tecto do quarto', start_date: '2026-08-24', assignee_name: 'Miguel',
               materials: ['Tinta branca 15L', 'Rolo de pintura', 'Fita de pintor'] }),
        task({ id: '2', title: 'Montar rodapé', start_date: '2026-08-25', assignee_name: 'João',
               materials: ['Rodapé 8cm', 'Cola de montagem'], status: 'in_progress' }),
      ]}
    />
  );
}

/** Nothing scheduled. */
export function Empty() {
  return <TimelineList locale="pt-PT" empty="Ainda não há nada planeado." tasks={[]} />;
}
