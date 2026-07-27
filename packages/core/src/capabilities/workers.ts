import { z } from 'zod';
import { LOCALES } from '@capo/i18n/locale';
import type { CapoTool } from './types';

// E.164 — this is the number the daily WhatsApp briefing is sent to, and the
// number an inbound worker reply is matched against. Validation failure
// bounces back to the model, which asks the manager for the full international
// format instead of storing a bad number.
const e164Phone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/)
  .describe(
    'Phone in E.164 international format, e.g. +351912345678. If the manager gives a local number, ask them to confirm the full international format — never guess the country prefix.',
  );

export const addWorkerInput = z.object({
  name: z.string().min(1),
  trade: z
    .string()
    .optional()
    .describe(
      "The worker's trade (bricklayer, electrician, plumber…), written in the company's domain language (see the Language policy in your instructions).",
    ),
  phone: e164Phone.optional(),
});

export const addWorker: CapoTool<z.infer<typeof addWorkerInput>> = {
  name: 'add_worker',
  description:
    'Add a worker to the team. This is a write: only call it directly for an explicit manager command; otherwise use propose.',
  inputSchema: addWorkerInput,
  guarded: true,
  async execute(input, ctx) {
    const { data, error } = await ctx.db
      .from('workers')
      .insert({
        company_id: ctx.companyId,
        name: input.name,
        trade: input.trade ?? null,
        phone: input.phone ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(`add_worker failed: ${error.message}`);
    return { worker: data };
  },
};

export const updateWorkerInput = z.object({
  worker_id: z.string().uuid().describe('Worker to update — use list_workers to find ids.'),
  name: z.string().min(1).optional(),
  trade: z.string().optional(),
  phone: e164Phone.optional(),
  language: z
    .enum(LOCALES)
    .optional()
    .describe(
      "The language of this worker's daily WhatsApp briefing. Workers normally set this themselves by replying PT, ES or EN to the message — only set it here when the manager explicitly asks on their behalf. Unset means they follow the company language. Note this does NOT translate task titles, which are always stored in the company language.",
    ),
});

export const updateWorker: CapoTool<z.infer<typeof updateWorkerInput>> = {
  name: 'update_worker',
  description:
    'Update an existing worker (name, trade, phone, briefing language). This is a write: only call it directly for an explicit manager command; otherwise use propose.',
  inputSchema: updateWorkerInput,
  guarded: true,
  async execute(input, ctx) {
    const { worker_id, ...fields } = input;
    const { data, error } = await ctx.db
      .from('workers')
      .update(fields)
      .eq('id', worker_id)
      .eq('company_id', ctx.companyId)
      .select()
      .single();
    if (error) throw new Error(`update_worker failed: ${error.message}`);
    return { worker: data };
  },
};

export const listWorkers: CapoTool<Record<string, never>> = {
  name: 'list_workers',
  description:
    "List the team: trade, whether they are reachable by the 07:00 WhatsApp briefing, and how loaded they are today/tomorrow. Use it to answer 'quem está livre?' and before assigning work. Read-only.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { data, error } = await ctx.db
      .from('workers')
      .select('*')
      .eq('company_id', ctx.companyId)
      .eq('active', true)
      .order('name');
    if (error) throw new Error(`list_workers failed: ${error.message}`);

    // Load comes from task_board — the same view the Tasks board, the crew
    // card on /perfil, and the `agenda` tool all read — so "today"/"tomorrow"
    // mean one thing everywhere. (Deliberately NOT dashboard_tasks: 0013 marks
    // that view for removal in a follow-up migration.)
    // Best-effort: a worker roster is still useful without the tallies.
    const load = new Map<string, { hoje: number; amanha: number; atrasadas: number; abertas: number }>();
    const { data: rows } = await ctx.db
      .from('task_board')
      .select('assignee_worker_id, active_today, active_tomorrow, overdue')
      .eq('company_id', ctx.companyId)
      .eq('is_open', true);
    for (const row of rows ?? []) {
      if (!row.assignee_worker_id) continue;
      const entry = load.get(row.assignee_worker_id) ?? { hoje: 0, amanha: 0, atrasadas: 0, abertas: 0 };
      entry.abertas += 1;
      if (row.active_today) entry.hoje += 1;
      if (row.active_tomorrow) entry.amanha += 1;
      if (row.overdue) entry.atrasadas += 1;
      load.set(row.assignee_worker_id, entry);
    }

    return {
      workers: (data ?? []).map(w => ({
        ...w,
        // The 07:00 briefing is addressed to workers.phone; without one the
        // manager has to relay the day's tasks by hand.
        recebe_whatsapp: Boolean(w.phone),
        tarefas: load.get(w.id) ?? { hoje: 0, amanha: 0, atrasadas: 0, abertas: 0 },
      })),
    };
  },
};

export const workerTools = [addWorker, updateWorker, listWorkers];
