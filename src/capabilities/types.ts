import type { z } from 'zod';
import type { Db } from '@/src/db/client';

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
