import { z } from 'zod';
import type { CapoTool } from './types';

// E.164 — serves the SMS dispatch now and WhatsApp later. Validation failure
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
  trade: z.string().optional().describe('Trade/ofício, e.g. "pedreiro", "eletricista"'),
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
});

export const updateWorker: CapoTool<z.infer<typeof updateWorkerInput>> = {
  name: 'update_worker',
  description:
    'Update an existing worker (name, trade, phone). This is a write: only call it directly for an explicit manager command; otherwise use propose.',
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
  description: 'List the team workers with their trades. Read-only.',
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { data, error } = await ctx.db
      .from('workers')
      .select('*')
      .eq('company_id', ctx.companyId)
      .eq('active', true)
      .order('name');
    if (error) throw new Error(`list_workers failed: ${error.message}`);
    return { workers: data };
  },
};

export const workerTools = [addWorker, updateWorker, listWorkers];
