import { z } from 'zod';
import type { CapoTool, ToolContext } from './types';

// The agent's window onto the SAME rows the /tarefas board renders.
//
// This tool exists because of a specific failure: `list_tasks` returns raw
// task rows, so answering "o que temos hoje?" forced the model to re-derive
// the active-window rule
//   lisbon_today() BETWEEN coalesce(start_date, created_at) AND coalesce(due_date, ∞)
// by hand, in a different timezone, from a paged result. Capo and the board
// could then give the manager two different answers to the same question —
// which costs more trust than a wrong answer, because he cannot tell which
// one to believe.
//
// Reading `task_board` makes that disagreement structurally impossible: one
// SQL definition, one clock (lisbon_today()), two renderers. The horizons
// below are deliberately the SAME five names as the board's filter chips, so
// "what's at risk?" in chat and the Em risco chip cannot drift apart either.

export const horizons = ['hoje', 'amanha', 'atrasadas', 'risco', 'semana'] as const;
export type Horizon = (typeof horizons)[number];

// horizon → the precomputed boolean column on the view. `semana` is the one
// horizon the board has no chip for, so it filters on the window pair instead
// (see fetchHorizon).
const HORIZON_COLUMN: Record<Exclude<Horizon, 'semana'>, 'active_today' | 'active_tomorrow' | 'overdue' | 'at_risk'> = {
  hoje: 'active_today',
  amanha: 'active_tomorrow',
  atrasadas: 'overdue',
  risco: 'at_risk',
};

interface AgendaRow {
  id: string | null;
  title: string | null;
  status: string | null;
  job_id: string | null;
  job_name: string | null;
  job_status: string | null;
  worker_name: string | null;
  assignee_worker_id: string | null;
  start_date: string | null;
  due_date: string | null;
  days_overdue: number | null;
  materials: string[] | null;
  at_risk: boolean | null;
  risk_blocked: boolean | null;
  risk_late_start: boolean | null;
  risk_due_soon: boolean | null;
  risk_late_dependency: boolean | null;
  risk_paused_job: boolean | null;
  late_dependency_titles: string[] | null;
}

