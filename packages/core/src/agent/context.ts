import type { SystemModelMessage } from 'ai';
import type { Db } from '@capo/db/client';
import type { Locale, LocaleContext } from '@capo/i18n/locale';
import { promptBlocks } from '../i18n';
import { cachedInstructions } from './cache';
import {
  MEMORY_READ_LIMIT,
  formatMemoryLine,
  selectPromptMemories,
} from './memory/prompt-memories';
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
//     into a cache rewrite on every change. The manager's own name (issue #62)
//     is the worked example: it is a row in `profiles`, so it goes in the
//     snapshot below the line. Above the line it would fragment the cached
//     prefix PER PROFILE — every manager warming their own entry — on top of
//     rewriting it on every rename. The static sentence telling the model that
//     these live facts outrank the summary and the memories is the opposite
//     case: it never varies, so it lives in orchestration, above the line.
//   - The cache still fragments by locale — persona has 3 variants and the
//     language directive varies with both dials — so each combination warms
//     its own entry. The tool schemas carry their own, earlier breakpoint
//     precisely because they are the one part that does NOT vary that way.
//
// Since #48 the memory block is CAPPED rather than injected wholesale (40 rows
// / 6000 chars, see ./memory/prompt-memories.ts) and is filtered per profile.
// Both facts reinforce the placement above rather than complicating it: a block
// that grows on a nightly schedule is the textbook "breakpoint on content that
// changes every request" mistake if it sits in the cached half, and a
// per-profile block up there would fragment the prefix per manager exactly as
// the manager's own name would.
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

// The manager's own name, read fresh on every turn (issue #62).
//
// This is a LIVE FACT and it is here, next to the company snapshot, for exactly
// the reason that issue existed: `companies.name` was already read every turn,
// so a company rename showed up immediately, while the manager's own name
// appeared in the prompt only where some past turn had written it down — the
// conversation summary. A manager who renamed himself on /perfil therefore kept
// being addressed by his old surname, from prose frozen months earlier and
// merged forward by every later summarization pass.
//
// Columns are named rather than `select('*')`: the 0031 reasoning (a deploy
// landing before its migration 42703s on a named column) applies to columns a
// PENDING migration adds, and `full_name` has existed since 0007. Same failure
// posture as loadCompanySnapshot — any error collapses to "no name", never to a
// crashed turn, because being addressed generically is a far smaller failure
// than not answering at all.
async function loadManagerName(db: Db, userId: string): Promise<string | null> {
  try {
    const { data, error } = await db.from('profiles').select('full_name').eq('id', userId).single();
    if (error || !data) return null;
    return data.full_name;
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

/**
 * Everything buildSystemPrompt needs, as an object rather than five positional
 * arguments. `companyId` and `userId` are both bare uuid strings and would be
 * silently swappable positionally — the kind of mistake that produces a prompt
 * that builds, types and reads fine while naming the wrong person. Same shape,
 * and same reason, as buildWorkerSystemPrompt's parameter.
 */
export interface SystemPromptInput {
  db: Db;
  companyId: string;
  /**
   * The manager on the other end. Required, not optional: every caller has one
   * (it is already in `HandleInboundOptions`), and an optional field would let
   * a future channel ship with the stale-name bug back in place by omission —
   * silently, since a missing name simply removes a line from the prompt.
   */
  userId: string;
  summary: string | null;
  locales: LocaleContext;
}

export async function buildSystemPrompt({
  db,
  companyId,
  userId,
  summary,
  locales,
}: SystemPromptInput): Promise<SystemModelMessage[]> {
  const today = new Date().toISOString().slice(0, 10);
  const t = promptBlocks[locales.user];

  // Memory tier 2 (durable/semantic). No longer injected wholesale (issue #48):
  // the nightly consolidation pass writes memories on a SCHEDULE, so growth is
  // now automatic, and an automatic growth curve on a block re-sent with every
  // message is a cost bug that compounds silently. `selectPromptMemories` is the
  // ceiling — 40 rows / 6000 chars, newest first — and it is also what applies
  // the per-profile visibility rule.
  //
  // `select('*')` rather than a column list, deliberately: `profile_id` is a
  // column migration 0037 adds, and naming a pending column makes a deploy
  // landing first answer 42703 on every single turn (the 0031 reasoning, and
  // the view-extension rule in AGENTS.md). An absent field reads as `undefined`,
  // which `memoryVisibleTo` treats as "belongs to the whole company" — i.e.
  // exactly the pre-0037 product.
  //
  // RLS enforces the same visibility rule on the web, but NOT on the WhatsApp
  // path, where this runs on the service role and auth.uid() is null. The
  // TypeScript filter is the only one there is on that path.
  const { data: memoryRows } = await db
    .from('memories')
    .select('*')
    .eq('company_id', companyId)
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(MEMORY_READ_LIMIT);

  const { carried } = selectPromptMemories(memoryRows ?? [], userId);
  const memoryBlock = carried.length > 0 ? carried.map(formatMemoryLine).join('\n') : t.memoryEmpty;

  const [snapshot, knowledgeBlock, managerName] = await Promise.all([
    loadCompanySnapshot(db, companyId),
    loadKnowledgeIndex(db, locales.user),
    loadManagerName(db, userId),
  ]);

  // Built line by line rather than as one template because the two reads fail
  // independently: a transient failure on the counts must not also take the
  // manager's name out of the prompt, and vice versa. The whole block is
  // dropped only when both produced nothing.
  const factLines = [
    managerName ? `${t.snapshotManager}: ${managerName}` : null,
    snapshot ? `${t.snapshotCompany}: ${snapshot.companyName}` : null,
    snapshot ? `${t.snapshotActiveJobs}: ${snapshot.activeObras}` : null,
    snapshot ? `${t.snapshotActiveWorkers}: ${snapshot.activeWorkers}` : null,
    snapshot ? `${t.snapshotOpenTasks}: ${snapshot.openTasks}` : null,
    snapshot ? `${t.snapshotPendingProposals}: ${snapshot.pendingProposals}` : null,
  ].filter((line): line is string => line !== null);
  const snapshotBlock = factLines.length > 0 ? `${t.snapshotHeading}\n${factLines.join('\n')}` : null;
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
