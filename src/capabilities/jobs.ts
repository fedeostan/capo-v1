import { z } from 'zod';
import type { CapoTool } from './types';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('ISO date, YYYY-MM-DD');

export const createJobInput = z.object({
  name: z.string().min(1).describe('Job (obra) name, e.g. "Remodelação Rua das Flores 12"'),
  address: z.string().optional(),
  client_name: z.string().optional(),
  starts_on: isoDate.optional(),
  ends_on: isoDate.optional(),
});

export const createJob: CapoTool<z.infer<typeof createJobInput>> = {
  name: 'create_job',
  description:
    'Register a new job (obra). This is a write: only call it directly for an explicit manager command; otherwise use propose.',
  inputSchema: createJobInput,
  guarded: true,
  async execute(input, ctx) {
    const { data, error } = await ctx.db
      .from('jobs')
      .insert({
        company_id: ctx.companyId,
        name: input.name,
        address: input.address ?? null,
        client_name: input.client_name ?? null,
        starts_on: input.starts_on ?? null,
        ends_on: input.ends_on ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(`create_job failed: ${error.message}`);
    return { job: data };
  },
};

export const updateJobInput = z.object({
  job_id: z.string().uuid().describe('Job (obra) to update — use list_jobs to find ids.'),
  name: z.string().min(1).optional(),
  address: z.string().optional(),
  client_name: z.string().optional(),
  status: z.enum(['active', 'paused', 'done']).optional(),
  starts_on: isoDate.optional(),
  ends_on: isoDate.optional(),
});

export const updateJob: CapoTool<z.infer<typeof updateJobInput>> = {
  name: 'update_job',
  description:
    'Update an existing job (name, address, client, status, dates). This is a write: only call it directly for an explicit manager command; otherwise use propose.',
  inputSchema: updateJobInput,
  guarded: true,
  async execute(input, ctx) {
    const { job_id, ...fields } = input;
    const { data, error } = await ctx.db
      .from('jobs')
      .update(fields)
      .eq('id', job_id)
      .eq('company_id', ctx.companyId)
      .select()
      .single();
    if (error) throw new Error(`update_job failed: ${error.message}`);
    return { job: data };
  },
};

export const listJobs: CapoTool<Record<string, never>> = {
  name: 'list_jobs',
  description: 'List the company jobs (obras) with their status. Read-only.',
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { data, error } = await ctx.db
      .from('jobs')
      .select('*')
      .eq('company_id', ctx.companyId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`list_jobs failed: ${error.message}`);
    return { jobs: data };
  },
};

export const jobTools = [createJob, updateJob, listJobs];
