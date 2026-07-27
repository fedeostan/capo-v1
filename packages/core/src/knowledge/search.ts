// Hybrid retrieval over the shared Portuguese construction corpus.
//
// Extracted out of capabilities/knowledge.ts so the agent tool and the web UI
// share ONE definition of "how we search the corpus" — the same discipline the
// task_board view enforces for date buckets. The tool could not be reused
// directly: CapoTool.execute takes a ToolContext, which carries a
// conversationId and the guard's evidence pool. Those serve the agent loop; a
// page has neither.
//
// Retrieval is hybrid (embedding + Portuguese FTS via the search_knowledge
// RPC) so paraphrases and exact legal terms both land. The RPC is
// `security invoker` and knowledge_chunks_select_all grants `using (true)` to
// authenticated (migration 0012), so the RLS-scoped user client can call it —
// the corpus is deliberately global, with no company_id.
import type { Db } from '@capo/db/client';
import { embedQuery } from '../agent/embeddings';

export const knowledgeCategories = ['lei', 'regulamento', 'tecnica', 'material', 'fabricante'] as const;

export type KnowledgeCategory = (typeof knowledgeCategories)[number];

export interface KnowledgeHit {
  chunkId: string;
  /** "Document title — Heading path", ready to cite as-is. */
  source: string;
  category: string;
  content: string;
  sourceRef: string;
}

export interface KnowledgeSearchOptions {
  category?: KnowledgeCategory;
  matchCount?: number;
}

/**
 * NOTE on language: the corpus is Portuguese and the RPC ranks with
 * `websearch_to_tsquery('portuguese', …)`, so a non-Portuguese query silently
 * contributes nothing to the full-text half of the hybrid search — the
 * embedding half still works, since gemini-embedding-001 is multilingual.
 * Callers that build a query from stored tenant data (which is in
 * companies.language, not necessarily pt-PT) get degraded, not broken, ranking.
 */
export async function searchKnowledgeChunks(
  db: Db,
  query: string,
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeHit[]> {
  const queryEmbedding = await embedQuery(query);
  const { data, error } = await db.rpc('search_knowledge', {
    // pgvector's wire format is the JSON-array string ("[0.1,0.2,…]").
    query_embedding: JSON.stringify(queryEmbedding),
    query_text: query,
    filter_category: options.category ?? undefined,
    match_count: options.matchCount ?? 5,
  });
  if (error) throw new Error(`search_knowledge failed: ${error.message}`);
  return (data ?? []).map(row => ({
    chunkId: row.chunk_id,
    source: `${row.document_title}${row.heading_path ? ` — ${row.heading_path}` : ''}`,
    category: row.category,
    content: row.content,
    sourceRef: row.source_ref,
  }));
}
