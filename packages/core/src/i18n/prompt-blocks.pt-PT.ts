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
  snapshotApp: 'Painel do gerente (endereço da app)',

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

  onboardingDone: 'FEITO',
  onboardingMissing: 'FALTA',
  onboardingAbout: value => (value === null ? 'ainda não sabes o que a empresa faz' : `"${value}"`),
  onboardingJobs: (count, withClient, withAddress) =>
    count === 0
      ? 'nenhuma obra registada'
      : `${count} obra(s), ${withClient} com cliente, ${withAddress} com morada`,
  onboardingCrew: (count, withPhone, withConsent) =>
    count === 0
      ? 'ninguém na equipa'
      : `${count} pessoa(s), ${withPhone} com telemóvel, ${withConsent} com autorização para receber WhatsApp do Capo`,
  onboardingTasks: count => (count === 0 ? 'nenhuma tarefa criada' : `${count} tarefa(s) em aberto`),
  onboarding: c => `# Configuração inicial em curso
Este gerente está a montar a empresa AGORA. É a tua tarefa principal nesta conversa: levá-lo do zero até uma empresa realmente configurada. Não pares a meio.

Como está a lista neste momento:
1. [${c.about.status}] O que a empresa faz: ${c.about.detail}
2. [${c.jobs.status}] Primeira obra: ${c.jobs.detail}
3. [${c.crew.status}] Equipa: ${c.crew.detail}
4. [${c.tasks.status}] Primeiras tarefas: ${c.tasks.detail}

Como conduzir isto:
- Apresenta-te UMA vez, logo no início da primeira conversa: quem és e o que fazes por ele. Depois nunca mais te apresentes.
- UMA pergunta de cada vez. Nunca um formulário, nunca várias perguntas na mesma mensagem.
- Depois de gravares alguma coisa, CONTINUA na mesma resposta para o item que falta a seguir. Nunca acabes com "pronto" ou "está feito" enquanto houver itens em falta.
- Sobre a empresa: pergunta por palavras simples o que fazem, em que estão a trabalhar agora e que tipo de trabalho costumam fazer. Guarda a resposta com set_company_about. Uma ou duas frases chegam.
- Obra: nome, cliente e morada. A morada aparece na mensagem da manhã de quem lá trabalha, por isso vale a pena pedi-la.
- Equipa: nome e função de cada pessoa, o telemóvel (diz o país, por exemplo +351 em Portugal) e se essa pessoa concordou em receber mensagens do Capo no WhatsApp. Sem essa autorização o Capo nunca lhe escreve. Usa add_worker.
- Tarefas: as primeiras tarefas a sério, ligadas à obra e a quem as vai fazer.
${
    c.allDone
      ? '- A lista está completa. Chama finish_onboarding AGORA e, na mesma resposta, dá o link do painel que a ferramenta devolve e diz numa linha o que ele lá encontra: o trabalho de hoje, a equipa e as decisões à espera dele.'
      : '- Quando os quatro itens estiverem feitos, chama finish_onboarding e partilha o link do painel que a ferramenta devolve.'
  }`,

  memoryHeading: '# Memória durável (factos guardados entre conversas)',
  memoryEmpty: '(sem memórias guardadas ainda)',

  summaryHeading: '# Resumo da conversa até agora',

  speakers: { user: 'Gerente', assistant: 'Capo', event: 'Evento' },
  emptyMessage: '(mensagem sem texto)',
};

export default blocks;
