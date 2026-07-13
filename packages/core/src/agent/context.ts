import type { Db } from '@capo/db/client';
import persona from './persona/capo.pt-PT';
import orchestration from './prompts/orchestration';

// System prompt assembly: persona (voice) ⊕ orchestration (policy) ⊕ today's
// date ⊕ company snapshot ⊕ durable memories ⊕ conversation summary. Persona
// and policy live in separate files on purpose — iterate voice without
// touching logic. Both are bundled TS modules, so the prompt travels with
// the package regardless of cwd or deploy layout.

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

function buildOnboardingBlock(snapshot: CompanySnapshot): string | null {
  const empty = snapshot.activeObras === 0 && snapshot.activeWorkers === 0 && snapshot.openTasks === 0;
  if (empty) {
    return `# Primeira utilização
Esta empresa ainda não tem obras, equipa nem tarefas registadas — é a primeira conversa. Apresenta-te uma vez (quem és, o que fazes) e depois guia o gerente na configuração inicial, UMA pergunta de cada vez, nunca um formulário completo:
1. Primeira obra (nome, morada, cliente)
2. Equipa (nomes, funções, telemóveis em formato E.164)
3. Primeiras tarefas
Menciona, quando fizer sentido, que os resultados aparecem nas abas Hoje/Amanhã/Obras.`;
  }
  if (snapshot.activeObras === 0 || snapshot.activeWorkers === 0) {
    const gaps = [
      snapshot.activeObras === 0 ? 'ainda não há obras registadas' : null,
      snapshot.activeWorkers === 0 ? 'ainda não há trabalhadores registados' : null,
    ].filter(Boolean);
    return `# Configuração incompleta
Esta empresa já tem alguma coisa registada, mas ${gaps.join(' e ')}. Se ainda não mencionaste isto nesta conversa, refere a lacuna UMA vez, de forma natural. Se já a mencionaste antes (ver histórico), não repitas.`;
  }
  return null;
}

export async function buildSystemPrompt(db: Db, companyId: string, summary: string | null): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);

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
      : '(sem memórias guardadas ainda)';

  const snapshot = await loadCompanySnapshot(db, companyId);
  const snapshotBlock = snapshot
    ? `# Estado atual da empresa
Empresa: ${snapshot.companyName}
Obras ativas: ${snapshot.activeObras}
Trabalhadores ativos: ${snapshot.activeWorkers}
Tarefas em aberto: ${snapshot.openTasks}
Propostas pendentes: ${snapshot.pendingProposals}`
    : null;
  const onboardingBlock = snapshot ? buildOnboardingBlock(snapshot) : null;

  return [
    persona,
    orchestration,
    `# Today's date\n${today}`,
    snapshotBlock,
    onboardingBlock,
    `# Durable memory (facts stored across conversations)\n${memoryBlock}`,
    summary ? `# Summary of the conversation so far\n${summary}` : null,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');
}
