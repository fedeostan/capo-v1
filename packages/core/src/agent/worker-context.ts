import type { SystemModelMessage } from 'ai';
import type { Db } from '@capo/db/client';
import type { Locale } from '@capo/i18n/locale';
import { cachedInstructions } from './cache';
import { workerPersonas } from './persona';
import workerOrchestration from './prompts/worker-orchestration';
import voice from './prompts/voice';
import { localeName } from './prompts/language';
import { loadKnowledgeIndex } from './context';
import { toWorkerTaskView, type WorkerTaskRow } from '../capabilities/worker/tasks';
import type { InboxPhoto } from '../media/photo-inbox';

// The worker agent's system prompt — assembled from a deliberately short list.
//
// Read this against buildSystemPrompt (./context.ts) and the interesting part
// is what is MISSING, because each absence is a decision:
//
//   memories           — injected wholesale into the manager's prompt. If a
//                        worker could reach `remember`, they would be writing
//                        directly into the manager's context. They cannot (the
//                        tool is not in their roster), and this prompt does not
//                        read the table either, so a memory written by any
//                        other path never reaches a crew member's phone.
//   pending proposals  — approval cards are the manager's business, and naming
//                        them here would tell a worker what is up for decision.
//   company snapshot   — head counts of jobs, workers and open tasks across the
//                        whole company. A worker's picture stops at their own
//                        work.
//   conversation summary — there is no summarizer on this path. See
//                        ./memory/worker-conversation.ts.
//
// What IS here: who you are (crew persona), how to behave (worker policy),
// which language to write in, today's date, this person's own open tasks, the
// index of what the knowledge base can answer, and how many photos just
// arrived. Nothing that names another person, another task, or the company's
// shape.

/**
 * The single-dial language directive. The manager's version
 * (prompts/language.ts) carries TWO dials plus the `manager_instruction`
 * carve-out, and neither belongs here: a worker cannot move what the company
 * stores, and there is no guard on this path for a translated quote to break.
 *
 * The Portuguese-search rule survives, because it is not about the manager at
 * all — it is about the corpus. `search_knowledge` ranks with
 * websearch_to_tsquery('portuguese', …), so a Spanish-speaking worker's
 * question contributes nothing to the full-text half unless it is translated
 * first. That failure is silent: degraded results, never an error.
 */
function buildWorkerLanguageDirective(locale: Locale): string {
  return [
    '# Language policy',
    `- WRITE to this crew member only in ${localeName(locale)}. Every word you send them is in that language.`,
    '- The task titles, obra names and materials you are shown below are stored in the COMPANY\'s language, which may not be theirs. Say them back in the language you are speaking, but never change what a task is called when you record anything.',
    '- The knowledge base is Portuguese, and its full-text ranking only works in Portuguese. ALWAYS write the `search_knowledge` query in Portuguese no matter what language this conversation is in, then translate the excerpt when you answer.',
  ].join('\n');
}

/**
 * This worker's own open tasks, rendered into the prompt rather than left for a
 * tool call.
 *
 * The list is small (capped at 40 by loadWorkerTasks) and it is the answer to
 * the most common message a worker sends, so paying for it up front removes a
 * round trip from nearly every turn. `my_tasks` still exists — the model needs
 * a way to re-read after `set_my_language`, and a tool the policy can point at
 * is easier to steer than a block it has to remember is there.
 */
function buildTaskBlock(rows: WorkerTaskRow[]): string {
  if (rows.length === 0) {
    return '# Your tasks\nThis person has no open tasks assigned to them right now. If they ask, say so plainly and tell them to check with their supervisor.';
  }
  const lines = rows.map(row => {
    const t = toWorkerTaskView(row);
    const bits = [
      `- [${t.task_id}] ${t.title ?? '(sem título)'}`,
      t.obra ? `obra: ${t.obra}` : null,
      t.morada ? `morada: ${t.morada}` : null,
      t.due_date ? `prazo: ${t.due_date}` : null,
      t.overdue ? 'ATRASADA' : null,
      t.today ? 'hoje' : null,
      t.status === 'pending_review' ? 'já declarada, à espera do gerente' : null,
      t.materials.length > 0 ? `material: ${t.materials.join(', ')}` : null,
      t.waiting_on.length > 0 ? `depende de: ${t.waiting_on.join(', ')}` : null,
      t.description ? `nota: ${t.description}` : null,
    ].filter(Boolean);
    return bits.join(' · ');
  });
  return `# Your tasks\nThese are the ONLY tasks this person has, and the only ids declare_task_done accepts.\n${lines.join('\n')}`;
}

/**
 * The photos this crew member has sent that no task has claimed yet, with the
 * time each one arrived.
 *
 * Since 0047 this is NOT "photos that arrived with this message". Every inbound
 * image is staged the moment it lands, so a photo sent on its own and explained
 * a minute later is still here on the next turn, and three photos sent as three
 * messages are all here rather than only the last. That is the whole point: the
 * old block described bytes that lived for one turn, and a crew member who did
 * the natural thing lost them.
 *
 * The ids are handles for `declare_task_done` and nothing else. The COUNT and
 * the TIME are the entire fact the model learns about the photos: no
 * dimensions, no filename, and above all nothing read out of the image. Feeding
 * an inbound photo to a vision model is a text-in-image injection surface with
 * no mitigation, so the images never reach one (0023, and AGENTS.md).
 */
function buildPhotoBlock(photos: readonly InboxPhoto[]): string | null {
  if (photos.length === 0) return null;
  return [
    '# Photos received',
    `${photos.length} photo(s) from this person are waiting to be attached to a task. Some may have arrived in EARLIER messages. You have NOT seen any of them and must not describe or judge them.`,
    'When they tell you which task they finished, pass ALL of these ids to declare_task_done unless they say some belong to a different job.',
    ...photos.map(p => `- ${p.id} (received ${p.receivedAt})`),
  ].join('\n');
}

export interface WorkerPromptInput {
  db: Db;
  locale: Locale;
  today: string;
  tasks: WorkerTaskRow[];
  pendingPhotos: readonly InboxPhoto[];
}

/**
 * The half of the worker prompt that is a constant of the code — who they are
 * talking to, what that agent may do, and which language to answer in. Nothing
 * dated, nothing about this particular crew member.
 *
 * Same shape and same purpose as `managerStableBlocks` in ./context.ts, and
 * deliberately a SEPARATE function rather than a shared one: the two prompts
 * are different documents built from different pieces, and the only thing they
 * have in common is that both are cut in the same place.
 */
export function workerStableBlocks(locale: Locale): string[] {
  return [workerPersonas[locale], voice, workerOrchestration, buildWorkerLanguageDirective(locale)];
}

// Returned as two system messages with a cache breakpoint between them (see
// ./cache.ts). The cut sits immediately before the date line, so the cached
// half is persona ⊕ policy ⊕ language and everything about THIS crew member —
// their tasks, the knowledge index, how many photos just arrived — stays
// uncached below it. A worker's task list changes constantly and is unique to
// them; caching it would write an entry per worker per change and read none.
export async function buildWorkerSystemPrompt(input: WorkerPromptInput): Promise<SystemModelMessage[]> {
  const knowledgeBlock = await loadKnowledgeIndex(input.db, input.locale);

  return cachedInstructions(workerStableBlocks(input.locale), [
    `# Today's date\n${input.today}`,
    buildTaskBlock(input.tasks),
    knowledgeBlock,
    buildPhotoBlock(input.pendingPhotos),
  ]);
}
