import type { Metadata } from 'next';
import { requireAuth } from '@capo/db/session';
import { loadObras } from '@/app/dashboard-data';
import { ObrasList, ScreenShell } from '@capo/ui/dashboard-ui';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Obras — Capo' };

export default async function ObrasPage() {
  const ctx = await requireAuth();
  const obras = await loadObras(ctx);
  return (
    <ScreenShell title="Obras" subtitle="Obras ativas">
      <ObrasList obras={obras} empty="Sem obras ativas." />
    </ScreenShell>
  );
}
