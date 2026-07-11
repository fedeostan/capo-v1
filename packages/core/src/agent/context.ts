import type { Db } from '@capo/db/client';
import persona from './persona/capo.pt-PT';
import orchestration from './prompts/orchestration';

// System prompt assembly: persona (voice) ⊕ orchestration (policy) ⊕ today's
// date ⊕ durable memories ⊕ conversation summary. Persona and policy live in
// separate files on purpose — iterate voice without touching logic. Both are
// bundled TS modules, so the prompt travels with the package regardless of
// cwd or deploy layout.

export async function buildSystemPrompt(db: Db, companyId: string, summary: string | null): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);

  // Memory tier 2 (durable/semantic), injected wholesale — trivially fits at
  // one-company scale. A recall tool comes when this outgrows context.
  const { data: memories } = await db
    .from('memories')
    .select('kind, content, created_at')
    .eq('company_id', companyId)
    .eq('active', true)
    .order('created_at');

  const memoryBlock =
    memories && memories.length > 0
      ? memories.map(m => `- [${m.kind}] (${m.created_at.slice(0, 10)}) ${m.content}`).join('\n')
      : '(sem memórias guardadas ainda)';

  return [
    persona,
    orchestration,
    `# Today's date\n${today}`,
    `# Durable memory (facts stored across conversations)\n${memoryBlock}`,
    summary ? `# Summary of the conversation so far\n${summary}` : null,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');
}
