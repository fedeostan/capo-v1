import { z } from 'zod';
import type { ConfirmPosture } from '@capo/db/posture';
import { createProposal } from './propose';
import type { CapoTool, ToolContext, GuardedResult } from './types';

// The structural safety boundary. "Manager disposes" does not rest on the
// model reliably choosing propose over a direct write: every direct write must
// carry the manager's verbatim words as evidence, checked here against what
// the manager actually said. Weak or missing evidence is downgraded to a
// proposal — never rejected, never silently executed. Worst case of a model
// slip is one extra approval card, not an unauthorized write.

export const managerInstructionField = {
  manager_instruction: z
    .string()
    .describe(
      "The manager's verbatim words (exact quote from their recent message) that explicitly authorize this write. Copy the quote exactly — never paraphrase, never fabricate. Omit if the manager did not explicitly command this.",
    )
    .optional(),
};

// ── FEDERICO (the safety dial of the product): how strictly must the model's
// quote match the manager's actual words? Current default: accent- and
// whitespace-insensitive substring match over the recent user messages.
// Stricter = more approval cards on genuine commands; looser = more risk of a
// write off a vague gesture. ──
export function matchesManagerInstruction(instruction: string, recentUserTexts: string[]): boolean {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const needle = normalize(instruction);
  if (needle.length < 4) return false;
  return recentUserTexts.some(t => normalize(t).includes(needle));
}

/** Why a guarded call was downgraded. Machine-facing: fed back to the model so
 *  it says the right thing about the card, never shown to a manager. */
export type GuardDecision =
  | { act: 'execute' }
  | { act: 'propose'; reason: string };

const NO_MATCH_REASON =
  'No verbatim manager authorization matched their recent messages — downgraded to a proposal awaiting approval. The card is now in front of the manager: do not retry the write, with or without a better quote — a direct write now would duplicate whatever the manager approves on the card.';

const ALWAYS_ASK_REASON =
  'This manager has confirmation set to always-ask, so every change is shown as an approval card before it happens — even one they just asked for in so many words. An approval card is waiting for them. This is their own setting, not a problem with the request: say nothing at all (the card is the whole reply), do not apologise for it, and do not retry the write.';

/**
 * The whole decision, as a pure function of the posture, the model's quote and
 * the evidence pool. No I/O, no clock, no database — deliberately, so it can be
 * asserted exhaustively by `pnpm guard-check` and so a guarded write can never
 * hang or fail on a lookup.
 *
 * ── the posture branch (issue #57) ──
 * `always_ask` does NOT tighten `matchesManagerInstruction`; it makes the match
 * irrelevant. The quote is not consulted at all, which is the point: under this
 * posture there is nothing the model can emit, correct or fabricated, that
 * produces a direct write. `trust_quote` is the behaviour that shipped before
 * 0031 and is preserved byte-for-byte below.
 *
 * The two postures share the property that matters: NEITHER can reject. The
 * worst outcome on either branch is one approval card the manager did not
 * strictly need.
 */
export function decideGuard(
  posture: ConfirmPosture,
  managerInstruction: string | undefined,
  recentUserTexts: string[],
): GuardDecision {
  if (posture === 'always_ask') return { act: 'propose', reason: ALWAYS_ASK_REASON };
  if (managerInstruction && matchesManagerInstruction(managerInstruction, recentUserTexts)) {
    return { act: 'execute' };
  }
  return { act: 'propose', reason: NO_MATCH_REASON };
}

export async function runGuarded(
  capoTool: CapoTool,
  rawInput: Record<string, unknown>,
  ctx: ToolContext,
): Promise<GuardedResult> {
  const { manager_instruction, ...args } = rawInput as { manager_instruction?: string } & Record<string, unknown>;

  // ctx.confirmPosture, never a lookup: the posture was resolved on the request
  // path from the profile that had already been read (getAuthState on the web,
  // resolveManager on WhatsApp). See ToolContext.confirmPosture.
  const decision = decideGuard(ctx.confirmPosture, manager_instruction, ctx.recentUserTexts);

  if (decision.act === 'execute') {
    const result = await capoTool.execute(capoTool.inputSchema.parse(args), { ...ctx, actor: 'manager' });
    return { status: 'executed', result };
  }

  const created = await createProposal(ctx, capoTool.name, args);
  // The identical card is already pending (issue #124): hand that straight to
  // the model — its message reads as settled, never as an error to retry. It
  // must NOT go out as 'proposed': that literal is what both channels render a
  // card from, and the point of the refusal is that no second card reaches the
  // manager.
  if (created.status === 'already_pending') return created;
  return { status: 'proposed', proposalId: created.proposalId, renderedText: created.renderedText, reason: decision.reason };
}
