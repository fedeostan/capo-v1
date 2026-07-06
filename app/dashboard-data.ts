// Read-only queries for the dashboard screens. The dashboard reads; the chat
// writes — nothing in this file may mutate. Date-bucket logic lives in SQL
// (dashboard_tasks view, driven by lisbon_today()) so the dashboard and the
// SMS dispatch can never disagree about what day it is.
import { getDb } from '@/src/db/client';
import type { Tables } from '@/src/db/types';

export type DashboardTask = Tables<'dashboard_tasks'>;
export type DashboardObra = Tables<'dashboard_obras'>;

type Bucket = 'active_today' | 'active_tomorrow' | 'overdue';

// The dashboard queries companies directly instead of ensureRuntime(), which
// lazily creates a conversation row — a write this surface must never do.
async function companyId(): Promise<string | null> {
  const db = getDb();
  const { data } = await db
    .from('companies')
    .select('id')
    .order('created_at')
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

export async function loadTasks(bucket: Bucket): Promise<DashboardTask[]> {
  try {
    const id = await companyId();
    if (!id) return [];
    const query = getDb().from('dashboard_tasks').select('*').eq('company_id', id).eq(bucket, true);
    const { data } =
      bucket === 'overdue'
        ? await query.order('days_overdue', { ascending: false })
        : await query.order('job_name', { ascending: true });
    return data ?? [];
  } catch {
    // env not configured yet — render the empty state, same stance as app/page.tsx
    return [];
  }
}

// Display label for the Hoje/Amanhã headers. The date comes from the same
// lisbon_today() SQL function that drives the buckets — never from local time —
// so the header can't contradict the list under it. Read-only RPC.
export async function loadDayLabel(offsetDays: 0 | 1): Promise<string | null> {
  try {
    const { data } = await getDb().rpc('lisbon_today');
    if (!data) return null;
    const day = new Date(`${data}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + offsetDays);
    return new Intl.DateTimeFormat('pt-PT', {
      timeZone: 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(day);
  } catch {
    return null;
  }
}

export async function loadObras(): Promise<DashboardObra[]> {
  try {
    const id = await companyId();
    if (!id) return [];
    const { data } = await getDb()
      .from('dashboard_obras')
      .select('*')
      .eq('company_id', id)
      .order('name', { ascending: true });
    return data ?? [];
  } catch {
    return [];
  }
}
