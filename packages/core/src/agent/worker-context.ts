import type { SystemModelMessage } from 'ai';
import type { Db } from '@capo/db/client';
import type { Locale } from '@capo/i18n/locale';
import { cachedInstructions } from './cache';
import { workerPersonas } from './persona';
import workerOrchestration from './prompts/worker-orchestration';
import voice from './prompts/voice';
import { localeName } from './prompts/language';
import { loadKnowledgeIndex } from './context';
import { promptBlocks } from '../i18n';
import { toWorkerTaskView, type WorkerTaskRow } from '../capabilities/worker/tasks';
import type { PendingPhoto } from '../capabilities/worker/types';

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
// which language to write in, today's date, WHO THIS PERSON IS (their own name,
// trade, company and who runs it), this person's own open tasks, the index of
// what the knowledge base can answer, and how many photos just arrived. Nothing
// that names another crew member, another task, or the company's shape.
//
// The identity block is the one addition to that list since PRD 4, and it is
// not a loosening of the absences above: see loadWorkerIdentity below for the
// line between "facts about the person holding the phone" and "facts about the
// company and everybody in it".

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
 * The four facts the person on the other end already knows about themselves.
 *
 * ── WHY THIS IS NOT ONE OF THE DELIBERATE ABSENCES ABOVE ───────────────────
 * A crew member wrote "who am I?" and Capo answered that it could not give out
 * personal information. That was not a guardrail working; it was the model
 * correctly reporting that it had been told nothing. Their own name, their own
 * trade, the company they work for and who runs it are not company SHAPE (the
 * snapshot's head counts) and they are not another person's business: they are
 * facts this person could read off their own payslip, and Capo was the only
 * party in the conversation that did not have them.
 *
 * What it is NOT, and must never become: another crew member's name, another
 * crew member's work, phone numbers, pay, or anything about the company beyond
 * its name. Manager names come from `profiles.full_name`, which managers type
 * about themselves.
 */
export interface WorkerIdentity {
  workerName: string;
  trade: string | null;
  companyName: string;
  /** At most MAX_MANAGER_NAMES, in a stable order. Never phone or email. */
  managerNames: string[];
}

/**
 * A crew of three managers is already unusual; naming ten would turn a one-line
 * answer into a directory and would be the first step towards this block being
 * a company roster. Three is "who to ask", which is the question behind it.
 */
const MAX_MANAGER_NAMES = 3;

/**
 * Three small reads, and ANY failure drops the whole block rather than the
 * turn. Same posture as `loadCompanySnapshot` and `loadManagerName` in
 * ./context.ts: a crew member standing in the rain does not care that one
 * select timed out, and the prompt is correct without this block because it was
 * correct without it for the whole of PRD 4.
 *
 * Called from handleWorkerInbound rather than from the WhatsApp route, so the
 * route needs no new query and there is exactly one place this can be loaded
 * from.
 */
export async function loadWorkerIdentity(
  db: Db,
  ids: { workerId: string; companyId: string },
): Promise<WorkerIdentity | null> {
  try {
    const [worker, company, managers] = await Promise.all([
      db.from('workers').select('name, trade').eq('id', ids.workerId).single(),
      db.from('companies').select('name').eq('id', ids.companyId).single(),
      db
        .from('profiles')
        .select('full_name')
        .eq('company_id', ids.companyId)
        .order('created_at')
        .limit(MAX_MANAGER_NAMES),
    ]);

    // The worker's own row and the company name are the block. Without either
    // of them there is nothing worth rendering, so the block is dropped whole
    // rather than half printed.
    if (worker.error || !worker.data || company.error || !company.data) return null;

    return {
      workerName: worker.data.name,
      trade: worker.data.trade,
      companyName: company.data.name,
      // Managers are the one part that may legitimately be empty (a company
      // whose only account was deleted), and an empty list simply drops its
      // line below.
      managerNames: (managers.data ?? [])
        .map(row => row.full_name)
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        .slice(0, MAX_MANAGER_NAMES),
    };
  } catch {
    return null;
  }
}

/**
 * Rendered in the UNCACHED half, and that is not a preference. Every line of it
 * is per-WORKER, so above the breakpoint it would write one cache entry per
 * crew member and read none, exactly the trap `loadManagerName` had to avoid on
 * the manager side (issue #62).
 */
export function buildIdentityBlock(identity: WorkerIdentity | null, locale: Locale): string | null {
  if (!identity) return null;
  const t = promptBlocks[locale];
  const lines = [
    t.workerIdentityHeading,
    `- ${t.workerIdentityName}: ${identity.workerName}`,
    identity.trade ? `- ${t.workerIdentityTrade}: ${identity.trade}` : null,
    `- ${t.workerIdentityCompany}: ${identity.companyName}`,
    identity.managerNames.length > 0
      ? `- ${t.workerIdentityManagers}: ${identity.managerNames.join(', ')}`
      : null,
    `- ${t.workerIdentityLanguage}: ${localeName(locale)}`,
    t.workerIdentityNote,
  ].filter((line): line is string => line !== null);
  return lines.join('\n');
}

/**
 * How many photos arrived with this message, and their per-turn ids.
 *
 * The ids are handles for `declare_task_done`, nothing more — they are not
 * database ids and they do not survive the turn. The COUNT is the entire fact
 * the model learns about the photos: no dimensions, no filename, and above all
 * nothing read out of the image. Feeding an inbound photo to a vision model is
 * a text-in-image injection surface with no mitigation, so the images never
 * reach one (0023, and AGENTS.md).
 */
function buildPhotoBlock(photos: readonly PendingPhoto[]): string | null {
  if (photos.length === 0) return null;
  return [
    '# Photos received',
    `${photos.length} photo(s) arrived with this message. You have NOT seen them and must not describe or judge them.`,
    `Ids, for declare_task_done: ${photos.map(p => p.id).join(', ')}`,
  ].join('\n');
}

export interface WorkerPromptInput {
  db: Db;
  locale: Locale;
  today: string;
  tasks: WorkerTaskRow[];
  pendingPhotos: readonly PendingPhoto[];
  /** Null when the read failed, or on a caller that has not loaded it. The
   *  block is then absent and the prompt is what it was before issue W4. */
  identity: WorkerIdentity | null;
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
    // Above the task list on purpose: who this is comes before what they have
    // to do, and a question about the person is answered from the first block
    // the model reads about them.
    buildIdentityBlock(input.identity, input.locale),
    buildTaskBlock(input.tasks),
    knowledgeBlock,
    buildPhotoBlock(input.pendingPhotos),
  ]);
}
