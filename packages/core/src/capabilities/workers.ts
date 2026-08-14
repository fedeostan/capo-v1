import { z } from 'zod';
import { LOCALES } from '@capo/i18n/locale';
import { hasWhatsAppConsent } from '../channels/whatsapp';
import type { CapoTool } from './types';

// E.164 — this is the number the daily WhatsApp briefing is sent to, and the
// number an inbound worker reply is matched against. Validation failure
// bounces back to the model, which asks the manager for the full international
// format instead of storing a bad number.
const e164Phone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/)
  .describe(
    'Phone in E.164 international format, e.g. +351912345678. If the manager gives a local number, ask them to confirm the full international format — never guess the country prefix.',
  );

// The consent attestation, exposed to the model as a boolean because that is
// what the manager can actually answer; the timestamp is minted server-side, so
// the model never states WHEN consent was given, only that it was.
//
// Both worker tools are GUARDED, which matters more here than anywhere else in
// the roster: recording consent on someone else's behalf must carry the
// manager's verbatim instruction, never a model inference from context. Capo
// must not decide that a worker "probably agreed" because their phone number
// was mentioned.
const whatsappOptIn = z
  .boolean()
  .optional()
  .describe(
    'Set true ONLY when the manager states that this worker has agreed to receive WhatsApp messages from Capo. Required before Capo sends them anything — without it they get no briefing and no check-in. Never infer it: if the manager has not said so, ask. Set false to record that they no longer want them. Recording consent also makes Capo introduce itself to that person on WhatsApp, once — one paid message per person, so say so when the manager is consenting several people at a time.',
  );

export const addWorkerInput = z.object({
  name: z.string().min(1),
  trade: z
    .string()
    .optional()
    .describe(
      "The worker's trade (bricklayer, electrician, plumber…), written in the company's domain language (see the Language policy in your instructions).",
    ),
  phone: e164Phone.optional(),
  whatsapp_opt_in: whatsappOptIn,
});

/**
 * A consent boolean → the pair of timestamps 0025 stores.
 *
 * `false` writes an opt-out rather than clearing the opt-in, because the schema
 * marks and never deletes, and because hasWhatsAppConsent() compares the two.
 * `undefined` writes NOTHING — an update that does not mention consent must
 * leave whatever is on record untouched, which is why this returns an empty
 * object rather than nulls.
 */
function consentPatch(optIn: boolean | undefined): {
  whatsapp_opt_in_at?: string;
  whatsapp_opt_out_at?: string;
} {
  if (optIn === undefined) return {};
  const now = new Date().toISOString();
  return optIn ? { whatsapp_opt_in_at: now } : { whatsapp_opt_out_at: now };
}

export const addWorker: CapoTool<z.infer<typeof addWorkerInput>> = {
  name: 'add_worker',
  description:
    'Add a worker to the team. This is a write: only call it directly for an explicit manager command; otherwise use propose.',
  inputSchema: addWorkerInput,
  guarded: true,
  async execute(input, ctx) {
    const { data, error } = await ctx.db
      .from('workers')
      .insert({
        company_id: ctx.companyId,
        name: input.name,
        trade: input.trade ?? null,
        phone: input.phone ?? null,
        ...consentPatch(input.whatsapp_opt_in),
      })
      .select()
      .single();
    if (error) throw new Error(`add_worker failed: ${error.message}`);
    return { worker: data };
  },
};

export const updateWorkerInput = z.object({
  worker_id: z.string().uuid().describe('Worker to update — use list_workers to find ids.'),
  name: z.string().min(1).optional(),
  trade: z.string().optional(),
  phone: e164Phone.optional(),
  whatsapp_opt_in: whatsappOptIn,
  language: z
    .enum(LOCALES)
    .optional()
    .describe(
      "The language of this worker's daily WhatsApp briefing. Workers normally set this themselves by replying PT, ES or EN to the message — only set it here when the manager explicitly asks on their behalf. Unset means they follow the company language. Note this does NOT translate task titles, which are always stored in the company language.",
    ),
});

export const updateWorker: CapoTool<z.infer<typeof updateWorkerInput>> = {
  name: 'update_worker',
  description:
    'Update an existing worker (name, trade, phone, briefing language, WhatsApp consent). This is a write: only call it directly for an explicit manager command; otherwise use propose.',
  inputSchema: updateWorkerInput,
  guarded: true,
  async execute(input, ctx) {
    // whatsapp_opt_in is a tool-level boolean, not a column, so it must be
    // pulled OUT of the spread — passing it through would send Postgres a column
    // that does not exist and fail the whole update.
    const { worker_id, whatsapp_opt_in, ...fields } = input;
    const { data, error } = await ctx.db
      .from('workers')
      .update({ ...fields, ...consentPatch(whatsapp_opt_in) })
      .eq('id', worker_id)
      .eq('company_id', ctx.companyId)
      .select()
      .single();
    if (error) throw new Error(`update_worker failed: ${error.message}`);
    return { worker: data };
  },
};

export const listWorkers: CapoTool<Record<string, never>> = {
  name: 'list_workers',
  description:
    "List the team: trade, whether they are reachable by the daily WhatsApp messages (recebe_whatsapp — needs both a phone and recorded consent; falta_consentimento flags the ones who have a number but have not agreed yet), and how loaded they are today/tomorrow. Use it to answer 'quem está livre?' and before assigning work. Read-only.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { data, error } = await ctx.db
      .from('workers')
      .select('*')
      .eq('company_id', ctx.companyId)
      .eq('active', true)
      .order('name');
    if (error) throw new Error(`list_workers failed: ${error.message}`);

    // Load comes from task_board — the same view the Tasks board, the crew
    // card on /perfil, and the `agenda` tool all read — so "today"/"tomorrow"
    // mean one thing everywhere. (Deliberately NOT dashboard_tasks: 0013 marks
    // that view for removal in a follow-up migration.)
    // Best-effort: a worker roster is still useful without the tallies.
    const load = new Map<string, { hoje: number; amanha: number; atrasadas: number; abertas: number }>();
    const { data: rows } = await ctx.db
      .from('task_board')
      .select('assignee_worker_id, active_today, active_tomorrow, overdue')
      .eq('company_id', ctx.companyId)
      .eq('is_open', true);
    for (const row of rows ?? []) {
      if (!row.assignee_worker_id) continue;
      const entry = load.get(row.assignee_worker_id) ?? { hoje: 0, amanha: 0, atrasadas: 0, abertas: 0 };
      entry.abertas += 1;
      if (row.active_today) entry.hoje += 1;
      if (row.active_tomorrow) entry.amanha += 1;
      if (row.overdue) entry.atrasadas += 1;
      load.set(row.assignee_worker_id, entry);
    }

    return {
      workers: (data ?? []).map(w => ({
        ...w,
        // Reachability is phone AND consent, and it has to be both or Capo tells
        // the manager someone is covered when the crons will skip them. This is
        // the same predicate the crons gate on — see hasWhatsAppConsent.
        recebe_whatsapp: Boolean(w.phone) && hasWhatsAppConsent(w),
        // Split out so the manager can be told WHICH of the two is missing:
        // "add a number" and "ask them if they agree" are different jobs.
        falta_consentimento: Boolean(w.phone) && !hasWhatsAppConsent(w),
        tarefas: load.get(w.id) ?? { hoje: 0, amanha: 0, atrasadas: 0, abertas: 0 },
      })),
    };
  },
};

export const workerTools = [addWorker, updateWorker, listWorkers];
