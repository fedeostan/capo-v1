// Static sample data for /design-system/screens.
//
// Three reasons this exists rather than logging into a real account:
//   * it needs no credentials from anybody, ever;
//   * the data is identical on every render, so a before/after screenshot
//     isolates the DESIGN change — with live data rows move, and a layout
//     change is indistinguishable from a data change;
//   * it can hold the hard cases on purpose. A 90-character title, an overdue
//     task, an empty board, a worker with no name: the states that break
//     layouts and that browsing a healthy account never produces.
//
// Typed against the real view Row types, so a fixture that drifts from the
// schema fails `tsc` instead of rendering a screen that cannot exist.
import type { Tables } from '@capo/db/types';
import type { MaterialsGroup } from '@capo/ui/dashboard-ui';

export type TaskBoardRow = Tables<'task_board'>;

/**
 * Every column `task_board` declares (36, read off the generated type in
 * packages/db/src/types.ts), filled with plausible values for one ordinary
 * task: painting a ceiling at "Casa de Paco", assigned to Miguel, due
 * tomorrow. Fixtures below override only the columns that make each state
 * interesting and inherit the rest from here — a fixture stating only its
 * interesting fields is one a reader can trust the rest of.
 */
export const BASE_TASK: TaskBoardRow = {
  id: 'a0000000-0000-4000-8000-000000000001',
  company_id: 'c0000000-0000-4000-8000-000000000001',
  title: 'Pintar tecto',
  description: 'Pintura do tecto da sala principal, duas demãos.',
  status: 'pending',
  job_id: 'j0000000-0000-4000-8000-000000000001',
  job_name: 'Casa de Paco',
  job_status: 'active',
  job_active: true,
  job_address: 'Rua das Flores 12, Cascais',
  assignee_worker_id: 'w0000000-0000-4000-8000-000000000001',
  worker_name: 'Miguel',
  collaborator_worker_ids: [],
  collaborator_names: [],
  start_date: '2026-08-24',
  due_date: '2026-08-26',
  duration_days: 2,
  materials: ['Tinta branca', 'Rolo'],
  created_at: '2026-08-20T09:00:00Z',
  updated_at: '2026-08-20T09:00:00Z',
  today: '2026-08-23',
  window_start: '2026-08-24',
  window_end: '2026-08-26',
  active_today: false,
  active_tomorrow: true,
  is_open: true,
  overdue: false,
  days_overdue: 0,
  at_risk: false,
  risk_blocked: false,
  risk_due_soon: false,
  risk_late_dependency: false,
  risk_late_start: false,
  risk_paused_job: false,
  late_dependency_titles: [],
  depends_on_titles: [],
};

/** Fill in every column of the real row type, then override what matters.
 *  Written as a helper so each fixture below states only its interesting
 *  fields and the rest stay obviously irrelevant. */
export function taskFixture(overrides: Partial<TaskBoardRow>): TaskBoardRow {
  return {
    ...BASE_TASK,
    ...overrides,
  };
}

// ── State 1: a normal board — five tasks, mixed statuses ────────────────────
export const NORMAL_BOARD: TaskBoardRow[] = [
  taskFixture({
    id: 'a0000000-0000-4000-8000-000000000001',
    title: 'Pintar tecto',
    status: 'pending',
    job_name: 'Casa de Paco',
    worker_name: 'Miguel',
  }),
  taskFixture({
    id: 'a0000000-0000-4000-8000-000000000002',
    title: 'Assentar azulejo',
    status: 'in_progress',
    job_name: 'Casa de Paco',
    worker_name: 'Zé',
    due_date: '2026-08-25',
  }),
  taskFixture({
    id: 'a0000000-0000-4000-8000-000000000003',
    title: 'Rebocar parede exterior',
    status: 'pending_review',
    job_name: 'Moradia Cascais',
    worker_name: 'João',
    due_date: '2026-08-22',
  }),
  taskFixture({
    id: 'a0000000-0000-4000-8000-000000000004',
    title: 'Instalar portas interiores',
    status: 'done',
    job_name: 'Moradia Cascais',
    worker_name: 'Miguel',
    due_date: '2026-08-20',
  }),
  taskFixture({
    id: 'a0000000-0000-4000-8000-000000000005',
    title: 'Limpar estaleiro',
    status: 'cancelled',
    job_name: 'Armazém Sintra',
    worker_name: 'Zé',
    due_date: '2026-08-21',
  }),
];

// ── State 2: an empty board ──────────────────────────────────────────────
export const EMPTY_BOARD: TaskBoardRow[] = [];

// ── State 3: one overdue task and one pending_review ────────────────────────
export const OVERDUE_AND_REVIEW_BOARD: TaskBoardRow[] = [
  taskFixture({
    id: 'a0000000-0000-4000-8000-000000000006',
    title: 'Trocar torneira da cozinha',
    status: 'in_progress',
    job_name: 'Casa de Paco',
    worker_name: 'João',
    due_date: '2026-08-20',
    overdue: true,
    days_overdue: 3,
    at_risk: true,
  }),
  taskFixture({
    id: 'a0000000-0000-4000-8000-000000000007',
    title: 'Colocar rodapés da sala',
    status: 'pending_review',
    job_name: 'Moradia Cascais',
    worker_name: 'Miguel',
    due_date: '2026-08-23',
  }),
];

// ── State 4: a 90-character title (truncation check) ────────────────────────
// Exactly 90 characters — verified with `.length`, not eyeballed.
const LONG_TITLE =
  'Verificar e substituir os azulejos partidos da casa de banho principal antes das vistorias';

