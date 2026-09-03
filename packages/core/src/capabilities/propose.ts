import { z } from 'zod';
import type { Db } from '@capo/db/client';
import type { Locale, LocaleContext } from '@capo/i18n/locale';
import { events } from './cards';
import { renderProposal, RenderError } from './render';
import { taskTools } from './tasks';
import { jobTools } from './jobs';
import { workerTools } from './workers';
import { planApplyTools } from './plan-apply';
import { translationApplyTools } from './translate-apply';
import { rescheduleApplyTools } from './reschedule-apply';
import { jobPauseApplyTools } from './job-pause-apply';
import type { CapoTool, ToolContext } from './types';

// Every guarded write is proposable. propose imports the domain tool arrays
// directly (not the roster in index.ts) to avoid an import cycle. plan-apply,
// translate-apply, reschedule-apply and job-pause-apply are imported directly
// too (not plan.ts / translate.ts / reschedule-propose.ts / job-pause.ts,
// which themselves import createProposal from this file) for the same reason.
const proposable: CapoTool[] = [
  ...taskTools,
  ...jobTools,
  ...workerTools,
  ...planApplyTools,
  ...translationApplyTools,
  ...rescheduleApplyTools,
  ...jobPauseApplyTools,
].filter(t => t.guarded);

const actionNames = proposable.map(t => t.name) as [string, ...string[]];

export function getProposableTool(name: string): CapoTool | undefined {
  return proposable.find(t => t.name === name);
}

// ── the duplicate refusal (issue #124) ──────────────────────────────────────
//
// One request, one card. On 14 Aug two racing turns filed the same three
// add_worker cards twice, six seconds apart, the arguments differing only in
// the capitalisation of `trade` — independently regenerated, not replayed.
// #125's turn lock removes that mechanism; this is the defence in depth behind
// it: a lease can expire mid-turn, and a future code path could double-file
// without ever racing. It lives HERE because every proposal insert in the
// codebase goes through createProposalForCompany, so no caller can forget it.
//
// The twin test is deliberately narrow: same conversation, same action, same
// NORMALIZED args, against still-`pending` rows only. Normalization is a
// deep-stable serialization — object keys sorted, strings case-folded —
// because the live evidence shows regenerated args differ in case and nothing
// else. A different phone, date, id, extra or missing field is a DIFFERENT
// proposal and must never be swallowed; arrays stay order-sensitive for the
// same reason. Erring toward a second card is the safe direction.
//
// No unique constraint stands behind this (it would need a migration and a
// canonical-args column), so two turns racing past the SELECT can still file
// twins. That is #125's job; this check stops the sequential repeat.
function canonicalArgs(value: unknown): unknown {
  if (typeof value === 'string') return value.toLowerCase();
  if (Array.isArray(value)) return value.map(canonicalArgs);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      // JSON has no undefined: treat an explicitly-undefined key as absent so
      // zod output and its jsonb round-trip compare equal.
      if (source[key] !== undefined) out[key] = canonicalArgs(source[key]);
    }
    return out;
  }
  return value;
}

/** Stable case-insensitive fingerprint of a proposal's args. Exported for
 *  scripts/guard-check.mts, which pins what may and may not count as "the
 *  same card". */
export function proposalArgsKey(args: unknown): string {
  return JSON.stringify(canonicalArgs(args));
}

// Machine-facing, like the guard's reasons: fed back to the model, never shown
// to a manager. It must read as a settled state, not a failure — a model that
// reads this as an error will retry, and the retry is the bug.
const ALREADY_PENDING_MESSAGE =
  'Not created: an identical approval card already exists in this conversation and is WAITING for the manager to approve or reject it. Nothing failed — do not retry this call and do not raise the card again. Reply with one short line telling the manager the change is already waiting for their decision.';

export type CreateProposalResult =
  | { status: 'created'; proposalId: string; renderedText: string }
  | { status: 'already_pending'; proposalId: string; message: string };

/** Everything creating a proposal needs that is NOT a live conversation turn. */
export interface ProposalTarget {
  companyId: string;
  /** Null lands an orphaned card: still resolvable, but only surfaced by the
   *  chat page once the tenant has a thread. Callers outside a conversation
   *  should ensureConversation() first rather than pass null. */
  conversationId: string | null;
  /** The USER dial — the card is a sentence spoken to a human. */
  locale: Locale;
}

