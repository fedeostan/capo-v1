// Read-only queries for the dashboard screens. The dashboard reads; the chat
// writes — nothing in this file may mutate. Date-bucket logic lives in SQL
// (dashboard_tasks view, driven by lisbon_today()) so the dashboard and the
// SMS dispatch can never disagree about what day it is.
//
// Every function takes the caller's AuthContext: queries run on the
// user-scoped client (RLS-enforced) and the explicit company_id filter is
// kept on top as belt-and-braces.
import type { AuthContext } from '@capo/db/session';
import type { DashboardObra, DashboardTask } from '@capo/ui/dashboard-ui';

export type { DashboardObra, DashboardTask };

type Bucket = 'active_today' | 'active_tomorrow' | 'overdue';

export async function loadTasks({ db, companyId }: AuthContext, bucket: Bucket): Promise<DashboardTask[]> {
  const query = db.from('dashboard_tasks').select('*').eq('company_id', companyId).eq(bucket, true);
  const { data } =
    bucket === 'overdue'
      ? await query.order('days_overdue', { ascending: false })
      : await query.order('job_name', { ascending: true });
  return data ?? [];
}

// Display label for the Hoje/Amanhã headers. The date comes from the same
// lisbon_today() SQL function that drives the buckets — never from local time —
// so the header can't contradict the list under it. Read-only RPC.
export async function loadDayLabel({ db }: AuthContext, offsetDays: 0 | 1): Promise<string | null> {
  const { data } = await db.rpc('lisbon_today');
  if (!data) return null;
  const day = new Date(`${data}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offsetDays);
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(day);
}

export async function loadObras({ db, companyId }: AuthContext): Promise<DashboardObra[]> {
  const { data } = await db
    .from('dashboard_obras')
    .select('*')
    .eq('company_id', companyId)
    .order('name', { ascending: true });
  return data ?? [];
}
