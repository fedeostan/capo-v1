import { z } from 'zod';
import { knowledgeCategories, searchKnowledgeChunks } from '../../knowledge/search';
import type { WorkerTool } from './types';

// The crew's half of the shared construction library — and the most valuable
// thing in this roster.
//
// A worker on site with a question ("que cola levo nisto?", "quanto tempo tem
// de curar antes de eu assentar por cima?") has, today, two options: phone the
// manager, or guess. Capo has had the answer the whole time and no way to hand
// it over.
//
// The corpus is GLOBAL and operator-curated, with no company_id at all
// (0012:1-6). There is nothing tenant-specific in it to leak, which is why this
// is the one manager capability a worker gets in full rather than in a narrowed
// form. `search_knowledge` (../knowledge.ts) is a separate CapoTool over the
// same retrieval function; this is not a wrapper around that tool, it is a
// second caller of `searchKnowledgeChunks` — the same discipline that keeps the
// web UI's help panel from re-deriving how the corpus is searched.

export const workerSearchKnowledgeInput = z.object({
  query: z
    .string()
    .min(3)
    .describe(
      // Carried verbatim from ../knowledge.ts, and the reason is worth
      // restating because it is the one field whose language does NOT follow
      // the worker's locale dial: the corpus is Portuguese and the hybrid
      // ranking's full-text half is websearch_to_tsquery('portuguese', …), so a
      // Spanish-speaking worker's question contributes NOTHING to that half
      // unless the model translates it into Portuguese first. The embedding
      // half is multilingual, so the failure is degraded ranking rather than an
      // error — which is exactly why it needs saying out loud here.
      'Search question or terms, ALWAYS written in Portuguese regardless of the conversation language — the corpus and its full-text ranking are Portuguese (e.g. "tempo de cura cimento cola"). Translate the excerpt back when you answer.',
    ),
  category: z
    .enum(knowledgeCategories)
    .optional()
    .describe('Restrict to one category: lei, regulamento, tecnica, material, fabricante.'),
});

export const workerSearchKnowledge: WorkerTool<z.infer<typeof workerSearchKnowledgeInput>> = {
  audience: 'worker',
  name: 'search_knowledge',
  description:
    'Search the shared Portuguese construction knowledge base (laws, regulations, techniques, materials, manufacturer application guides). Returns excerpts with their source. Read-only, and the same library the manager consults. Use it before making any technical or legal claim — curing times, dosages, application standards, permits.',
  inputSchema: workerSearchKnowledgeInput,
  execute: async (input, ctx) => {
    const hits = await searchKnowledgeChunks(ctx.db, input.query, { category: input.category });
    if (hits.length === 0) {
      return {
        results: [],
        // Model-facing instruction, not copy shown to anyone. A wrong curing
        // time given confidently to someone standing on the job is worse than
        // "I don't know" — this is the one place in the worker roster where
        // invention has physical consequences.
        note: 'Nothing found on this. Tell the worker plainly that you have no source for it and that they should ask their manager — never invent a standard, a dosage or a curing time.',
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
