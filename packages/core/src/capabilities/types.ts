import type { z } from 'zod';
import type { Db } from '@capo/db/client';
import type { ConfirmPosture } from '@capo/db/posture';
import type { LocaleContext } from '@capo/i18n/locale';

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
  | { status: 'proposed'; proposalId: string; renderedText: string; reason: string };
