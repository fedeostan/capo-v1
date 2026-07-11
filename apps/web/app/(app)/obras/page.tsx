import type { Metadata } from 'next';
import { requireAuth } from '@capo/db/session';
import { loadObras, loadOverdueByObra } from '@/app/dashboard-data';
import { ObrasList, ScreenShell } from '@capo/ui/dashboard-ui';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Obras — Capo' };

export default async function ObrasPage() {
  const ctx = await requireAuth();
  const [obras, overdueByObra] = await Promise.all([loadObras(ctx), loadOverdueByObra(ctx)]);
  return (
    <ScreenShell title="Obras" subtitle="Obras ativas — progresso e atrasos">
      <ObrasList obras={obras} empty="Sem obras ativas." overdueByObra={overdueByObra} />
    </ScreenShell>
  );
}
