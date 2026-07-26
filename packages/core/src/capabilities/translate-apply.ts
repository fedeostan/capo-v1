import { z } from 'zod';
import { LOCALES } from '@capo/i18n/locale';
import { createTranslationBatch } from '../translation';
import type { CapoTool } from './types';

// Split out of translate.ts for exactly the reason plan-apply.ts was split out
// of plan.ts: propose.ts must import this proposable tool, and translate.ts
// imports createProposal from propose.ts — importing it from there would be a
// cycle.

export const applyCompanyTranslationInput = z.object({
  from_language: z.enum(LOCALES).describe("The company's current data language."),
  to_language: z.enum(LOCALES).describe('The language all stored data should be rewritten into.'),
});

// NOT in the roster (index.ts) — only in propose.ts's `proposable` array. It is
// reachable exclusively by the manager approving a card, never by the model
// calling it. Being `guarded` on top of that is belt and braces: if it were
// ever added to the roster by mistake, the guard would still demand verbatim
// authorization rather than letting a stray call rewrite the tenant.
//
// Note what this does NOT do: any model work. resolveProposal runs from a route
// with a modest duration budget, so this only snapshots and queues. The actual
// translating happens later in runTranslationBatch, driven by the batch row.
export const applyCompanyTranslation: CapoTool<z.infer<typeof applyCompanyTranslationInput>> = {
  name: 'apply_company_translation',
  description:
    "Rewrite all of this company's stored data into another language and switch the company's data language to it. Only ever runs via an approved proposal — never call this directly.",
  inputSchema: applyCompanyTranslationInput,
  guarded: true,
  async execute(input, ctx) {
    // renderProposal already re-checked this on the approval path; re-checking
    // here means the invariant holds even if this is ever called another way.
    const { data: company } = await ctx.db
      .from('companies')
      .select('language')
      .eq('id', ctx.companyId)
      .maybeSingle();
    if (!company) throw new Error('apply_company_translation: company not found');
    if (company.language !== input.from_language) {
      throw new Error(
        `apply_company_translation: company language is ${company.language}, not ${input.from_language}`,
      );
    }

    const { batchId, itemCount } = await createTranslationBatch({
      db: ctx.db,
      companyId: ctx.companyId,
      // Null on this path by definition — an approval click is not a
      // conversation turn. translation_batches.created_by is nullable for it.
      userId: ctx.userId,
      from: input.from_language,
      to: input.to_language,
      origin: 'chat',
    });

    // batchId travels out through resolveProposal's `result` and the proposals
    // route's JSON response, which is how the browser knows to start polling.
    return { batchId, itemCount, from: input.from_language, to: input.to_language };
  },
};

export const translationApplyTools = [applyCompanyTranslation];
