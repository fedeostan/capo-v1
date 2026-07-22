import { google } from '@ai-sdk/google';
import { embed, embedMany } from 'ai';

// The embedding seam — the models.ts idea applied to embeddings (kept out of
// that registry because its type is LanguageModel). Every embedding in the
// system MUST come from here: the vectors in knowledge_chunks and the query
// vectors compared against them live in the same space only while model,
// dimensionality, and task types stay in lockstep. Changing any of these
// requires re-ingesting the whole corpus.
//
// gemini-embedding-001: multilingual (pt-PT), same Google API key as the
// transcription role. 1536 dims to fit pgvector's HNSW 2000-dim cap; cosine
// ranking is scale-invariant, so the truncated vectors need no re-norm.
export const EMBEDDING_DIMS = 1536;

const embeddingModel = () => google.textEmbedding('gemini-embedding-001');

// Asymmetric retrieval: queries and documents get different task types —
// Google tunes the geometry so short questions land near long passages.
export async function embedQuery(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: embeddingModel(),
    value: text,
    providerOptions: { google: { outputDimensionality: EMBEDDING_DIMS, taskType: 'RETRIEVAL_QUERY' } },
  });
  return embedding;
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({
    model: embeddingModel(),
    values: texts,
    providerOptions: { google: { outputDimensionality: EMBEDDING_DIMS, taskType: 'RETRIEVAL_DOCUMENT' } },
  });
  return embeddings;
}
