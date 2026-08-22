import { TaskDetail, ScreenShell, type BoardTask, type TaskDetailJob, type TaskDetailWorker } from '@capo/ui';

const TODAY = '2026-08-24';

const mk = (over: Partial<BoardTask> & Pick<BoardTask, 'id' | 'title'>): BoardTask => ({
  status: 'in_progress', description: null, duration_days: 2, materials: null,
  job_id: 'j1', job_name: 'Casa de Paco', job_status: 'active',
  worker_name: 'Miguel', assignee_worker_id: 'w1',
  start_date: TODAY, due_date: '2026-08-26',
  active_today: true, active_tomorrow: true,
  overdue: false, days_overdue: 0, at_risk: false,
  risk_blocked: false, risk_late_start: false, risk_due_soon: false,
  risk_late_dependency: false, risk_paused_job: false,
  late_dependency_titles: [], depends_on_titles: [],
  ...over,
});

const job: TaskDetailJob = {
  id: 'j1', name: 'Casa de Paco', address: 'Rua das Flores 12, 4000-123 Porto',
  client_name: 'Paco Ribeiro', status: 'active',
};
const miguel: TaskDetailWorker = { id: 'w1', name: 'Miguel', trade: 'Pintor', phone: '+351912345678', active: true };

/**
 * TaskDetail does NOT render the task title. /tarefas/[id] wraps it in a
 * ScreenShell whose title IS the task title and whose subtitle is
 * `[job.name, job.address].filter(Boolean).join(' · ')`. Composing it any other
 * way gives a task screen with no heading, so every cell shows the real pairing.
 *
 * No fixed height: ScreenShell is overflow-hidden and carries no scroller (the
 * app supplies one), so a height-constrained card would silently clip the body.
 */
const Screen = ({ task, job: j, children }: { task: BoardTask; job: TaskDetailJob | null; children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column' }}>
    <ScreenShell title={task.title} subtitle={[j?.name, j?.address].filter(Boolean).join(' · ') || undefined}>
      {children}
    </ScreenShell>
  </div>
);

// A photo url is a short-lived signed URL in the app; here it is an inline SVG
// so the card is self-contained and can never render a broken frame.
const photo = (id: string, source: string, createdAt: string, tone: string) => ({
  id, source, createdAt,
  url: `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="${tone}"/><rect x="12" y="72" width="96" height="36" fill="rgba(255,255,255,.35)"/></svg>`)}`,
});

const full = mk({ id: 't1', title: 'Pintar tecto do quarto principal',
  description: 'Duas demãos. O tecto tem uma mancha de humidade no canto norte — lixar antes.',
  materials: ['Tinta branca 15L', 'Rolo de pintura', 'Fita de pintor'] });

const claimed = mk({ id: 't2', title: 'Assentar azulejos da casa de banho',
  status: 'pending_review', proof_count: 2, materials: ['Cola de azulejo', 'Cruzetas 2mm'] });

const late = mk({ id: 't3', title: 'Assentar rodapé', status: 'blocked',
  worker_name: null, assignee_worker_id: null,
  start_date: '2026-08-17', due_date: '2026-08-19',
  overdue: true, days_overdue: 5, at_risk: true, risk_blocked: true,
  risk_late_dependency: true,
  late_dependency_titles: ['Betonilha do piso térreo'],
  depends_on_titles: ['Betonilha do piso térreo'] });

const fresh = mk({ id: 't4', title: 'Limpeza final', materials: [] });

const noObra = mk({ id: 't5', title: 'Reparar degrau da entrada',
  job_id: null, job_name: null, job_status: null });

/** The whole screen: obra, client, assignee, dates, description and materials. */
export function FullTask() {
  return (
    <Screen task={full} job={job}>
      <TaskDetail locale="pt-PT" job={job} worker={miguel} task={full} />
    </Screen>
  );
}

/** A completion claim awaiting the manager, with the crew's photos attached. */
export function AwaitingReviewWithPhotos() {
  return (
    <Screen task={claimed} job={job}>
      <TaskDetail
        locale="pt-PT" job={job} worker={miguel} task={claimed}
        collaborators={[{ id: 'w2', name: 'Zé' }, { id: 'w3', name: 'João' }]}
        photos={[
          photo('p1', 'worker', '2026-08-24T16:40:00Z', '#8fa3b8'),
          photo('p2', 'worker', '2026-08-24T16:41:00Z', '#a8968a'),
        ]}
      />
    </Screen>
  );
}

/** Late, unassigned, and waiting on work that has not finished. */
export function OverdueAndBlocked() {
  return (
    <Screen task={late} job={job}>
      <TaskDetail locale="pt-PT" job={job} worker={null} task={late} />
    </Screen>
  );
}

/**
 * With the injected controls present. Their presence alone makes the
 * collaborators and materials sections render even when both are empty —
 * otherwise the one screen that can add to them hides them until they exist.
 */
export function WithInjectedControls() {
  const Button = ({ label }: { label: string }) => (
    <button type="button" style={{ fontSize: 13, padding: '0.25rem 0.6rem', borderRadius: 8, border: '1px solid rgba(113,113,122,0.35)', background: 'transparent' }}>{label}</button>
  );
  return (
    <Screen task={fresh} job={job}>
      <TaskDetail
        locale="pt-PT" job={job} worker={miguel} task={fresh}
        renderAssignee={() => <Button label="Miguel · trocar" />}
        renderCollaborators={() => <Button label="Adicionar quem ajuda" />}
        renderMaterials={() => <Button label="Adicionar material" />}
        renderActions={() => <Button label="Concluir" />}
      />
    </Screen>
  );
}

/** A task with no obra attached — every obra-dependent line simply drops. */
export function WithoutAnObra() {
  return (
    <Screen task={noObra} job={null}>
      <TaskDetail locale="pt-PT" job={null} worker={miguel} task={noObra} />
    </Screen>
  );
}
