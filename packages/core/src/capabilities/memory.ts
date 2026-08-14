import { z } from 'zod';
import { MEMORY_CONTENT_MAX_CHARS } from '../agent/memory/prompt-memories';
import type { CapoTool } from './types';

export const rememberInput = z.object({
  kind: z
    .enum(['company', 'job', 'worker', 'preference', 'fact'])
    .describe('What the fact is about: the company, a job, a worker, a manager preference, or a general fact'),
  content: z
    .string()
    .min(1)
    .max(MEMORY_CONTENT_MAX_CHARS)
    .describe(
      `The durable fact, one per call, self-contained, at most ${MEMORY_CONTENT_MAX_CHARS} characters, written in the company's domain language (see the Language policy in your instructions).`,
    ),
  // WHO the memory belongs to — a different question from `kind`/`subject_*`,
  // which say what it is ABOUT (issue #48). "Zé is slow on tiling" is about a
  // worker and belongs to the company; "address me by my first name" is about
  // nobody and belongs to one person.
  //
  // Defaulted to 'company' rather than required: every memory written before
  // 0037 is company-scoped, and a required field would make the model's first
  // omission a tool-input error instead of the historical behaviour.
  scope: z
    .enum(['company', 'personal'])
    .optional()
    .describe(
      "Who this is for. 'company' (the default) is anything the whole business needs — clients, jobs, crew, standing constraints. 'personal' is ONLY for how this particular manager wants to be spoken to or worked with; nobody else will ever see it.",
    ),
  subject_type: z.enum(['job', 'worker']).optional(),
  subject_id: z.string().uuid().optional().describe('Id of the job/worker this fact is about, if any'),
});

// Unguarded: remembering is non-destructive.
//
// Memories are injected into the system context each turn, but since #48 they
// are CAPPED on the way in (40 rows / 6000 chars, newest first — see
// agent/memory/prompt-memories.ts) rather than injected wholesale, and the
// manager can inspect and forget any of them on /perfil/memoria. A recall tool
// over what falls outside that window is still the right next step and is
// deliberately not built here.
export const remember: CapoTool<z.infer<typeof rememberInput>> = {
  name: 'remember',
  description:
    'Store a durable fact that must survive across conversations (preferences, client info, standing constraints). Not for chit-chat or things already in the task list.',
  inputSchema: rememberInput,
  async execute(input, ctx) {
    // A personal memory needs somebody to belong to. `ctx.userId` is null when a
    // tool runs from an APPROVED PROPOSAL — there is no live user in that path —
    // so "personal" there has no honest owner and falls back to the company.
    // Silently, and correctly: the alternative is failing a write the manager
    // already approved over a scope nuance he never expressed.
    const profileId = input.scope === 'personal' ? ctx.userId : null;

    const { data, error } = await ctx.db
      .from('memories')
      .insert({
        company_id: ctx.companyId,
        profile_id: profileId,
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
