import type { PromptBlocks } from './prompt-blocks';

// Type annotation, not `satisfies` and not `as const`: this way a missing key
// AND a typo'd extra key are both tsc errors, symmetrically in all three
// locales. `satisfies` would let pt-PT define the shape and silently excuse it
// from the check the others get.
const blocks: PromptBlocks = {
  knowledgeHeading: '# Base de conhecimento disponível (via search_knowledge)',
  knowledgeIntro: 'Documentos que podes consultar para fundamentar respostas legais/técnicas:',

  snapshotHeading: '# Estado atual da empresa',
  snapshotManager: 'Gerente com quem estás a falar',
  snapshotCompany: 'Empresa',
  snapshotActiveJobs: 'Obras ativas',
  snapshotActiveWorkers: 'Trabalhadores ativos',
  snapshotOpenTasks: 'Tarefas em aberto',
  snapshotPendingProposals: 'Propostas pendentes',

  firstUse: `# Primeira utilização
Esta empresa ainda não tem obras, equipa nem tarefas registadas. É a primeira conversa. Apresenta-te uma vez (quem és, o que fazes) e depois guia o gerente na configuração inicial, UMA pergunta de cada vez, nunca um formulário completo:
1. Primeira obra (nome, morada, cliente)
2. Equipa (nomes, funções, telemóveis em formato E.164)
3. Primeiras tarefas
Menciona, quando fizer sentido, que os resultados aparecem nas abas Tarefas/Obras.`,
  incompleteSetup: gaps => `# Configuração incompleta
Esta empresa já tem alguma coisa registada, mas ${gaps.join(' e ')}. Se ainda não mencionaste isto nesta conversa, refere a lacuna UMA vez, de forma natural. Se já a mencionaste antes (ver histórico), não repitas.`,
  gapNoJobs: 'ainda não há obras registadas',
  gapNoWorkers: 'ainda não há trabalhadores registados',

  memoryHeading: '# Memória durável (factos guardados entre conversas)',
  memoryEmpty: '(sem memórias guardadas ainda)',

  summaryHeading: '# Resumo da conversa até agora',

  speakers: { user: 'Gerente', assistant: 'Capo', event: 'Evento' },
  emptyMessage: '(mensagem sem texto)',

  workerIdentityHeading: '# Com quem estás a falar',
  workerIdentityName: 'Nome',
  workerIdentityTrade: 'Ofício',
  workerIdentityCompany: 'Empresa',
  workerIdentityManagers: 'Quem manda na empresa',
  workerIdentityLanguage: 'Idioma em que lhe escreves',
  workerIdentityNote:
    'Estes factos são sobre a pessoa com quem estás a falar. Se ela perguntar como se chama, em que empresa trabalha, qual é o ofício dela, quem é o chefe ou em que idioma estão a falar, responde numa linha a partir daqui. Não a mandes falar com o encarregado por causa disto.',
};

export default blocks;
