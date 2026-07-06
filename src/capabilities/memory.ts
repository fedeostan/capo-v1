import { z } from 'zod';
import type { CapoTool } from './types';

export const rememberInput = z.object({
  kind: z
    .enum(['company', 'job', 'worker', 'preference', 'fact'])
    .describe('What the fact is about: the company, a job, a worker, a manager preference, or a general fact'),
  content: z
    .string()
    .min(1)
    .describe('The durable fact, one per call, self-contained, in European Portuguese'),
  subject_type: z.enum(['job', 'worker']).optional(),
  subject_id: z.string().uuid().optional().describe('Id of the job/worker this fact is about, if any'),
});

// Unguarded: remembering is non-destructive. All active memories are injected
// into the system context each turn (fine at one-company scale; a recall tool
// comes when memory outgrows context).
export const remember: CapoTool<z.infer<typeof rememberInput>> = {
  name: 'remember',
  description:
    'Store a durable fact that must survive across conversations (preferences, client info, standing constraints). Not for chit-chat or things already in the task list.',
  inputSchema: rememberInput,
  async execute(input, ctx) {
    const { data, error } = await ctx.db
      .from('memories')
      .insert({
        company_id: ctx.companyId,
        kind: input.kind,
        content: input.content,
        subject_type: input.subject_type ?? null,
        subject_id: input.subject_id ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(`remember failed: ${error.message}`);
    return { memory: { id: data.id, kind: data.kind, content: data.content } };
  },
};

export const memoryTools = [remember];
