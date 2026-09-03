import { z } from 'zod';
import { loadCompanySnapshot, missingOnboardingItems } from '../agent/context';
import type { CapoTool } from './types';

// The two tools that make the initial setup conversation finishable.
//
// Before them, "is this manager still being onboarded?" was inferred from row
// counts on every turn, and the inference switched itself off the moment one
// obra and one worker existed. A manager who had answered two questions was
// treated as fully set up, so Capo said "done" and stopped. Migration 0046 turns
// that inference into a recorded fact, and these are the only two things that
// write it.
//
// BOTH ARE UNGUARDED, which is a deliberate exception to the rule that a write
// needs a verbatim manager quote or an approval card. The guard exists to stop
// Capo changing the BUSINESS on a manager's behalf: creating jobs, moving dates,
// messaging the crew. Neither of these does any of that.
//
//   set_company_about   writes one sentence the manager just said about his own
//                       business. It creates nothing, schedules nothing and
//                       messages nobody.
//   finish_onboarding   stamps a timestamp on the company's own row, which
//                       stops a checklist appearing in Capo's context. Its only
//                       observable effect is that Capo stops asking.
//
// The stronger argument is what guarding them would COST. Under the product
// default (`always_ask`, 0031) every guarded write becomes an approval card, so
// the very first thing a brand new manager would meet, before he has any idea
// what an approval card is, would be a card asking him to confirm the sentence
// he had just typed. The onboarding conversation would be made of them.

/**
 * Postgres' "column does not exist". It is what BOTH tools get if this code is
 * live and migration 0046 has not been applied yet, which on this repository is
 * a real window rather than a theoretical one (0038 sat merged and unapplied
 * for three weeks). Left unhandled the model receives a raw driver error and
 * will retry it; named, it is told plainly that the feature is not switched on
 * yet, so it can carry on with the conversation instead.
 */
const UNDEFINED_COLUMN = '42703';

function missingColumnError(tool: string, error: { code?: string; message: string }): Error | null {
  if (error.code !== UNDEFINED_COLUMN) return null;
  return new Error(
    `${tool} is not available yet: the onboarding columns (migration 0046) are not in the database. Carry on with the conversation and do not call it again.`,
  );
}

export const setCompanyAboutInput = z.object({
  about: z
    .string()
    .min(1)
    .max(600)
    .describe(
      "What this company does, in the manager's own words: the kind of work they take on, what they are working on now. One or two sentences, written in the company's domain language (see the Language policy in your instructions). Replaces whatever was stored before, so include what still applies rather than only the new part.",
    ),
});

export const setCompanyAbout: CapoTool<z.infer<typeof setCompanyAboutInput>> = {
  name: 'set_company_about',
  description:
    'Record what this company does, from what the manager just told you. Call it as soon as he describes the business, during the initial setup or later if he corrects it. Unguarded: it stores his own description of his own business and changes nothing else.',
  inputSchema: setCompanyAboutInput,
  async execute(input, ctx) {
    const { data, error } = await ctx.db
      .from('companies')
      .update({ about: input.about })
      .eq('id', ctx.companyId)
      // Nothing else in the row is readable back through this grant, and the
      // model has no use for it. `.select('id')` also makes a filter that
      // matched nothing distinguishable from a successful write, which is the
      // billing webhook's lesson (a zero-row UPDATE is a fully successful
      // statement in Postgres, not an error).
      .select('id')
      .maybeSingle();
    if (error) throw missingColumnError('set_company_about', error) ?? new Error(`set_company_about failed: ${error.message}`);
    if (!data) throw new Error('set_company_about failed: company not found');
    return { about: input.about };
  },
};

export const finishOnboarding: CapoTool<Record<string, never>> = {
  name: 'finish_onboarding',
  description:
    'Declare the initial setup complete and get the address of the manager dashboard to share with him. Only call this once every item on the setup checklist is present. If something is still missing the call fails and tells you what: ask for that instead, do not call it again until it is there.',
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    // Re-read rather than trust the checklist rendered into the prompt at the
    // top of the turn. The turn itself may have created the last obra or the
    // last task, and a model that decides "that is everything" one call too
    // early would otherwise close the setup with a gap in it. The snapshot is
    // the same loader the prompt block uses, so the tool and the conversation
    // can never disagree about what is missing.
    const snapshot = await loadCompanySnapshot(ctx.db, ctx.companyId);
    if (!snapshot) throw new Error('finish_onboarding failed: could not read the company');

    // `undefined`, not null: the column is not in the database yet. Answered
    // before the checklist, because on that deploy there is nothing to stamp and
    // no block asking for one either (buildOnboardingBlock reads the same three
    // states and renders the pre-0046 product).
    if (snapshot.onboardedAt === undefined) {
      throw new Error(
        'finish_onboarding is not available yet: the onboarding columns (migration 0046) are not in the database. Carry on with the conversation and do not call it again.',
      );
    }

    if (snapshot.onboardedAt !== null) {
      // Already finished. Not an error: the honest answer is the link, because
      // the manager asking again is a manager who wants the link again.
      return { status: 'already_finished' as const, dashboard_url: ctx.appUrl };
    }

    const missing = missingOnboardingItems(snapshot);
    if (missing.length > 0) {
      // Returned rather than thrown, so the model reads it as an instruction to
      // carry on asking rather than as a broken tool. Item KEYS, not sentences:
      // the block in its context already says what each one means, in the
      // manager's own language, and a second wording here would be a second
      // definition of the same checklist.
      return { status: 'not_ready' as const, missing };
    }

    const { data, error } = await ctx.db
      .from('companies')
      .update({ onboarded_at: new Date().toISOString() })
      .eq('id', ctx.companyId)
      // Only stamp a company that is not stamped yet. Two turns racing to
      // finish would otherwise move the date, and `onboarded_at` is meant to
      // record when the setup ENDED, once.
      .is('onboarded_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw missingColumnError('finish_onboarding', error) ?? new Error(`finish_onboarding failed: ${error.message}`);
    // Nothing matched, which after the read above means somebody else stamped
    // the company in between. That is a race, not a failure: the honest answer
    // is the same one an already-finished company gets, because the setup is in
    // fact finished and the manager is waiting for a link.
    if (!data) return { status: 'already_finished' as const, dashboard_url: ctx.appUrl };

    return { status: 'finished' as const, dashboard_url: ctx.appUrl };
  },
};

export const onboardingTools = [setCompanyAbout, finishOnboarding];