// Split out of createProposal because the web server actions have an
// AuthContext, not a ToolContext, and no conversation of their own. The wrong
// fix is to fabricate a ToolContext at the call site: `actor`, `userId` and
// `recentUserTexts` would all have to be invented, and recentUserTexts is the
// guard's evidence pool.
export async function createProposalForCompany(
  db: Db,
  target: ProposalTarget,
  actionName: string,
  args: unknown,
): Promise<CreateProposalResult> {
  const action = getProposableTool(actionName);
  if (!action) throw new Error(`Unknown proposable action: ${actionName}`);

  const parsed = action.inputSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid args for ${actionName}: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }

  // The duplicate refusal (see the top of this file). Before the render on
  // purpose — a refused card should not pay the render's lookups. Fails OPEN:
  // a broken read here may cost a duplicate card, never the card the manager
  // is waiting for. An orphaned card (null conversation) is never deduped —
  // "same conversation" is the boundary the refusal is defined on.
  if (target.conversationId) {
    try {
      const { data: twins, error } = await db
        .from('proposals')
        .select('id, action_args')
        .eq('company_id', target.companyId)
        .eq('conversation_id', target.conversationId)
        .eq('action_name', actionName)
        .eq('status', 'pending');
      if (error) throw new Error(error.message);
      const key = proposalArgsKey(parsed.data);
      const twin = (twins ?? []).find(row => proposalArgsKey(row.action_args) === key);
      if (twin) return { status: 'already_pending', proposalId: twin.id, message: ALREADY_PENDING_MESSAGE };
    } catch (err) {
      console.warn(
        JSON.stringify({
          evt: 'proposal.dedup_check_failed',
          companyId: target.companyId,
          actionName,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  const renderedText = await renderProposal(db, target.companyId, actionName, parsed.data, target.locale);

  const { data, error } = await db
    .from('proposals')
    .insert({
      company_id: target.companyId,
      conversation_id: target.conversationId,
      action_name: actionName,
      action_args: parsed.data,
      rendered_text: renderedText,
    })
    .select()
    .single();
  if (error) throw new Error(`Failed to store proposal: ${error.message}`);

  return { status: 'created', proposalId: data.id, renderedText };
}

export async function createProposal(
  ctx: ToolContext,
  actionName: string,
  args: unknown,
): Promise<CreateProposalResult> {
  return createProposalForCompany(
    ctx.db,
    {
      companyId: ctx.companyId,
      conversationId: ctx.conversationId || null,
      // ctx.locales.user, read at call time: set_language may have changed it
      // earlier in this same tool loop, and the card must follow.
      locale: ctx.locales.user,
    },
    actionName,
    args,
  );
}

export const propose: CapoTool<{ action_name: string; action_args: Record<string, unknown> }> = {
  name: 'propose',
  description:
    'Propose a write action for the manager to approve ("AI proposes, manager disposes"). Use whenever YOU are suggesting a change the manager did not explicitly command. The system renders the approval card from action_args — the card is the entire reply, so write no text at all in a turn that raises one.',
  inputSchema: z.object({
    action_name: z.enum(actionNames),
    action_args: z
      .record(z.string(), z.unknown())
      .describe('Arguments for the target action, matching its schema (WITHOUT manager_instruction)'),
  }),
  async execute(input, ctx) {
    try {
      const created = await createProposal(ctx, input.action_name, input.action_args);
      if (created.status === 'already_pending') return created;
      return { status: 'proposed' as const, proposalId: created.proposalId, renderedText: created.renderedText };
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
//
// ⚠ SERVICE-ROLE CALLERS MUST PRE-CHECK OWNERSHIP.
// This function does NOT verify that the proposal belongs to the caller's
// company. On the web path it does not have to: `db` is the RLS-scoped user
// client. On the WhatsApp path it is the service client, and finalize_proposal
// is SECURITY DEFINER scoped by `auth.uid() is null or company_id = …` — with
// the service role auth.uid() IS null, so that predicate short-circuits to
// true and enforces nothing. apps/web/app/api/whatsapp/route.ts therefore
// reads `proposals` filtered by company_id before calling this.
//
// The check is not folded in here because the not_pending lookup below is
// deliberately unscoped (RLS covers it on the web path): scoping only the CAS
// would turn every foreign proposal into `{ outcome: 'not_pending', status }`
// — an existence-and-status oracle. Move it inside once there is a second
// service-role caller and both queries can be scoped together.
export async function resolveProposal(
  db: Db,
  proposalId: string,
  decision: 'approve' | 'reject',
  locales: LocaleContext,
  // The dashboard address, for the ToolContext the approved tool runs in. A
  // REQUIRED parameter rather than a pinned placeholder: no proposal-executable
  // tool reads it today, and handing one a fabricated URL is exactly how that
  // stops being true silently, in a commit about something else. Same reasoning
  // as taking both language dials rather than only the user one.
  appUrl: string,
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
      // Structurally unreachable and pinned to the safe value anyway. Nothing
      // on this path consults it: the guard is what reads confirmPosture, and
      // the guard does not run here — the manager already tapped Approve, so
      // asking them to confirm again would be the same question twice. If some
      // future code DOES read it from an executing proposal, always_ask is the
      // answer that cannot cause an unconfirmed write. Never read the approver's
      // real posture here: it would let one manager's trust_quote setting change
      // what a card another manager is looking at does.
      confirmPosture: 'always_ask',
      appUrl,
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
