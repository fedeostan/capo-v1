import { z } from 'zod';
import type { CapoTool } from './types';

// The applier half of "the crew asked for material, put it on the buy list"
// (issue #152 follow-up). Split into its own module for exactly the reason
// plan-apply.ts, reschedule-apply.ts and job-pause-apply.ts are: propose.ts
// must import this proposable tool, and the module that PRODUCES the proposal
// (request-materials.ts) imports createProposal from propose.ts. Importing it
// from there would be a cycle.
//
// ── WHAT THIS WRITE IS ──────────────────────────────────────────────────────
//
// It appends lines to ONE task's `materials` array. That array is the whole
// buy list: /materiais reads it, `materials_outlook` reads it, and since 0044
// the daily walk-around screen reads it. Nothing else in the product turns a
// crew member's message into something the manager buys, which is the gap this
// closes.
//
// ── WHY IT IS NOT IN THE ROSTER ─────────────────────────────────────────────
//
// It is absent from index.ts and lives only in propose.ts's `proposable`
// array, the FIFTH member of the apply_plan / apply_company_translation /
// apply_reschedule / apply_job_pause family. Absent rather than merely guarded,
// for the reason AGENTS.md gives and which is sharper here than anywhere:
//
//   A guarded tool in the roster executes DIRECTLY whenever the model can quote
//   the manager. For "sim, adiciona isso aos materiais" the model can ALWAYS
//   quote the manager. So a guarded roster entry would mean the manager's own
//   agreement, in passing, in the middle of a sentence, is enough to write a
//   crew member's words onto the buy list with no card in between.
//
// And a wrong line cannot be cheaply undone: `tasks.materials` has no delete
// path in chat at all. The manager can take one off from the task screen or
// /materiais by hand, one at a time; there is no "undo" and no batch. So the
// only honest place for this write is behind a card the manager has read.
//
// ── WHAT IS NOT HERE, DELIBERATELY ──────────────────────────────────────────
//
// No quantity, unit, stock level or delivery. A material in this product is a
// LINE OF TEXT, and 0044 says out loud that adding a quantity column is the
// start of a different product rather than an extension of this one. This
// applier writes strings into a text[] and knows nothing else.
//
// No removal. `add` only ever appends. A card that could take lines off would
// be the one shape of this feature where a crew member's message subtracts
// from the manager's list.

/** Longest single line we will store. Mirrors MAX_MATERIAL_LENGTH in
 *  apps/web/app/(app)/_tasks/materials-actions.ts, which is the OTHER writer of
 *  this column and cannot be imported from here (packages/core knows nothing
 *  about apps/web). Same number, same reason: a material is a line on a
 *  shopping list, not a paragraph, and it has to fit in a chip on a phone.
 *  Also the cap that stops a hostile crew message riding out of the extraction
 *  step as one long "material". */
export const MAX_MATERIAL_LENGTH = 120;

/** Most lines ONE card may add. Far below the column's own 50-line ceiling,
 *  because this is a single request from a single person: a message asking for
 *  a dozen different things is a message the manager should read himself. */
export const MAX_ADDED_MATERIALS = 12;

/** Most lines the task may already carry. Mirrors MAX_MATERIALS in the web
 *  action, and here it bounds the compare-and-set snapshot rather than the
 *  write. */
export const MAX_EXISTING_MATERIALS = 50;

/** One line, with the shape rules enforced at the SCHEMA level rather than by
 *  prompt instruction. The lines come out of a model that read untrusted prose,
 *  so "short noun phrase, no line breaks" has to be checked by something that
 *  cannot be talked out of it. */
const materialLine = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MATERIAL_LENGTH)
  .refine(value => !/[\n\r]/.test(value), { message: 'A material line cannot contain a line break' });

export const applyRequestMaterialsInput = z
  .object({
    // Kept in the payload so the card can name WHO asked and WHEN for, by
    // re-reading the row at render time. The request's own words are
    // deliberately NOT here: see the header of request-materials.ts.
    request_id: z.string().uuid().describe('The crew request this came from.'),
    task_id: z.string().uuid().describe('Task whose material list gains these lines.'),
    // Not documentation. This is the compare-and-set predicate, the same role
    // from_start_date/from_due_date play in apply_reschedule and
    // apply_job_pause: the list as it stood when the card was written. A card
    // left open overnight must never silently stomp a list the manager edited
    // on /materiais in the meantime.
    //
    // An empty array is a real value meaning "the task carried no materials",
    // and is distinct from the column's NULL only in the database: the applier
    // normalises NULL to [] before comparing, because "no rows" and "an empty
    // list" are the same buy list to a manager.
    from_materials: z.array(z.string()).max(MAX_EXISTING_MATERIALS),
    add: z.array(materialLine).min(1).max(MAX_ADDED_MATERIALS),
  })
  .superRefine((input, ctx) => {
    const seen = new Set(input.add.map(line => line.toLocaleLowerCase()));
    if (seen.size !== input.add.length) {
      ctx.addIssue({ code: 'custom', path: ['add'], message: 'Duplicate material in add' });
    }
    const existing = new Set(input.from_materials.map(line => line.trim().toLocaleLowerCase()));
    for (const line of input.add) {
      if (existing.has(line.toLocaleLowerCase())) {
        ctx.addIssue({
          code: 'custom',
          path: ['add'],
          message: `"${line}" is already on this task's material list`,
        });
      }
    }
  });