async function fetchHorizon(ctx: ToolContext, horizon: Horizon): Promise<AgendaRow[]> {
  let query = ctx.db.from('task_board').select('*').eq('company_id', ctx.companyId);

  if (horizon === 'semana') {
    // Window intersection with [today, today+6], expressed the same way the
    // board's specific-day filter does it. lisbon_today() is still the clock:
    // `today` is a column on every row, so the bound is read from SQL rather
    // than computed from the server's local time.
    const { data: todayRow } = await ctx.db.rpc('lisbon_today');
    if (!todayRow) return [];
    const end = new Date(`${todayRow}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 6);
    query = query
      .eq('is_open', true)
      .eq('job_active', true)
      .lte('window_start', end.toISOString().slice(0, 10))
      .gte('window_end', todayRow);
  } else {
    query = query.eq(HORIZON_COLUMN[horizon], true);
  }

  const { data, error } =
    horizon === 'atrasadas'
      ? await query.order('days_overdue', { ascending: false })
      : await query.order('job_name', { ascending: true }).order('due_date', { ascending: true, nullsFirst: false });
  if (error) throw new Error(`agenda failed: ${error.message}`);
  return (data ?? []) as AgendaRow[];
}

// Why a task is flagged. A risk with no reason is just a colour — the manager
// needs to know whether to chase a supplier or a person.
function riskReasons(row: AgendaRow): string[] {
  const reasons: string[] = [];
  if (row.risk_blocked) reasons.push('bloqueada');
  if (row.risk_late_start) reasons.push('já devia ter começado');
  if (row.risk_due_soon) reasons.push('prazo em 2 dias úteis');
  if (row.risk_late_dependency) {
    const titles = row.late_dependency_titles ?? [];
    reasons.push(titles.length > 0 ? `espera por: ${titles.join(', ')}` : 'espera por uma tarefa atrasada');
  }
  if (row.risk_paused_job) reasons.push('obra pausada');
  return reasons;
}

export const agendaInput = z.object({
  horizon: z
    .enum(horizons)
    .describe(
      'hoje = active today; amanha = active tomorrow; atrasadas = past their deadline; risco = at risk but NOT yet late (blocked, should have started, due within 2 working days, waiting on a late task, or on a paused job); semana = active in the next 7 days.',
    ),
  job_id: z.string().uuid().optional().describe('Restrict to one job — use list_jobs for ids.'),
});

export const agenda: CapoTool<z.infer<typeof agendaInput>> = {
  name: 'agenda',
  description:
    "The manager's agenda for a horizon (hoje / amanha / atrasadas / risco / semana), read from the exact same view the app's Tasks board renders under the same filter names. ALWAYS use this instead of list_tasks plus your own date arithmetic when the question is about a day, a delay, or what is at risk — it guarantees your answer matches what the manager sees on screen. Read-only.",
  inputSchema: agendaInput,
  async execute(input, ctx) {
    const rows = (await fetchHorizon(ctx, input.horizon)).filter(r => !input.job_id || r.job_id === input.job_id);

    // Grouped by job because that is how the manager thinks and how the board
    // renders — same shape, same order, same reading.
    const byJob = new Map<string, AgendaRow[]>();
    for (const row of rows) {
      const key = row.job_name ?? 'Sem obra';
      byJob.set(key, [...(byJob.get(key) ?? []), row]);
    }

    return {
      horizon: input.horizon,
      total: rows.length,
      obras: [...byJob.entries()].map(([obra, tasks]) => ({
        obra,
        paused: tasks.some(t => t.job_status === 'paused'),
        tasks: tasks.map(t => {
          const reasons = riskReasons(t);
          return {
            task_id: t.id,
            title: t.title,
            status: t.status,
            worker: t.worker_name,
            worker_id: t.assignee_worker_id,
            start_date: t.start_date,
            due_date: t.due_date,
            ...(t.days_overdue ? { days_overdue: t.days_overdue } : {}),
            ...(t.materials?.length ? { materials: t.materials } : {}),
            ...(reasons.length > 0 ? { risk_reasons: reasons } : {}),
          };
        }),
      })),
      ...(rows.length === 0
        ? { note: 'Nothing in this horizon — the same result the manager sees on screen.' }
        : {}),
    };
  },
};

export const materialsOutlookInput = z.object({
  horizon: z
    .enum(['amanha', 'semana'])
    .default('amanha')
    .describe(
      'amanha = what must be on site tomorrow (the normal case); semana = the next 7 days, for anything with a delivery lead time.',
    ),
});

export const materialsOutlook: CapoTool<z.infer<typeof materialsOutlookInput>> = {
  name: 'materials_outlook',
  description:
    "Materials needed for upcoming work, grouped by job — the anticipation list ('what does the manager have to buy or arrange tonight'). Use it whenever the manager asks what to buy or order, when he is winding down the day, or right after a plan is approved. Read-only.",
  inputSchema: materialsOutlookInput,
  async execute(input, ctx) {
    const rows = await fetchHorizon(ctx, input.horizon);

    // materials is text[] on the task; the same item can appear on several
    // tasks in the same job, so collapse per job and keep the tasks that need
    // it — the "why" is what makes the list actionable rather than magic.
    const byJob = new Map<string, Map<string, Set<string>>>();
    for (const row of rows) {
      if (!row.materials?.length) continue;
      const obra = row.job_name ?? 'Sem obra';
      const items = byJob.get(obra) ?? new Map<string, Set<string>>();
      for (const material of row.materials) {
        const forItem = items.get(material) ?? new Set<string>();
        if (row.title) forItem.add(row.title);
        items.set(material, forItem);
      }
      byJob.set(obra, items);
    }

    const obras = [...byJob.entries()].map(([obra, items]) => ({
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
                ? 'No work scheduled in this horizon.'
                : 'There is work scheduled but no materials recorded against any of it — worth asking the manager what is needed.',
          }
        : {}),
    };
  },
};

export const agendaTools = [agenda, materialsOutlook];
