import { z } from 'zod';
import { LOCALES } from '@capo/i18n/locale';
import { countTranslatable } from '../translation';
import { createProposal } from './propose';
import type { CapoTool } from './types';

export const translateCompanyDataInput = z.object({
  target_language: z
    .enum(LOCALES)
    .describe(
      'BCP-47 code the STORED data should be rewritten into. pt-PT = European Portuguese, es-ES = Spanish (Spain), en-US = American English.',
    ),
});

// UNGUARDED, and in the roster — the same shape as generate_plan, for the same
// reason. This is subtle enough to be worth stating plainly:
//
// A guarded tool does NOT reliably produce an approval card. runGuarded
// EXECUTES it whenever the model can quote the manager, and "traduz tudo para
// inglês" is trivially quotable — so making this guarded would rewrite the
// whole tenant with no confirmation at all, which is the opposite of what the
// guard is for. The pattern that always cards is a pair: an unguarded proposer
// (this) plus a guarded applier kept out of the roster (translate-apply.ts).
//
// A second, structural benefit falls out of that choice: because this tool is
// unguarded, toAiTools never gives it a `manager_instruction` field. The one
// tool whose entire subject is translation therefore cannot trip the
// translated-quote failure mode described in agent/prompts/language.ts.
export const translateCompanyData: CapoTool<z.infer<typeof translateCompanyDataInput>> = {
  name: 'translate_company_data',
  description:
    "Rewrite ALL of this company's stored data — task titles and descriptions, materials, job names, worker trades, saved notes — into another language, and switch the company's data language to it. Use when the manager wants the shared dashboard itself in another language (\"traduz tudo para inglês\", \"pon todo en español\"). Raises an approval card with exact counts and writes nothing itself; it is reversible for 30 days. This is NOT for changing the language you speak to him in — that is set_language.",
  inputSchema: translateCompanyDataInput,
  async execute(input, ctx) {
    if (input.target_language === ctx.locales.company) {
      return {
        status: 'error' as const,
        message: `Company data is already stored in ${input.target_language}. If he wants YOU to speak it, use set_language instead.`,
      };
    }

    const counts = await countTranslatable(ctx.db, ctx.companyId);
    if (counts.total === 0) {
      return {
        status: 'error' as const,
        message:
          'There is no stored data to translate yet. Use set_language if he only wants you to speak another language.',
      };
    }

    try {
      const created = await createProposal(ctx, 'apply_company_translation', {
        from_language: ctx.locales.company,
        to_language: input.target_language,
      });
      if (created.status === 'already_pending') return created;
      // Same shape as `propose` returns, so chat.tsx renders it as a
      // ProposalCard with no client-side change at all.
      return { status: 'proposed' as const, proposalId: created.proposalId, renderedText: created.renderedText };
    } catch (e) {
      return { status: 'error' as const, message: e instanceof Error ? e.message : String(e) };
    }
  },
};

export const translationTools = [translateCompanyData];
