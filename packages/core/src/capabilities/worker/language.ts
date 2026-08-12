import { z } from 'zod';
import { LOCALES } from '@capo/i18n/locale';
import type { WorkerTool } from './types';
import { workerToolError } from './types';

// The third language dial — `workers.language` — and the only one its owner
// controls themselves.
//
// This is NOT `set_language` (../language.ts). That tool writes
// `profiles.language` and needs `ctx.userId`, a field WorkerContext
// deliberately does not have, so it could not be called from here even if
// somebody added it to the roster by mistake: it would not compile.
//
// The deterministic LANGUAGE_KEYWORDS fast path in the webhook route stays IN
// FRONT of the agent and is untouched. Replying "ES" resolves with zero model
// calls, as it always has — it is free, instant, and the documented worker
// command surface, and routing it through a model would be a regression in
// cost and latency for the one thing that already works. This tool exists for
// the sentence the lookup cannot answer: "podes falar comigo em espanhol?".

export const setMyLanguageInput = z.object({
  language: z
    .enum(LOCALES)
    .describe(
      'BCP-47 code. pt-PT = European Portuguese, es-ES = Spanish (Spain), en-US = American English.',
    ),
});

export const setMyLanguage: WorkerTool<z.infer<typeof setMyLanguageInput>> = {
  audience: 'worker',
  name: 'set_my_language',
  description:
    'Change the language Capo writes to THIS crew member in — their daily 07:00 message and this conversation. Use it when they ask in words ("podes falar comigo em espanhol?"). Takes effect immediately, including in the reply you are writing now. It changes nothing for anyone else and nothing about the task titles themselves.',
  inputSchema: setMyLanguageInput,
  execute: async (input, ctx) => {
    // TWO filters on a single-row update, and the company one is not
    // decoration: auth.uid() is null on this path, so RLS scopes nothing and
    // `.eq('id')` alone would be the only thing standing between "my language"
    // and "somebody else's". workerId is phone-derived and never model-supplied,
    // so this cannot be aimed by anything the worker writes — but a mis-wired
    // call site should fail closed rather than write across tenants.
    const { data, error } = await ctx.db
      .from('workers')
      .update({ language: input.language })
      .eq('id', ctx.workerId)
      .eq('company_id', ctx.companyId)
      .select('id');
    if (error) throw new Error(`set_my_language failed: ${error.message}`);
    if (!data?.length) return workerToolError('Could not change the language.');

    return {
      status: 'ok' as const,
      language: input.language,
      // The lever that makes the switch apply to THIS reply rather than the
      // next one: a tool result is fresher context than the system prompt,
      // which was assembled before the loop began. Same device as
      // ../language.ts, and the reason neither tool bothers rebuilding the
      // prompt mid-turn.
      instruction: `Language changed to ${input.language}. Write the rest of this reply — and everything after it — in ${input.language}. Confirm in one short line, in the new language.`,
    };
  },
};
