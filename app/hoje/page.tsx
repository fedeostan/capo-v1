import type { Metadata } from 'next';
import { loadDayLabel, loadTasks } from '../dashboard-data';
import { ScreenShell, TasksByObra } from '../dashboard-ui';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Hoje — Capo' };

export default async function HojePage() {
  const [tasks, label] = await Promise.all([loadTasks('active_today'), loadDayLabel(0)]);
  return (
    <ScreenShell title="Hoje" subtitle={label ?? undefined}>
      <TasksByObra tasks={tasks} empty="Nada agendado para hoje." />
    </ScreenShell>
  );
}
