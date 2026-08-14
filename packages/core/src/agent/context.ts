import type { SystemModelMessage } from 'ai';
import type { Db } from '@capo/db/client';
import type { Locale, LocaleContext } from '@capo/i18n/locale';
import { promptBlocks } from '../i18n';
import { cachedInstructions } from './cache';
import { personas } from './persona';
import orchestration from './prompts/orchestration';
import { buildLanguageDirective } from './prompts/language';

// System prompt assembly: persona (voice) ⊕ orchestration (policy) ⊕ language
// directive ⊕ today's date ⊕ company snapshot ⊕ durable memories ⊕ conversation
// summary. Persona and policy live in separate files on purpose — iterate voice
// without touching logic. Both are bundled TS modules, so the prompt travels
// with the package regardless of cwd or deploy layout.
//
// Persona and prompt blocks are keyed on the USER locale (this is what Capo
// speaks); the language directive carries both dials, since it is the block
// that tells the model what to STORE.
//
// PROVIDER PROMPT CACHING IS ON (issue #58), and the block order above is now
// load-bearing rather than merely tidy. The prompt is returned as TWO system
// messages with a cache breakpoint between them (see ./cache.ts):
//
//   cached   persona ⊕ orchestration ⊕ language directive
//   ── breakpoint ──
//   uncached today's date ⊕ snapshot ⊕ onboarding ⊕ knowledge index
//            ⊕ memories ⊕ summary
//
// The cut sits immediately BEFORE the date line, and that is the whole rule:
// the date changes every day, so a breakpoint placed after it caches a prefix
// that is guaranteed to be stale tomorrow — you pay the write and never read
// it. Everything downstream of the date is per-tenant or per-turn anyway.
//
// Two consequences to keep in mind when editing:
//   - Anything added to the cached half must be a CONSTANT of the code, not of
//     the tenant or the clock. A DB-derived block up there turns a cache hit
//     into a cache rewrite on every change.
//   - The cache still fragments by locale — persona has 3 variants and the
//     language directive varies with both dials — so each combination warms
//     its own entry. The tool schemas carry their own, earlier breakpoint
//     precisely because they are the one part that does NOT vary that way.
//
// The knowledge index is the obvious candidate for promotion into the cached
// half (it changes only when the operator ingests documents). It is left below
// the line deliberately: it is a DB read that can transiently fail to null, and
// the cached half already clears Sonnet 5's 1024-token minimum several times
// over, so promoting it would buy little and make a live prompt reorder.

interface CompanySnapshot {
  companyName: string;
  activeObras: number;
  activeWorkers: number;
  openTasks: number;
  pendingProposals: number;
}

// Cheap head-count queries only — never blocks the turn. A failure here
// (e.g. a transient DB hiccup) must not crash the conversation, so any
// error collapses to "no snapshot" rather than propagating.
async function loadCompanySnapshot(db: Db, companyId: string): Promise<CompanySnapshot | null> {
  try {
    const [company, obras, workers, tasks, proposals] = await Promise.all([
      db.from('companies').select('name').eq('id', companyId).single(),
      db.from('jobs').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'active'),
      db.from('workers').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('active', true),
      db.from('tasks').select('id', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['pending', 'in_progress', 'pending_review']),
      db.from('proposals').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'pending'),
    ]);
    if (company.error || !company.data) return null;
    return {
      companyName: company.data.name,
      activeObras: obras.count ?? 0,
      activeWorkers: workers.count ?? 0,
      openTasks: tasks.count ?? 0,
      pendingProposals: proposals.count ?? 0,
    };
  } catch {
    return null;
  }
}

