import { TaskBoardList, type BoardTask } from '@capo/ui';

// Fixed dates, never Date.now(): the board takes `today` as a prop from the
// same lisbon_today() clock the rows come from, so a preview that read the
// browser clock would drift out of its own data and re-render differently
// every day.
const TODAY = '2026-08-24';

const task = (over: Partial<BoardTask> & Pick<BoardTask, 'id' | 'title'>): BoardTask => ({
  status: 'pending', description: null, duration_days: 1, materials: null,
  job_id: 'j1', job_name: 'Casa de Paco', job_status: 'active',
  worker_name: null, assignee_worker_id: null,
  start_date: TODAY, due_date: TODAY,
  active_today: true, active_tomorrow: false,
  overdue: false, days_overdue: 0, at_risk: false,
  risk_blocked: false, risk_late_start: false, risk_due_soon: false,
  risk_late_dependency: false, risk_paused_job: false,
  late_dependency_titles: [], depends_on_titles: [],
  ...over,
});

/** A normal working day: what a manager opens /tarefas to see. */
export function TodaysBoard() {
  return (
    <TaskBoardList
      locale="pt-PT" groupBy="date" today={TODAY} empty="Nada para hoje."
      tasks={[
        task({ id: '1', title: 'Assentar azulejos da casa de banho', status: 'in_progress', worker_name: 'Miguel', materials: ['Cola de azulejo', 'Cruzetas 2mm'] }),
        task({ id: '2', title: 'Pintar tecto do quarto', worker_name: 'Zé', job_name: 'Moradia Alves', job_id: 'j2' }),
        task({ id: '3', title: 'Instalação eléctrica da cozinha', status: 'pending_review', worker_name: 'João', duration_days: 3 }),
      ]}
    />
  );
}

/** The board earning its keep — every risk signal the view can raise. */
export function LateAndAtRisk() {
  return (
    <TaskBoardList
      locale="pt-PT" groupBy="date" today={TODAY} empty="Nada para hoje."
      tasks={[
        task({ id: '1', title: 'Betonilha do piso térreo', worker_name: 'Miguel',
               // overdue only: risk_due_soon is a `status='pending'` allowlist about an
               // UPCOMING deadline, so the view never raises it on a task already late.
               due_date: '2026-08-19', overdue: true, days_overdue: 5 }),
        task({ id: '2', title: 'Assentar rodapé', worker_name: 'Zé', at_risk: true,
               risk_late_dependency: true, late_dependency_titles: ['Betonilha do piso térreo'],
               depends_on_titles: ['Betonilha do piso térreo'] }),
        task({ id: '3', title: 'Montar armários', status: 'blocked', worker_name: 'João',
               at_risk: true, risk_blocked: true }),
        task({ id: '4', title: 'Selar juntas', job_name: 'Loja Rua Augusta', job_id: 'j3',
               job_status: 'paused', at_risk: true, risk_paused_job: true }),
      ]}
    />
  );
}

/** Grouped by obra instead of by day — the same rows, re-cut by building site. */
export function GroupedByObra() {
  return (
    <TaskBoardList
      locale="pt-PT" groupBy="obra" today={TODAY} empty="Nada para hoje."
      tasks={[
        task({ id: '1', title: 'Assentar azulejos', status: 'in_progress', worker_name: 'Miguel' }),
        task({ id: '2', title: 'Pintar tecto', worker_name: 'Zé' }),
        task({ id: '3', title: 'Ligar quadro eléctrico', job_name: 'Moradia Alves', job_id: 'j2', worker_name: 'João' }),
        task({ id: '4', title: 'Montar montra', job_name: 'Loja Rua Augusta', job_id: 'j3', worker_name: 'Tiago' }),
      ]}
    />
  );
}

/** Nothing on today. Empty is a normal state here, not an error. */
export function Empty() {
  return <TaskBoardList locale="pt-PT" groupBy="date" today={TODAY} empty="Nada marcado para hoje." tasks={[]} />;
}
