import { z } from 'zod';
import type { Db } from '@capo/db/client';
import type { LocaleContext } from '@capo/i18n/locale';
import { events } from './cards';
import { renderProposal, RenderError } from './render';
import { taskTools } from './tasks';
import { jobTools } from './jobs';
import { workerTools } from './workers';
import { planApplyTools } from './plan-apply';
import { translationApplyTools } from './translate-apply';
import type { CapoTool, ToolContext } from './types';

// Every guarded write is proposable. propose imports the domain tool arrays
// directly (not the roster in index.ts) to avoid an import cycle. plan-apply
// and translate-apply are imported directly too (not plan.ts / translate.ts,
// which themselves import createProposal from this file) for the same reason.
const proposable: CapoTool[] = [
  ...taskTools,
  ...jobTools,
  ...workerTools,
  ...planApplyTools,
  ...translationApplyTools,
].filter(t => t.guarded);

const actionNames = proposable.map(t => t.name) as [string, ...string[]];

export function getProposableTool(name: string): CapoTool | undefined {
  return proposable.find(t => t.name === name);
}

export async function createProposal(
  ctx: ToolContext,
  actionName: string,
  args: unknown,
): Promise<{ proposalId: string; renderedText: string }> {
  const target = getProposableTool(actionName);
  if (!target) throw new Error(`Unknown proposable action: ${actionName}`);

  const parsed = target.inputSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid args for ${actionName}: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }

  // ctx.locales.user, read at call time: set_language may have changed it
  // earlier in this same tool loop, and the card must follow.
  const renderedText = await renderProposal(ctx.db, ctx.companyId, actionName, parsed.data, ctx.locales.user);

  const { data, error } = await ctx.db
    .from('proposals')
    .insert({
      company_id: ctx.companyId,
      conversation_id: ctx.conversationId,
      action_name: actionName,
      action_args: parsed.data,
      rendered_text: renderedText,
    })
    .select()
    .single();
  if (error) throw new Error(`Failed to store proposal: ${error.message}`);

  return { proposalId: data.id, renderedText };
}

export const propose: CapoTool<{ action_name: string; action_args: Record<string, unknown> }> = {
  name: 'propose',
  description:
    'Propose a write action for the manager to approve ("AI proposes, manager disposes"). Use whenever YOU are suggesting a change the manager did not explicitly command. The system renders the approval card from action_args — never restate its contents in your own words.',
  inputSchema: z.object({
    action_name: z.enum(actionNames),
    action_args: z
      .record(z.string(), z.unknown())
      .describe('Arguments for the target action, matching its schema (WITHOUT manager_instruction)'),
  }),
  async execute(input, ctx) {
    try {
      const { proposalId, renderedText } = await createProposal(ctx, input.action_name, input.action_args);
      return { status: 'proposed' as const, proposalId, renderedText };
    } catch (e) {
      // Return the failure to the model so it can fix the args (e.g. wrong id).
      return { status: 'error' as const, message: e instanceof Error ? e.message : String(e) };
    }
  },
};

export type ProposalResolution =
  | { outcome: 'approved'; renderedText: string; result: unknown }
  | { outcome: 'rejected'; renderedText: string }
  | { outcome: 'failed'; renderedText: string; reason: string }
  | { outcome: 'not_pending'; status: string };

// Deterministic execution of a manager decision — no model in the loop. What
// the manager approved (the stored action_args) is exactly what runs, after
// re-validation: the target schema is re-run and referenced rows re-checked,
// because the world may have changed between propose and approve.
//
// Race/atomicity guarantees:
// - Claim is a compare-and-set (pending → executing): concurrent clicks on the
//   same proposal can never both execute — losers see not_pending.
// - The final status flip + resolution event are one transaction
//   (finalize_proposal in Postgres), so 'approved' always comes with its event.
// - A crash mid-execution leaves 'executing': never a duplicate execution, and
//   retries are refused as not_pending.
//
// `locales.user` governs the resolution event written into the thread and any
// RenderError surfaced as a failure reason. It does NOT retranslate
// row.rendered_text — that card was frozen in whatever language it was created
// in, which is why a card can outlive a language switch.
//
// Both dials are taken (rather than just the user one) because the executed
// tool receives a ToolContext: no proposal-executable tool reads the company
// dial today, but handing one a fabricated value is how that stops being true
// silently. The caller has both for free from AuthContext.
export async function resolveProposal(
  db: Db,
  proposalId: string,
  decision: 'approve' | 'reject',
  locales: LocaleContext,
): Promise<ProposalResolution> {
  const e = events[locales.user];
  const { data: row } = await db
    .from('proposals')
    .update({ status: 'executing' })
    .eq('id', proposalId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();

  if (!row) {
    const { data: existing } = await db.from('proposals').select('status').eq('id', proposalId).maybeSingle();
    if (!existing) throw new Error(`Proposal not found: ${proposalId}`);
    return { outcome: 'not_pending', status: existing.status };
  }

  const finalize = async (status: 'approved' | 'rejected' | 'failed', eventText: string) => {
    const { error } = await db.rpc('finalize_proposal', {
      p_id: proposalId,
      p_status: status,
      p_event: eventText,
    });
    if (error) throw new Error(`Failed to finalize proposal: ${error.message}`);
  };

  if (decision === 'reject') {
    await finalize('rejected', e.rejected(row.rendered_text));
    return { outcome: 'rejected', renderedText: row.rendered_text };
  }

  const fail = async (reason: string): Promise<ProposalResolution> => {
    await finalize('failed', e.failed(row.rendered_text, reason));
    return { outcome: 'failed', renderedText: row.rendered_text, reason };
  };

  const target = getProposableTool(row.action_name);
  if (!target) return fail(e.unknownAction(row.action_name));

  const parsed = target.inputSchema.safeParse(row.action_args);
  if (!parsed.success) return fail(e.staleArgs);

  try {
    // Referential re-check: re-rendering re-resolves every referenced row. The
    // text is discarded — only the lookups (and their RenderErrors) matter here.
    await renderProposal(db, row.company_id, row.action_name, parsed.data, locales.user);
    const ctx: ToolContext = {
      companyId: row.company_id,
      conversationId: row.conversation_id ?? '',
      db,
      actor: 'capo',
      recentUserTexts: [],
      // No live user: this runs from an approval click, not a conversation turn.
      // Any tool needing a userId must handle null rather than assume one.
      userId: null,
      locales,
    };
    const result = await target.execute(parsed.data, ctx);
    await finalize('approved', e.approved(row.rendered_text));
    return { outcome: 'approved', renderedText: row.rendered_text, result };
  } catch (e) {
    const reason = e instanceof RenderError ? e.message : e instanceof Error ? e.message : String(e);
    return fail(reason);
  }
}
