import { z } from 'zod';
import { knowledgeCategories, searchKnowledgeChunks } from '../knowledge/search';
import type { CapoTool } from './types';

export { knowledgeCategories };

export const searchKnowledgeInput = z.object({
  query: z
    .string()
    .min(3)
    .describe(
      // The one field whose language is FIXED rather than following a dial: the
      // corpus is Portuguese and search_knowledge ranks with
      // websearch_to_tsquery(\'portuguese\', …), so a non-Portuguese query
      // silently contributes nothing to the full-text half of the hybrid search.
      'Search question or terms, ALWAYS written in Portuguese regardless of the conversation language — the corpus and its full-text ranking are Portuguese (e.g. "licença para demolir parede interior"). Translate the excerpt when you cite it back.',
    ),
  category: z
    .enum(knowledgeCategories)
    .optional()
    .describe('Restrict to one category: lei, regulamento, tecnica, material, fabricante.'),
});

// Read-only and unguarded: consulting the shared corpus never mutates state.
// Retrieval itself lives in ../knowledge/search.ts, shared with the web UI's
// task help panel — one definition of how the corpus is searched.
export const searchKnowledge: CapoTool<z.infer<typeof searchKnowledgeInput>> = {
  name: 'search_knowledge',
  description:
    'Search the shared Portuguese construction knowledge base (laws like RJUE/RGEU, regulations, techniques, materials, manufacturer application guides). Returns excerpts with their source so you can cite it. Read-only. Use it before making any legal/regulatory or technical-spec claim.',
  inputSchema: searchKnowledgeInput,
  async execute(input, ctx) {
    const hits = await searchKnowledgeChunks(ctx.db, input.query, { category: input.category });
    if (hits.length === 0) {
      return {
        results: [],
        // Model-facing instruction, not user copy: the model renders the
        // outcome to the manager in his own language.
        note: 'Nothing found in the knowledge base on this. Tell the manager you have no source to confirm it — never invent article numbers or standards.',
      };
    }
    return {
      results: hits.map(hit => ({
        source: hit.source,
        category: hit.category,
        content: hit.content,
        source_ref: hit.sourceRef,
      })),
    };
  },
};

export const knowledgeTools = [searchKnowledge];