// Knowledge index: just the titles by category, not the content — enough for
// the model to know what search_knowledge CAN answer (the main lever for it
// actually calling the tool) without spending context on the corpus itself.
// Same failure posture as the snapshot: any error collapses to "no block".
//
// The document titles themselves stay in Portuguese whatever the locale: the
// corpus is Portuguese, and a translated index would name documents the manager
// cannot find and the tool cannot match.
//
// EXPORTED because the worker agent's prompt (./worker-context.ts) needs the
// same block and the same reasoning. This is the one thing the two prompts
// share, and sharing it is safe for a specific reason rather than by luck:
// `knowledge_documents` is the global, operator-curated corpus with no
// company_id at all (0012), so this function cannot carry tenant data into a
// worker's context. Nothing else from this file is reused — buildSystemPrompt
// injects `memories` and the pending-proposal snapshot, and a worker must see
// neither.
export async function loadKnowledgeIndex(db: Db, locale: Locale): Promise<string | null> {
  try {
    const { data, error } = await db
      .from('knowledge_documents')
      .select('title, category')
      .order('category')
      .order('title')
      .limit(100);
    if (error || !data || data.length === 0) return null;
    const byCategory = new Map<string, string[]>();
    for (const doc of data) {
      const list = byCategory.get(doc.category) ?? [];
      list.push(doc.title);
      byCategory.set(doc.category, list);
    }
    const t = promptBlocks[locale];
    const lines = [...byCategory.entries()].map(([category, titles]) => `- ${category}: ${titles.join('; ')}`);
    return `${t.knowledgeHeading}\n${t.knowledgeIntro}\n${lines.join('\n')}`;
  } catch {
    return null;
  }
}

function buildOnboardingBlock(snapshot: CompanySnapshot, locale: Locale): string | null {
  const t = promptBlocks[locale];
  const empty = snapshot.activeObras === 0 && snapshot.activeWorkers === 0 && snapshot.openTasks === 0;
  if (empty) return t.firstUse;


  if (snapshot.activeObras === 0 || snapshot.activeWorkers === 0) {
    const gaps = [
      snapshot.activeObras === 0 ? t.gapNoJobs : null,
      snapshot.activeWorkers === 0 ? t.gapNoWorkers : null,
    ].filter((g): g is string => g !== null);
    return t.incompleteSetup(gaps);
  }
  return null;
}

/**
 * The half of the manager prompt that is a constant of the code: who Capo is,
 * what it is allowed to do, and which language it writes and stores in. No
 * clock, no tenant rows — which is exactly what makes it cacheable.
 *
 * Exported so `pnpm cache-check` can measure it against the model's minimum
 * cacheable prefix without a database or a network call.
 */
export function managerStableBlocks(locales: LocaleContext): string[] {
  return [personas[locales.user], orchestration, buildLanguageDirective(locales)];
}

export async function buildSystemPrompt(
  db: Db,
  companyId: string,
  summary: string | null,
  locales: LocaleContext,
): Promise<SystemModelMessage[]> {
  const today = new Date().toISOString().slice(0, 10);
  const t = promptBlocks[locales.user];

  // Memory tier 2 (durable/semantic), injected wholesale — trivially fits at
  // one-company scale. A recall tool comes when this outgrows context.
  const { data: memories } = await db
    .from('memories')
    .select('kind, content, created_at')
    .eq('company_id', companyId)
    .eq('active', true)
    .order('created_at');

  const memoryBlock =
    memories && memories.length > 0
      ? memories.map(m => `- [${m.kind}] (${m.created_at.slice(0, 10)}) ${m.content}`).join('\n')
      : t.memoryEmpty;

  const [snapshot, knowledgeBlock] = await Promise.all([
    loadCompanySnapshot(db, companyId),
    loadKnowledgeIndex(db, locales.user),
  ]);
  const snapshotBlock = snapshot
    ? `${t.snapshotHeading}
${t.snapshotCompany}: ${snapshot.companyName}
${t.snapshotActiveJobs}: ${snapshot.activeObras}
${t.snapshotActiveWorkers}: ${snapshot.activeWorkers}
${t.snapshotOpenTasks}: ${snapshot.openTasks}
${t.snapshotPendingProposals}: ${snapshot.pendingProposals}`
    : null;
  const onboardingBlock = snapshot ? buildOnboardingBlock(snapshot, locales.user) : null;

  // The block ORDER below is unchanged from before caching — the array is
  // simply cut in two at the point where the prompt stops being a constant of
  // the code and starts being a snapshot of this tenant, today. Joined back
  // together the two halves are byte-identical to the single string this used
  // to return, which `pnpm cache-check` asserts.
  return cachedInstructions(managerStableBlocks(locales), [
    `# Today's date\n${today}`,
    snapshotBlock,
    onboardingBlock,
    knowledgeBlock,
    `${t.memoryHeading}\n${memoryBlock}`,
    summary ? `${t.summaryHeading}\n${summary}` : null,
  ]);
}
