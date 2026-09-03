import { z } from 'zod';
import type { CapoTool, WorkerMessageResult } from './types';

// ── Capo can finally answer "diz ao Miguel que…" (issue #123) ───────────────
//
// THE BUG THIS FIXES WAS STRUCTURAL, NOT A MODEL FAILURE. A crew member asked
// for materials; the manager said "pergunta-lhes de que material precisam"; and
// Capo apologised and refused. It was right to refuse: until this tool landed
// there was NOTHING in the manager's roster that could put a single word in
// front of a crew member. Capo could read the board, write tasks and raise
// approval cards, and that was the whole of it. The crew persona's worked
// example and the worker policy both wrote the refusal down as a rule, and the
// rule was true.
//
// ── WHY THIS TOOL IS NOT GUARDED, WHICH IS THE DECISION IN THIS FILE ────────
//
// Guarding it looks obviously right: a write that reaches a real person's phone
// is exactly the kind of thing `confirm_posture` exists to slow down, and
// `always_ask` is the column default, so almost every manager would get an
// approval card showing the exact words before they went. That is a genuinely
// attractive property and it was the first design.
//
// It was rejected for ONE reason, and it is the reason this whole feature
// exists: on the approval path the manager cannot be told the truth about what
// happened. `resolveProposal` DISCARDS the executed tool's return value. What
// the manager is shown afterwards is `rendered_text` echoed back by
// `events.approved` in the web chat, and the flat `whatsapp.proposalApproved`
// sentence on WhatsApp. For every other tool in the roster that echo is honest
// by construction: the row was written or the proposal failed, and there is no
// third state. Here there IS a third state, and it is the common one. A send
// can degrade to a re-engagement nudge that carries none of the manager's
// words, or fail outright because a template is not approved yet, and the
// approval echo would report all three as done. That is the incident that
// caused this work, pointed the other way: a person believing their message
// went somewhere it did not.
//
// Unguarded, the tool's honest result comes back INSIDE the same turn, the
// model is holding it while it writes its reply, and the orchestration policy
// requires that reply to say which of the three things happened.
//
// What replaces the guard's protection, structurally rather than by prompt:
//
//   - ONE named crew member per call. There is no broadcast, no "the whole
//     crew" argument, and no loop. Reaching five people is five deliberate
//     calls the manager can see happening.
//   - CONSENT IS THE SAME GATE THE CRONS USE and it fails closed. A crew member
//     with no recorded opt-in (0025) receives nothing, and the manager is told
//     so rather than being left to assume it worked.
//   - THE TENANT BOUNDARY IS THE COMPANY ID, not the argument. `worker_id` is
//     looked up scoped to `ctx.companyId` by the delivery half, so a model that
//     invented or was fed another company's uuid reaches nobody.
//   - ONE PAID NUDGE PER PERSON PER DAY, enforced by `notification_log`'s
//     unique key rather than by a counter this file could get wrong.
//   - IT MUTATES NOTHING. No task moves, no date is erased, no row changes. The
//     worst outcome is a message the manager immediately corrects with another
//     one, which is how people already work.
//
// Revisit this if the proposal machinery ever grows a way to surface an
// executed tool's outcome to the manager. Then guarded becomes both safe and
// honest, and it is the better answer.
//
// ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
//
// It is not a chat relay and it is not `worker_requests` in reverse. The crew
// member's answer comes back the way it always has, through their own
// conversation with Capo and `ask_manager` (0043). Nothing here writes to
// `worker_messages`: this is a message to a phone, not a turn in that thread.

/**
 * The ceiling on one relayed message.
 *
 * Meta's free-form body limit is 4096 and `splitForWhatsApp` would chunk
 * anything longer, so this is not a transport limit. It is a PRODUCT one: what
 * arrives on a crew member's phone mid-morning has to be readable in one glance
 * on a building site. Anything approaching an essay is a conversation the
 * manager should be having, not a note Capo should be carrying.
 */
export const MAX_CREW_MESSAGE_CHARS = 700;

export const messageWorkerInput = z.object({
  worker_id: z
    .string()
    .uuid()
    .describe('Who to write to. One person. Use list_workers to find ids.'),
  message: z
    .string()
    .min(1)
    .max(MAX_CREW_MESSAGE_CHARS)
    .describe(
      "What to say, in the crew member's own language, written as the manager would say it. Keep it to what fits on a phone screen. Do not sign it and do not add a greeting: Capo already says who it is from.",
    ),
});

export const messageWorker: CapoTool<z.infer<typeof messageWorkerInput>> = {
  name: 'message_worker',
  description: [
    'Send a WhatsApp message to ONE crew member, from the manager, right now.',
    'Use it when the manager asks you to tell, ask or remind somebody something ("diz ao Miguel que...", "pergunta-lhes de que material precisam", "avisa a Ana que a obra parou").',
    'It reaches them immediately when they are already in a conversation with Capo. When they are not, WhatsApp only lets Capo knock: a short standard message goes out asking them to reply, and YOUR WORDS DO NOT GO WITH IT.',
    'The result says which of those happened. Tell the manager plainly, in one line, and never say a message was delivered when the result says it was not.',
    'It changes nothing on the board. To give somebody work, create or update a task instead.',
  ].join(' '),
  inputSchema: messageWorkerInput,
  // Unguarded. See the long note at the top of this file: guarded would make
  // this an approval card, and on that path the manager cannot be told what
  // actually happened.
  guarded: false,
  async execute(input, ctx): Promise<WorkerMessageResult> {
    // No channel wired up on this call site. Reported as a fact rather than
    // thrown: a throw becomes a tool error the model narrates as a breakage,
    // and "I cannot reach the crew from here" is a state, not a fault.
    if (!ctx.messageWorker) return { outcome: 'not_delivered', reason: 'channel_unavailable' };

    // Everything else is the injected messenger's job, and that is the point of
    // the seam rather than a thin wrapper for its own sake: the addressing
    // preference, the consent partition, the free-form window and the crew
    // member's own copy all live in apps/web and exist in exactly one copy
    // each. `ctx.companyId` is what scopes the lookup, so a worker_id from
    // anywhere else resolves to nobody.
    return await ctx.messageWorker({
      companyId: ctx.companyId,
      workerId: input.worker_id,
      text: input.message,
    });
  },
};

export const crewMessageTools = [messageWorker];