type ApplyRequestMaterialsInput = z.infer<typeof applyRequestMaterialsInput>;

/** Element-wise, order-sensitive, whitespace-trimmed comparison of two lists.
 *  Order matters because the column is an ordered text[] and a reordering is a
 *  manager's edit like any other: refusing on it costs one retry, ignoring it
 *  means the card was written against a list that no longer exists. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value.trim() === b[i]?.trim());
}

export const applyRequestMaterials: CapoTool<ApplyRequestMaterialsInput> = {
  name: 'apply_request_materials',
  description:
    "Add the materials a crew member asked for to a task's material list. Only ever runs via an approved proposal, never call this directly.",
  inputSchema: applyRequestMaterialsInput,
  guarded: true,
  async execute(input, ctx) {
    // ── pre-flight ────────────────────────────────────────────────────────
    // resolveProposal re-validates the args and re-renders the card before
    // executing, but neither of those can know a ROW moved underneath. So
    // everything is checked BEFORE the single write, the same posture as
    // apply_job_pause and apply_reschedule.
    const { data: task, error: readError } = await ctx.db
      .from('tasks')
      .select('id, title, status, materials, updated_at')
      .eq('id', input.task_id)
      .eq('company_id', ctx.companyId)
      .maybeSingle();
    if (readError) throw new Error(`apply_request_materials failed reading the task: ${readError.message}`);
    if (!task) throw new Error(`apply_request_materials: task ${input.task_id} no longer exists`);

    // Work that is over does not need buying for. A closed task's material
    // list is the record of what the job took, not a list to add to.
    if (task.status === 'done' || task.status === 'cancelled') {
      throw new Error(
        `apply_request_materials: "${task.title}" was closed after this card was created, so nothing was changed`,
      );
    }

    // The compare-and-set. NULL and [] are the same buy list, so both read as
    // the empty list here; anything else having changed means the card is
    // describing a list that no longer exists, and appending to it would be
    // writing next to an edit the manager made deliberately.
    const current = task.materials ?? [];
    if (!sameList(current, input.from_materials)) {
      throw new Error(
        `apply_request_materials: the material list on "${task.title}" changed after this card was created, so nothing was changed. Ask again and a fresh card will be raised against the new list.`,
      );
    }

    if (current.length + input.add.length > MAX_EXISTING_MATERIALS) {
      throw new Error(
        `apply_request_materials: "${task.title}" would end up with more than ${MAX_EXISTING_MATERIALS} materials`,
      );
    }

    // ── apply ─────────────────────────────────────────────────────────────
    // One statement, appending to the end so the manager's own ordering
    // survives and the new lines are visibly the new ones. `updated_at` is
    // stamped for the same reason the web action stamps it: it is what makes
    // the board and every cached page refresh.
    const next = [...current, ...input.add];
    const { data, error } = await ctx.db
      .from('tasks')
      .update({ materials: next, updated_at: new Date().toISOString() })
      .eq('id', input.task_id)
      .eq('company_id', ctx.companyId)
      // Narrow race guard on top of the pre-flight check above, closing the
      // window between reading the list and writing it. `materials` is a
      // text[] and PostgREST array equality is not expressible through
      // supabase-js's .eq(), so the row VERSION stands in for it: every writer
      // of this column in the codebase stamps `updated_at` (update_task, the
      // /materiais and task-detail server action, apply_job_pause, this
      // applier). A writer that forgot to would slip past this filter and be
      // caught by the pre-flight read instead, which is why both are here and
      // why neither is described as the check on its own.
      .eq('updated_at', task.updated_at)
      .select('id, materials')
      .maybeSingle();
    if (error) throw new Error(`apply_request_materials failed: ${error.message}`);
    // A filter that matched nothing is a fully successful statement in
    // Postgres, so the zero-row case has to be checked rather than trusted.
    if (!data) {
      throw new Error(
        `apply_request_materials: "${task.title}" changed while the materials were being added, so nothing was changed`,
      );
    }

    return { task_id: input.task_id, request_id: input.request_id, added: input.add, materials: data.materials };
  },
};

export const requestMaterialsApplyTools = [applyRequestMaterials];
