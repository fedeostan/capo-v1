import type { Metadata } from 'next';
import { loadDayLabel, loadTasks } from '../dashboard-data';
import { ScreenShell, TasksByObra } from '../dashboard-ui';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Amanhã — Capo' };

export default async function AmanhaPage() {
  const [tasks, label] = await Promise.all([loadTasks('active_tomorrow'), loadDayLabel(1)]);
  return (
    <ScreenShell title="Amanhã" subtitle={label ?? undefined}>
      <TasksByObra tasks={tasks} empty="Nada agendado para amanhã." />
    </ScreenShell>
  );
}
