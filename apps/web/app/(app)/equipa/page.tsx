import type { Metadata } from 'next';
import { requireAuth } from '@capo/db/session';
import { loadTeam, loadUnassignedToday } from '@/app/dashboard-data';
import { ScreenShell, TeamList } from '@capo/ui/dashboard-ui';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Equipa — Capo' };

// Until now the manager had no screen for their own crew: workers existed only
// as ids the agent resolved. This makes the 07:00 SMS dispatch legible — who
// is reachable, who is carrying what, and which work is going out to nobody.
export default async function EquipaPage() {
  const ctx = await requireAuth();
  const [members, unassignedToday] = await Promise.all([loadTeam(ctx), loadUnassignedToday(ctx)]);
  const unreachable = members.filter(m => !m.recebeSms).length;

  const subtitle =
    members.length === 0
      ? undefined
      : unreachable > 0
        ? `${members.length} na equipa · ${unreachable} sem telemóvel`
        : `${members.length} na equipa · todos recebem o SMS das 07:00`;

  return (
    <ScreenShell title="Equipa" subtitle={subtitle}>
      <TeamList
        members={members}
        unassignedToday={unassignedToday}
        empty="Ainda não há equipa registada — pede ao Capo para adicionar os trabalhadores."
      />
    </ScreenShell>
  );
}
