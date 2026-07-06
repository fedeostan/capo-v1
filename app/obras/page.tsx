import type { Metadata } from 'next';
import { loadObras } from '../dashboard-data';
import { ObrasList, ScreenShell } from '../dashboard-ui';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Obras — Capo' };

export default async function ObrasPage() {
  const obras = await loadObras();
  return (
    <ScreenShell title="Obras" subtitle="Obras ativas">
      <ObrasList obras={obras} empty="Sem obras ativas." />
    </ScreenShell>
  );
}