export const LONG_TITLE_BOARD: TaskBoardRow[] = [
  taskFixture({
    id: 'a0000000-0000-4000-8000-000000000008',
    title: LONG_TITLE,
    status: 'pending',
    job_name: 'Armazém Sintra',
    worker_name: 'Zé',
  }),
];

// ── State 5: a worker with no name (null) on a row ──────────────────────────
export const NO_WORKER_BOARD: TaskBoardRow[] = [
  taskFixture({
    id: 'a0000000-0000-4000-8000-000000000009',
    title: 'Preparar estaleiro para a próxima fase',
    status: 'pending',
    job_name: 'Anexo Oeiras',
    assignee_worker_id: null,
    worker_name: null,
  }),
];

// ── State 7: the materials list with seven obra groups ──────────────────────
// COLLAPSE_ABOVE in @capo/ui/dashboard-ui is 3, so seven groups exercises the
// collapsed-by-default path — the case Federico complained about verbatim
// ("sete obras é preciso fazer scroll como um doido").
export const SEVEN_OBRA_MATERIALS: MaterialsGroup[] = [
  {
    obraId: 'j0000000-0000-4000-8000-000000000001',
    obraName: 'Casa de Paco',
    tasks: [{ id: 'a0000000-0000-4000-8000-000000000001', title: 'Pintar tecto', materials: ['Tinta branca', 'Rolo'] }],
    items: [
      { material: 'Tinta branca', forTasks: [{ id: 'a0000000-0000-4000-8000-000000000001', title: 'Pintar tecto', materials: ['Tinta branca'] }] },
      { material: 'Rolo', forTasks: [{ id: 'a0000000-0000-4000-8000-000000000001', title: 'Pintar tecto', materials: ['Rolo'] }] },
    ],
  },
  {
    obraId: 'j0000000-0000-4000-8000-000000000002',
    obraName: 'Moradia Cascais',
    tasks: [{ id: 'a0000000-0000-4000-8000-000000000004', title: 'Instalar portas interiores', materials: ['Portas', 'Dobradiças'] }],
    items: [
      { material: 'Portas', forTasks: [{ id: 'a0000000-0000-4000-8000-000000000004', title: 'Instalar portas interiores', materials: ['Portas'] }] },
      { material: 'Dobradiças', forTasks: [{ id: 'a0000000-0000-4000-8000-000000000004', title: 'Instalar portas interiores', materials: ['Dobradiças'] }] },
    ],
  },
  {
    obraId: 'j0000000-0000-4000-8000-000000000003',
    obraName: 'Armazém Sintra',
    tasks: [{ id: 'a0000000-0000-4000-8000-000000000008', title: LONG_TITLE, materials: ['Azulejo', 'Cimento cola'] }],
    items: [
      { material: 'Azulejo', forTasks: [{ id: 'a0000000-0000-4000-8000-000000000008', title: LONG_TITLE, materials: ['Azulejo'] }] },
      { material: 'Cimento cola', forTasks: [{ id: 'a0000000-0000-4000-8000-000000000008', title: LONG_TITLE, materials: ['Cimento cola'] }] },
    ],
  },
  {
    obraId: 'j0000000-0000-4000-8000-000000000004',
    obraName: 'Loja Cascais Centro',
    tasks: [{ id: 'a0000000-0000-4000-8000-000000000010', title: 'Montar prateleiras', materials: ['Prateleiras', 'Buchas'] }],
    items: [
      { material: 'Prateleiras', forTasks: [{ id: 'a0000000-0000-4000-8000-000000000010', title: 'Montar prateleiras', materials: ['Prateleiras'] }] },
      { material: 'Buchas', forTasks: [{ id: 'a0000000-0000-4000-8000-000000000010', title: 'Montar prateleiras', materials: ['Buchas'] }] },
    ],
  },
  {
    obraId: 'j0000000-0000-4000-8000-000000000005',
    obraName: 'Restauro Sintra Velha',
    tasks: [{ id: 'a0000000-0000-4000-8000-000000000011', title: 'Restaurar caixilharia', materials: ['Verniz'] }],
    items: [
      { material: 'Verniz', forTasks: [{ id: 'a0000000-0000-4000-8000-000000000011', title: 'Restaurar caixilharia', materials: ['Verniz'] }] },
    ],
  },
  {
    obraId: 'j0000000-0000-4000-8000-000000000006',
    obraName: 'Anexo Oeiras',
    tasks: [{ id: 'a0000000-0000-4000-8000-000000000009', title: 'Preparar estaleiro para a próxima fase', materials: [] }],
    items: [],
  },
  {
    obraId: 'j0000000-0000-4000-8000-000000000007',
    obraName: 'Cobertura Amadora',
    tasks: [{ id: 'a0000000-0000-4000-8000-000000000012', title: 'Impermeabilizar telhado', materials: ['Tela asfáltica', 'Manta', 'Cola'] }],
    items: [
      { material: 'Tela asfáltica', forTasks: [{ id: 'a0000000-0000-4000-8000-000000000012', title: 'Impermeabilizar telhado', materials: ['Tela asfáltica'] }] },
      { material: 'Manta', forTasks: [{ id: 'a0000000-0000-4000-8000-000000000012', title: 'Impermeabilizar telhado', materials: ['Manta'] }] },
      { material: 'Cola', forTasks: [{ id: 'a0000000-0000-4000-8000-000000000012', title: 'Impermeabilizar telhado', materials: ['Cola'] }] },
    ],
  },
];
