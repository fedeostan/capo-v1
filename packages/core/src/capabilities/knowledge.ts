import { z } from 'zod';
import { embedQuery } from '../agent/embeddings';
import type { CapoTool } from './types';

export const knowledgeCategories = ['lei', 'regulamento', 'tecnica', 'material', 'fabricante'] as const;

export const searchKnowledgeInput = z.object({
  query: z
    .string()
    .min(3)
    .describe('Pergunta ou termos de pesquisa em português (ex.: "licença para demolir parede interior").'),
  category: z
    .enum(knowledgeCategories)
    .optional()
    .describe('Restringir a uma categoria: lei, regulamento, tecnica, material, fabricante.'),
});

// Read-only and unguarded: consulting the shared corpus never mutates state.
// Retrieval is hybrid (embedding + Portuguese FTS via the search_knowledge
// RPC) so paraphrases and exact legal terms both land.
export const searchKnowledge: CapoTool<z.infer<typeof searchKnowledgeInput>> = {
  name: 'search_knowledge',
  description:
    'Search the shared Portuguese construction knowledge base (laws like RJUE/RGEU, regulations, techniques, materials, manufacturer application guides). Returns excerpts with their source so you can cite it. Read-only. Use it before making any legal/regulatory or technical-spec claim.',
  inputSchema: searchKnowledgeInput,
  async execute(input, ctx) {
    const queryEmbedding = await embedQuery(input.query);
    const { data, error } = await ctx.db.rpc('search_knowledge', {
      // pgvector's wire format is the JSON-array string ("[0.1,0.2,…]").
      query_embedding: JSON.stringify(queryEmbedding),
      query_text: input.query,
      filter_category: input.category ?? undefined,
      match_count: 5,
    });
    if (error) throw new Error(`search_knowledge failed: ${error.message}`);
    if (!data || data.length === 0) {
      return {
        results: [],
        note: 'Nada encontrado na base de conhecimento sobre isto. Diz ao gerente que não tens fonte para confirmar — não inventes artigos nem normas.',
      };
    }
    return {
      results: data.map(r => ({
        source: `${r.document_title}${r.heading_path ? ` — ${r.heading_path}` : ''}`,
        category: r.category,
        content: r.content,
        source_ref: r.source_ref,
      })),
    };
  },
};

export const knowledgeTools = [searchKnowledge];
