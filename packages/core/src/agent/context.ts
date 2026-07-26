import type { Db } from '@capo/db/client';
import type { Locale, LocaleContext } from '@capo/i18n/locale';
import { promptBlocks } from '../i18n';
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
// NOTE if provider prompt caching is ever enabled: the prefix now varies by
// locale, so the cache fragments three ways. Order is already
// most-stable-first, which is the right shape for it.

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
      db.from('tasks').select('id', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['pending', 'in_progress']),
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
async function loadKnowledgeIndex(db: Db, locale: Locale): Promise<string | null> {
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

export async function buildSystemPrompt(
  db: Db,
  companyId: string,
  summary: string | null,
  locales: LocaleContext,
): Promise<string> {
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

  return [
    personas[locales.user],
    orchestration,
    buildLanguageDirective(locales),
    `# Today's date\n${today}`,
    snapshotBlock,
    onboardingBlock,
    knowledgeBlock,
    `${t.memoryHeading}\n${memoryBlock}`,
    summary ? `${t.summaryHeading}\n${summary}` : null,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');
}
