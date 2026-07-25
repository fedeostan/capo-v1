import { z } from 'zod';
import type { CapoTool, ToolContext } from './types';

// The agent's window onto the SAME rows the Hoje/Amanhã/Atrasadas screens
// render. This tool exists because of a specific failure: `list_tasks` returns
// raw task rows, so answering "o que temos hoje?" forced the model to
// re-derive the active-window rule
//   lisbon_today() BETWEEN coalesce(start_date, created_at) AND coalesce(due_date, ∞)
// by hand, in a different timezone, from a 50-row page. Capo and the dashboard
// could then give the manager two different answers to the same question —
// which costs more trust than any wrong answer, because the manager cannot
// tell which one to believe.
//
// Reading `dashboard_tasks` makes disagreement structurally impossible: one
// SQL definition, one clock (lisbon_today()), two renderers.

export const horizons = ['hoje', 'amanha', 'atrasadas', 'semana'] as const;
export type Horizon = (typeof horizons)[number];

// horizon → the precomputed boolean column on the view.
const HORIZON_COLUMN: Record<Horizon, 'active_today' | 'active_tomorrow' | 'overdue' | 'active_this_week'> = {
  hoje: 'active_today',
  amanha: 'active_tomorrow',
  atrasadas: 'overdue',
  semana: 'active_this_week',
};

// `*`, not a column list, on purpose: `materials`, `assignee_worker_id` and
// `active_this_week` only exist once migration 0013 is applied. Naming them
// explicitly would make every call fail with 42703 (undefined column) on a
// deploy that lands ahead of the migration; with `*` the columns are simply
// absent and the fields below read as undefined. One row per open task at
// pilot scale, so the wider select costs nothing.
const SELECT = '*';

// Fields the view may not expose yet are optional, matching the `*` select.
interface AgendaRow {
  id: string | null;
  title: string | null;
  status: string | null;
  job_id: string | null;
  job_name: string | null;
  job_status: string | null;
  worker_name: string | null;
  start_date: string | null;
  due_date: string | null;
  days_overdue: number | null;
  assignee_worker_id?: string | null;
  materials?: string[] | null;
}

// PostgREST surfaces an unknown column as Postgres 42703. Only that one code
// is tolerated, and only for the horizon that depends on a 0013 column — any
// other failure still propagates, so this never becomes a blanket catch that
// hides a real outage behind an empty list.
const UNDEFINED_COLUMN = '42703';

async function fetchHorizon(ctx: ToolContext, horizon: Horizon): Promise<AgendaRow[]> {
  const column = HORIZON_COLUMN[horizon];
  const query = ctx.db.from('dashboard_tasks').select(SELECT).eq('company_id', ctx.companyId).eq(column, true);
  const { data, error } =
    horizon === 'atrasadas'
      ? await query.order('days_overdue', { ascending: false })
      : await query.order('job_name', { ascending: true }).order('due_date', { ascending: true });
  if (error) {
    if (horizon === 'semana' && error.code === UNDEFINED_COLUMN) return [];
    throw new Error(`agenda failed: ${error.message}`);
  }
  return (data ?? []) as AgendaRow[];
}

export const agendaInput = z.object({
  horizon: z
    .enum(horizons)
    .describe(
      'hoje = tarefas ativas hoje; amanha = ativas amanhã; atrasadas = com prazo ultrapassado; semana = ativas nos próximos 7 dias.',
    ),
  job_id: z.string().uuid().optional().describe('Restringir a uma obra — usa list_jobs para obter ids.'),
});

export const agenda: CapoTool<z.infer<typeof agendaInput>> = {
  name: 'agenda',
  description:
    "The manager's agenda for a horizon (hoje / amanha / atrasadas / semana), read from the exact same view the app's Hoje/Amanhã/Atrasadas screens render. ALWAYS use this instead of list_tasks + your own date arithmetic when the question is about a day or a delay — it guarantees your answer matches what the manager sees on screen. Read-only.",
  inputSchema: agendaInput,
  async execute(input, ctx) {
    const rows = (await fetchHorizon(ctx, input.horizon)).filter(r => !input.job_id || r.job_id === input.job_id);

    // Grouped by obra because that is how the manager thinks and how the
    // screen renders — same shape, same order, same reading.
    const byObra = new Map<string, AgendaRow[]>();
    for (const row of rows) {
      const key = row.job_name ?? 'Sem obra';
      byObra.set(key, [...(byObra.get(key) ?? []), row]);
    }

    return {
      horizon: input.horizon,
      total: rows.length,
      obras: [...byObra.entries()].map(([obra, tasks]) => ({
        obra,
        paused: tasks.some(t => t.job_status === 'paused'),
        tasks: tasks.map(t => ({
          task_id: t.id,
          title: t.title,
          status: t.status,
          worker: t.worker_name,
          worker_id: t.assignee_worker_id,
          start_date: t.start_date,
          due_date: t.due_date,
          ...(t.days_overdue ? { days_overdue: t.days_overdue } : {}),
          ...(t.materials?.length ? { materials: t.materials } : {}),
        })),
      })),
      ...(rows.length === 0
        ? { note: 'Nada neste horizonte — é o mesmo resultado que o gerente vê no ecrã.' }
        : {}),
    };
  },
};

export const materialsOutlookInput = z.object({
  horizon: z
    .enum(['amanha', 'semana'])
    .default('amanha')
    .describe('amanha = o que é preciso ter em obra amanhã (o caso normal); semana = próximos 7 dias, para encomendas com prazo de entrega.'),
});

export const materialsOutlook: CapoTool<z.infer<typeof materialsOutlookInput>> = {
  name: 'materials_outlook',
  description:
    "Materials needed for upcoming work, grouped by obra — the anticipation list ('what does the manager need to buy or arrange tonight'). Use it whenever the manager asks what to buy/order, when you are closing off the day, or when a plan is approved. Read-only.",
  inputSchema: materialsOutlookInput,
  async execute(input, ctx) {
    const rows = await fetchHorizon(ctx, input.horizon);

    // materials is text[] on the task; the same item can appear on several
    // tasks in the same obra, so collapse per obra and keep the tasks that
    // need it — "porquê" is what makes the list actionable.
    const byObra = new Map<string, Map<string, Set<string>>>();
    for (const row of rows) {
      if (!row.materials?.length) continue;
      const obra = row.job_name ?? 'Sem obra';
      const items = byObra.get(obra) ?? new Map<string, Set<string>>();
      for (const material of row.materials) {
        const forItem = items.get(material) ?? new Set<string>();
        if (row.title) forItem.add(row.title);
        items.set(material, forItem);
      }
      byObra.set(obra, items);
    }

    const obras = [...byObra.entries()].map(([obra, items]) => ({
      obra,
      materials: [...items.entries()].map(([material, tasks]) => ({ material, for_tasks: [...tasks] })),
    }));

    return {
      horizon: input.horizon,
      obras,
      total_items: obras.reduce((n, o) => n + o.materials.length, 0),
      ...(obras.length === 0
        ? {
            note:
              rows.length === 0
                ? 'Não há trabalho agendado neste horizonte.'
                : 'Há trabalho agendado mas nenhuma tarefa tem materiais registados — vale a pena perguntar ao gerente o que é preciso.',
          }
        : {}),
    };
  },
};

export const agendaTools = [agenda, materialsOutlook];
