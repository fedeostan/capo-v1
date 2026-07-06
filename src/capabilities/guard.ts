import { z } from 'zod';
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

export async function runGuarded(
  capoTool: CapoTool,
  rawInput: Record<string, unknown>,
  ctx: ToolContext,
): Promise<GuardedResult> {
  const { manager_instruction, ...args } = rawInput as { manager_instruction?: string } & Record<string, unknown>;

  if (manager_instruction && matchesManagerInstruction(manager_instruction, ctx.recentUserTexts)) {
    const result = await capoTool.execute(capoTool.inputSchema.parse(args), { ...ctx, actor: 'manager' });
    return { status: 'executed', result };
  }

  const { proposalId, renderedText } = await createProposal(ctx, capoTool.name, args);
  return {
    status: 'proposed',
    proposalId,
    renderedText,
    reason:
      'No verbatim manager authorization matched their recent messages — downgraded to a proposal awaiting approval.',
  };
}
