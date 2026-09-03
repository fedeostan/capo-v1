import type { z } from 'zod';
import type { Db } from '@capo/db/client';
import type { ConfirmPosture } from '@capo/db/posture';
import type { LocaleContext } from '@capo/i18n/locale';

/**
 * WHAT ACTUALLY HAPPENED when Capo tried to put the manager's words in front of
 * a crew member. The three values are not degrees of success: only ONE of them
 * means the person has the words.
 *
 *   'sent'    the crew member is inside their own 24-hour WhatsApp window, so
 *             an ordinary free-form message went out. Free, immediate, and the
 *             words were delivered verbatim.
 *   'nudged'  they are OUTSIDE it, so free-form is refused by Meta outright
 *             (131047) and the only legal contact is a pre-approved template.
 *             `capo_message_waiting` went out, and it is a WINDOW REOPENER: its
 *             frozen body says somebody has a message waiting and asks them to
 *             reply. THE WORDS THEMSELVES HAVE NOT BEEN DELIVERED.
 *   'not_delivered'  nothing reached them at all.
 *
 * The whole reason this is an enum rather than a boolean is 'nudged'. It is the
 * value a summary would round up to "sent", and rounding it up recreates the
 * exact failure this feature exists to end: somebody believing their message
 * went somewhere it did not.
 */
export type WorkerMessageOutcome = 'sent' | 'nudged' | 'not_delivered';

/** Why nothing was delivered, or why the nudge was all that was possible.
 *  Machine-facing: fed back to the model, never shown to a manager verbatim. */
export type WorkerMessageReason =
  /** The crew row is not active. */
  | 'inactive'
  /** No phone and no stored BSUID: there is no way to address them at all. */
  | 'unreachable'
  /** No recorded WhatsApp opt-in, or they opted out. Fails closed (0025). */
  | 'no_consent'
  /** No such crew member in THIS company. */
  | 'worker_not_found'
  /** The channel is not wired up on this call site. */
  | 'channel_unavailable'
  /** The free-form send itself failed. */
  | 'send_failed'
  /** The re-engagement template was refused by Meta. The commonest cause is
   *  132001: the template is not approved in that person's language yet. */
  | 'template_failed'
  /** A re-engagement template already went out to this person today, and they
   *  have still not replied. One paid nudge per person per day is the cap
   *  notification_log's unique key enforces. */
  | 'already_nudged_today';

export interface WorkerMessageResult {
  outcome: WorkerMessageOutcome;
  reason?: WorkerMessageReason;
  /** workers.name, so the model can name the person without a second lookup. */
  workerName?: string;
}

/** See ToolContext.messageWorker. */
export type WorkerMessenger = (input: {
  companyId: string;
  workerId: string;
  text: string;
}) => Promise<WorkerMessageResult>;

export interface ToolContext {
  companyId: string;
  conversationId: string;
  db: Db;
  // Who is causing this write: 'manager' for guard-passed direct commands,
  // 'capo' when a proposal is executed after approval. Recorded as tasks.source.
  actor: 'manager' | 'capo';
  // Verbatim recent user messages (newest last) — the evidence pool the guard
  // checks manager_instruction against.
  recentUserTexts: string[];
  // profiles.id of the human on the other end. Null when a proposal is executed
  // after approval — there is no live user in that path.
  //
  // Required for any per-user write: on the WhatsApp path the client is the
  // service role, so auth.uid() is null and RLS cannot scope the row. This id
  // is the ONLY filter standing between "update my language" and "update
  // everyone's language".
  userId: string | null;
  // profiles.confirm_posture (0031) — 'always_ask' turns every guarded write
  // into an approval card; 'trust_quote' keeps the pre-0031 behaviour of acting
  // immediately on a verified verbatim quote. Read by runGuarded and by nothing
  // else.
  //
  // REQUIRED, NOT OPTIONAL, and that is the whole reason it is on this type at
  // all rather than being looked up where it is used. A `confirmPosture?:` with
  // a default would make "somebody added a ToolContext call site and forgot the
  // posture" fall back to the RISKIER behaviour, silently, in a commit about
  // something else. As a required field it is a tsc error instead. Structural
  // safety over convention (AGENTS.md).
  confirmPosture: ConfirmPosture;
  // Where this manager's dashboard lives, e.g. https://www.construcapo.com.
  // `finish_onboarding` hands it to the manager at the end of the setup
  // conversation, which is the first time the product ever tells him the
  // dashboard exists.
  //
  // REQUIRED for the same reason confirmPosture is. `packages/core` reads no
  // environment by contract, so an optional field with a fallback would resolve
  // to a link to localhost or to an empty string — a dead link is worse than no
  // link, and nothing in a build could notice. Required makes a forgotten call
  // site a tsc error.
  //
  // WorkerContext must never gain this: a crew member has no dashboard, and
  // handing one a manager URL is an invitation to a screen they cannot open.
  appUrl: string;
  // The one seam through which a manager tool may put words in front of a real
  // crew member (issue #123). INJECTED as a function rather than as a channel
  // config, for two reasons that both come from where things live:
  //
  //   - the addressing rule (`recipientFor`: phone first, BSUID second) and the
  //     consent gate (`partitionCrew`) live in apps/web and must stay in ONE
  //     copy. AGENTS.md is explicit that two copies of an addressing or consent
  //     rule eventually disagree, and the symptom is a person one send reaches
  //     and another silently skips. Handing this package a WhatsApp config
  //     would mean reimplementing both here.
  //   - the crew member's own copy comes from @capo/i18n/catalog, which must
  //     never enter the agent bundle.
  //
  // REQUIRED and NULLABLE, deliberately. Nullable because a call site with no
  // channel is a real state (a future channel, a script); required because a
  // `messageWorker?:` would let a new call site lose the ability to reach the
  // crew silently, in a commit about something else. Null is the SAFE
  // direction here: the tool reports that it could not send, and never claims
  // it did.
  //
  // WorkerContext must never gain this field. A crew member with a way to make
  // Capo message another crew member on the manager's behalf is an escalation,
  // and the two context types are mutually unassignable so that tsc refuses it.
  messageWorker: WorkerMessenger | null;
  // MUTABLE BY DESIGN. set_language rewrites `locales.user` in place so that a
  // renderProposal later in the SAME tool loop produces its card in the new
  // language. runGuarded's `{ ...ctx, actor: 'manager' }` is a shallow copy, so
  // the object reference — and therefore the mutation — survives it.
  locales: LocaleContext;
}

// The roster contract. Adding a capability = one file exporting CapoTools plus
// a registry entry in index.ts. If adding a tool requires touching the agent
// core loop, the design has failed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface CapoTool<In = any, Out = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<In>;
  // Guarded tools mutate domain state: they require verbatim manager
  // authorization (manager_instruction) and are downgraded to a proposal by
  // the guard when the evidence is missing or does not match.
  guarded?: boolean;
  execute(input: In, ctx: ToolContext): Promise<Out>;
}

export type GuardedResult =
  | { status: 'executed'; result: unknown }
  | { status: 'proposed'; proposalId: string; renderedText: string; reason: string }
  // Issue #124: the card this call would have raised already exists and is
  // still pending on this conversation, so nothing was created. Deliberately
  // NOT 'proposed' — both channels key their card rendering on that literal
  // (asProposalOutput in channels/whatsapp.ts, proposalFromPart in
  // apps/web/app/chat.tsx), and the point of the refusal is that no second
  // card reaches the manager.
  | { status: 'already_pending'; proposalId: string; message: string };
