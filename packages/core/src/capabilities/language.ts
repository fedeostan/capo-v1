import { z } from 'zod';
import { LOCALES } from '@capo/i18n/locale';
import type { CapoTool } from './types';

export const setLanguageInput = z.object({
  language: z
    .enum(LOCALES)
    .describe(
      'BCP-47 code. pt-PT = European Portuguese, es-ES = Spanish (Spain), en-US = American English.',
    ),
});

// UNGUARDED by design, and this is a deliberate exception rather than an
// oversight. The guard exists because writes change the real world — a task
// appears, a worker gets an SMS. This changes which words one person reads. It
// is fully reversible, invisible to everyone else, and putting an approval card
// in front of "talk to me in English" would be absurd.
//
// It writes ONLY the caller's own profiles.language. The COMPANY dial — which
// governs stored task and job text — is deliberately unreachable from chat:
// flipping it does not retranslate existing rows, so a casual "let's switch to
// English" would leave the shared dashboard permanently half-translated with no
// way back. That change lives in Settings, behind an explicit warning.
export const setLanguage: CapoTool<z.infer<typeof setLanguageInput>> = {
  name: 'set_language',
  description:
    'Change the language you speak to this manager in, when he asks for it ("from now on talk to me in English", "podes falar comigo em espanhol?"). Takes effect immediately, including in the reply you are writing right now. Does NOT change the language of stored tasks and jobs — if he wants that, tell him it is in Settings.',
  inputSchema: setLanguageInput,
  async execute(input, ctx) {
    // Null on the proposal-execution path. There is no live user to have a
    // language preference there, and on the WhatsApp path auth.uid() is null,
    // so this id is the only thing scoping the UPDATE to one row.
    if (!ctx.userId) {
      return { status: 'error' as const, message: 'No user identity in this context.' };
    }

    const { error } = await ctx.db.from('profiles').update({ language: input.language }).eq('id', ctx.userId);
    if (error) throw new Error(`set_language failed: ${error.message}`);

    // Mutate in place. `instructions` were assembled before this loop began, so
    // the persona block is stale for the rest of this turn — but ToolContext is
    // shared by reference across every tool in the loop, so a renderProposal
    // later in THIS turn already picks up the new language.
    ctx.locales.user = input.language;

    return {
      status: 'ok' as const,
      language: input.language,
      // The lever that makes the switch apply to the CURRENT reply rather than
      // the next one: the tool result is fresher context than the system prompt.
      instruction: `Language changed to ${input.language}. Write the rest of this reply — and everything after it — in ${input.language}. Confirm briefly, in the new language.`,
    };
  },
};

export const languageTools = [setLanguage];
