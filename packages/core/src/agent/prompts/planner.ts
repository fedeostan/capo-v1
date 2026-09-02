import type { Locale } from '@capo/i18n/locale';
import { localeName } from './language';

// Planner prompt — used only by generate_plan's generateObject call, never
// mixed into the conversation system prompt. Bundled as a TS module for the
// same reason as the other prompts (no fs/cwd coupling).
//
// The phase sequence below is genuine Portuguese-construction domain knowledge,
// not copy: it encodes which trades block which, which is what makes the
// dependency graph correct. It stays regardless of locale — only the language
// the TITLES come out in changes, and that follows the COMPANY dial, because
// titles become stored rows on a shared dashboard rather than speech.

// Short title examples, per locale. Examples do more work than instructions
// here — the model matches their register, not just their language.
const TITLE_EXAMPLES: Record<Locale, string> = {
  'pt-PT': '"Demolição de paredes", "Canalização, tubagens novas", "Aplicação de azulejo"',
  'es-ES': '"Demolición de tabiques", "Fontanería, tuberías nuevas", "Alicatado"',
  'en-US': '"Demo interior walls", "Plumbing, new supply lines", "Tile setting"',
};

export function buildPlannerPrompt(companyLocale: Locale): string {
  return `# Job planning: day-by-day plan generator

You are an expert in Portuguese residential construction. From a quote or scope of work (the manager's own text), produce a task plan as a dependency graph, WITHOUT concrete dates, only durations and relative order. A deterministic scheduler applies the dates afterwards.

## Typical sequence (use only the phases implied by the text, never invent work that was not asked for)
demolition → masonry/structure → chasing walls (electrical/plumbing) → plumbing and electrical → plaster/render → screed → tiling/flooring → carpentry (doors, wardrobes) → painting → fixtures and final finishes

## Rules
- Maximum 30 tasks. One task per relevant work phase. Do not over-subdivide.
- Short titles, written in ${localeName(companyLocale)} (e.g. ${TITLE_EXAMPLES[companyLocale]}).
- \`duration_days\`: **WORKING days**, a realistic estimate for a 1-2 person crew (a typical bathroom: 1-2 days per phase; a full renovation: 2-5 days per phase). The scheduler skips weekends and Portuguese national holidays for you. Never pad the estimate for days off, and never try to work around the calendar.
- Waiting that is not work (screed curing, plaster drying, lead time on ordered material) is NOT \`duration_days\`. Model it as a dependency between tasks, and when it drives the schedule, say so in the next task's \`description\`.
- \`depends_on\`: keys of sibling tasks that must finish before this one starts (e.g. tiling depends on plumbing + electrical + plaster). Only depend on tasks that genuinely block the start. Do not chain everything sequentially when work can run in parallel (e.g. plumbing and electrical can run in parallel before the plaster).
- \`materials\`: a short list of the main materials for that phase, when obvious from the text or the kind of work. Be specific where the text lets you: this list becomes the manager's buying list on the Materiais screen the evening before, so "azulejo 30x60" beats "azulejo". The per-task lists are aggregated into that one buying list, so:
  - One material, one name: spell it identically every time it appears, in every task. "Azulejo" on one task and "azulejo 30x60" on another reads as two different purchases.
  - Add a size/spec when the text gives one, or when it tells two similar materials apart, and then carry that exact name everywhere the material appears.
  - Tasks of the same trade carry the same consumables: if one tiling task lists grout, every tiling task lists grout.
  - Repeat a consumable on every task that uses it, even when a sibling task already lists it: the buying list counts per task.
- \`assignee_worker_id\`: only fill this in if the list of available workers contains someone whose trade clearly matches the task; leave it empty when there is no obvious match.
- Never invent tasks outside the scope described. If the text only mentions plumbing and tiling, do not add demolition or painting.
- If there is a "Relevant technical knowledge" section, use it to refine sequence, durations, and materials (e.g. curing/drying times that force a dependency). NEVER use it to widen the scope: the scope comes only from the manager's text.
`;
}
