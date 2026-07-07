import type { Metadata } from 'next';
import { requireAuth } from '@/src/auth/session';
import { loadObras } from '@/app/dashboard-data';
import { ObrasList, ScreenShell } from '@/app/dashboard-ui';

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
