import type { Catalog } from '../catalog';

// The original voice — every other dictionary is a translation of this one.
const dict: Catalog = {
  meta: {
    htmlLang: 'pt-PT',
    dateLocale: 'pt-PT',
    appName: 'Capo',
    appDescription: 'O teu capataz virtual',
    languageName: 'Português',
    titleSuffix: 'Capo',
  },

  nav: { chat: 'Chat', tasks: 'Tarefas', jobs: 'Obras', materials: 'Materiais', profile: 'Perfil' },

  common: {
    signOut: 'Sair',
    save: 'Guardar',
    backToLogin: 'Voltar a entrar',
    notAuthenticated: 'Não autenticado',
  },

  chat: {
    title: 'Capo 👷',
    tagline: 'O teu capataz virtual',
    placeholder: 'Escreve, fala, ou cola o orçamento…',
    send: 'Enviar',
    typing: 'O Capo está a escrever…',
    stop: 'Parar',
    errorTitle: 'O Capo não conseguiu responder.',
    errorHints: {
      billing: 'A subscrição expirou. Vai a Subscrição para reativar.',
      auth: 'A sessão terminou. Volta a entrar.',
      network: 'Sem ligação. Verifica a rede e tenta outra vez.',
      generic: 'Pode ter sido a rede ou uma falha momentânea. A tua mensagem não se perdeu.',
    },
    retry: 'Tentar outra vez',
    dismiss: 'Dispensar',
    emptyThread: 'Fala com o Capo — ele trata das obras, das tarefas e da equipa.',
    proposalTitle: 'Proposta do Capo',
    pendingProposals: 'Propostas por decidir',
    approve: 'Aprovar',
    reject: 'Rejeitar',
    cardState: {
      approved: '✅ Aprovada — executada',
      rejected: '❌ Rejeitada',
      failed: '⚠️ Aprovada, mas a execução falhou',
      not_pending: 'Esta proposta já foi resolvida',
      error: '⚠️ Erro ao resolver a proposta',
    },
    toolLabels: {
      create_task: 'Tarefa criada',
      update_task: 'Tarefa atualizada',
      list_tasks: 'Tarefas consultadas',
      agenda: 'Agenda consultada',
      materials_outlook: 'Materiais consultados',
      create_job: 'Obra criada',
      update_job: 'Obra atualizada',
      list_jobs: 'Obras consultadas',
      add_worker: 'Trabalhador adicionado',
      update_worker: 'Trabalhador atualizado',
      list_workers: 'Equipa consultada',
      remember: 'Memorizado',
      search_knowledge: 'Base de conhecimento consultada',
      set_language: 'Idioma alterado',
      // No label for apply_company_translation: it never renders as a tool
      // part, only as the approval card. Same as apply_plan.
      translate_company_data: 'Tradução proposta',
      propose: 'Proposta criada',
      generate_plan: 'Plano gerado',
    },
  },

  mic: {
    record: 'Gravar mensagem de voz',
    stop: 'Parar gravação',
    noAccess: 'Sem acesso ao microfone',
    notUnderstood: 'Não percebi — tenta outra vez',
    error: 'Erro ao transcrever',
  },

  dashboard: {
    taskStatus: {
      pending: 'Pendente',
      in_progress: 'Em curso',
      blocked: 'Bloqueada',
      done: 'Concluída',
      cancelled: 'Cancelada',
    },
    overdueBy: days => (days === 1 ? 'Prazo passou há 1 dia' : `Prazo passou há ${days} dias`),
    noAssignee: 'Sem responsável',
    noJob: 'Sem obra',
    noDate: 'Sem data',
    talkToCapo: 'Falar com o Capo',
    dueBy: shortDate => `até ${shortDate}`,
    risk: {
      blocked: 'bloqueada',
      lateStart: 'já devia ter começado',
      dueSoon: 'prazo em 2 dias úteis',
      lateDependency: titles => `espera por: ${titles.join(', ')}`,
      pausedJob: 'obra pausada',
    },
    progress: (done, total, pct) => `${done} de ${total} concluídas (${pct}%)`,
    tasksDone: (done, total) => `${done} de ${total} tarefas concluídas`,
    noTasksRegistered: 'sem tarefas registadas',
    overdueCount: n => `${n} ${n === 1 ? 'atrasada' : 'atrasadas'}`,
    pendingCount: n => `${n} ${n === 1 ? 'pendente' : 'pendentes'}`,
    dependsOn: titles => `⤷ depois de: ${titles.join(', ')}`,
  },

  screens: {
    tasks: {
      title: 'Tarefas',
      quando: {
        hoje: 'Hoje',
        amanha: 'Amanhã',
        atrasadas: 'Atrasadas',
        risco: 'Em risco',
        todas: 'Todas',
      },
      empty: {
        hoje: 'Nada agendado para hoje.',
        amanha: 'Nada agendado para amanhã.',
        atrasadas: 'Nenhuma tarefa fora do prazo. Bom sinal.',
        risco: 'Nada em risco de momento.',
        todas: 'Sem tarefas abertas.',
      },
      emptyForDate: 'Nada agendado para esse dia.',
      emptyFallback: 'Sem tarefas.',
      emptyInJob: base => `${base.replace(/\.$/, '')} nesta obra.`,
      count: n => `${n} ${n === 1 ? 'tarefa' : 'tarefas'}`,
      filterByJob: 'Filtrar por obra',
      filterByDay: 'Filtrar por dia',
      allJobs: 'Todas as obras',
      jobStatusSuffix: { paused: ' (pausada)', done: ' (terminada)' },
    },
    jobs: { title: 'Obras', subtitle: 'Obras ativas — progresso e atrasos', empty: 'Sem obras ativas.' },
    jobDetail: {
      fallbackTitle: 'Obra',
      empty: 'Sem tarefas nesta obra ainda — pede ao Capo para criar o plano.',
    },
    taskActions: { complete: 'Concluir', reopen: 'Reabrir', failed: 'Falhou, tenta outra vez.' },
    materials: {
      title: 'Materiais',
      subtitle: 'O que tem de estar em obra',
      tomorrow: 'Para amanhã',
      week: 'Resto da semana',
      weekHint: 'Para encomendar já — o que tem prazo de entrega não espera.',
      emptyTomorrow:
        'Nada por confirmar para amanhã. Se houver trabalho agendado sem materiais registados, pergunta ao Capo o que falta.',
      forTasks: tasks => `para: ${tasks.join(', ')}`,
      pending: n => `${n} ${n === 1 ? 'material' : 'materiais'} para amanhã`,
      pendingHint: 'Confirma que está em obra antes de fechares o dia.',
    },
  },

  auth: {
    login: {
      title: 'Capo',
      email: 'Email',
      emailPlaceholder: 'o.teu.email@empresa.pt',
      password: 'Palavra-passe',
      submit: 'Entrar',
      google: 'Entrar com Google',
      forgot: 'Esqueceste-te da password?',
      createAccount: 'Criar conta',
      errors: {
        credenciais: 'Email ou palavra-passe incorretos. Confirma e tenta de novo.',
        'link-invalido': 'O link expirou ou já foi usado. Pede um novo.',
      },
    },
    signup: {
      title: 'Criar conta',
      subtitle: '14 dias grátis. Sem cartão de crédito.',
      submit: 'Criar conta',
      checkEmailTitle: 'Confirma o teu email',
      checkEmailText: 'Enviámos um link de confirmação — abre-o para começares.',
      alreadyConfirmed: 'Já confirmaste? Entra aqui',
      haveAccount: 'Já tens conta?',
      signIn: 'Entra aqui',
      errors: {
        dados: 'Preenche um email válido e uma palavra-passe com pelo menos 8 caracteres.',
        fechado: 'Os registos abrem em breve — pede um convite.',
      },
    },
    recover: {
      title: 'Recuperar palavra-passe',
      subtitle: 'Indica o teu email — enviamos-te um link.',
      submit: 'Enviar link',
      sentTitle: 'Verifica o teu email',
      sentText: 'Se existir uma conta com esse email, enviámos um link para repores a palavra-passe.',
      errors: { dados: 'Indica um email válido.' },
    },
    newPassword: {
      title: 'Nova palavra-passe',
      label: 'Palavra-passe nova',
      errors: {
        curta: 'A palavra-passe tem de ter pelo menos 8 caracteres.',
        guardar: 'Não foi possível guardar. Pede um novo link de recuperação.',
      },
    },
  },

  onboarding: {
    title: 'Bem-vindo ao Capo',
    subtitle: 'Só faltam uns dados para começares: a tua empresa, o teu telemóvel e a língua.',
    companyName: 'Nome da empresa',
    companyPlaceholder: 'Construções Silva, Lda.',
    yourName: 'O teu nome',
    yourNamePlaceholder: 'João Silva',
    phone: 'O teu telemóvel',
    phonePlaceholder: '912 345 678',
    // NOT "where Capo sends the daily messages": this is profiles.phone, which
    // the WhatsApp webhook uses to resolve the tenant from an inbound sender —
    // the manager's own channel. The 07:00 briefing goes to workers.phone, a
    // different column and a different person. The old copy promised a message
    // that never arrives, on the very first screen.
    phoneHint: 'É por aqui que podes falar com o Capo no WhatsApp, sem abrir a app.',
    language: 'Língua',
    languageHint: 'Podes mudar depois — basta dizeres ao Capo.',
    submit: 'Começar',
    errors: {
      dados: 'Preenche o nome da empresa e o teu nome.',
      telemovel: 'Número inválido. Usa o formato 912 345 678 ou +351 912 345 678.',
      'telemovel-usado': 'Esse número já está associado a outra conta.',
      guardar: 'Não foi possível guardar. Tenta de novo.',
    },
  },

  profile: {
    title: 'Perfil',
    company: 'Empresa',
    yourAccount: 'A tua conta',
    team: 'Equipa',
    teamEmpty: 'Ainda não há ninguém na equipa.',
    teamEmptyCta: 'Pede ao Capo para adicionar',
    noContact: 'Sem contacto',
    inactive: 'inativo',
    workerLoad: (today, tomorrow, open) => `Hoje ${today} · Amanhã ${tomorrow} · ${open} em aberto`,
    noSmsWarning: 'Sem telemóvel — não recebe o SMS das 07:00.',
    receivesSms: 'recebe o SMS das 07:00',
    teamHint: 'Para adicionar ou alterar alguém,',
    teamHintLink: 'fala com o Capo',
    subscription: 'Subscrição',
    manageSubscription: 'Gerir subscrição',
    app: 'App',
    install: 'Instalar no telemóvel',
    companyNameLabel: 'Nome da empresa',
    fullNameLabel: 'O teu nome',
    phoneLabel: 'O teu telemóvel',
    errors: {
      companyName: 'O nome da empresa tem de ter entre 1 e 120 caracteres.',
      fullName: 'O nome tem de ter entre 1 e 120 caracteres.',
      phone: 'Número inválido. Usa o formato +351912345678.',
      phoneTaken: 'Esse número já está associado a outra conta.',
      save: 'Não foi possível guardar. Tenta outra vez.',
    },
  },

  settings: {
    language: 'Idioma',
    languageHint:
      'A língua em que o Capo fala contigo, em que vês a app, e em que ficam escritas as tarefas, obras e notas de toda a empresa.',
    translateExisting: p => {
      const parts: string[] = [];
      if (p.tasks) parts.push(`${p.tasks} tarefa${p.tasks === 1 ? '' : 's'}`);
      if (p.jobs) parts.push(`${p.jobs} obra${p.jobs === 1 ? '' : 's'}`);
      if (p.workers) parts.push(`${p.workers} ofício${p.workers === 1 ? '' : 's'}`);
      if (p.memories) parts.push(`${p.memories} nota${p.memories === 1 ? '' : 's'}`);
      const last = parts.pop();
      if (!last) return 'Traduzir também o que já existe';
      const list = parts.length > 0 ? `${parts.join(', ')} e ${last}` : last;
      return `Traduzir também o que já existe (${list})`;
    },
    translateNothing: 'Ainda não há nada guardado para traduzir.',
    translateWarning:
      'As mensagens SMS da equipa passam a ir na nova língua, e os materiais passam a ser agrupados pelos nomes traduzidos. Podes reverter durante 30 dias.',

    advanced: 'Definições avançadas',
    advancedHint:
      'Usa línguas diferentes para ti e para os dados da empresa — útil se falares uma língua diferente do resto da equipa.',
    yourLanguage: 'A tua língua',
    yourLanguageHint: 'A língua em que o Capo fala contigo e em que vês a app. Só afeta a ti.',
    companyLanguage: 'Língua dos dados da empresa',
    companyLanguageHint: 'A língua em que o Capo escreve tarefas, obras e notas — o que toda a equipa vê no painel.',
    companyLanguageWarning: 'Atenção: aqui as tarefas e obras já criadas não são traduzidas.',

    translationRunning: p => `A traduzir… ${p.done} de ${p.total}`,
    translationDone: n => `${n} campo${n === 1 ? '' : 's'} traduzido${n === 1 ? '' : 's'}.`,
    translationFailed: 'A tradução parou a meio. Nada se perdeu — podes retomar.',
    translationResume: 'Retomar tradução',
    revert: 'Reverter tradução',
    revertHint: days =>
      `Repõe o texto original exatamente como estava, palavra por palavra. Disponível durante ${days} dias.`,
    reverted: 'Tradução revertida.',
    revertFailed: 'Não foi possível reverter. Tenta de novo.',

    saved: 'Guardado.',
    failed: 'Não foi possível guardar. Tenta de novo.',
  },

  billing: {
    title: 'Subscrição',
    activated: 'Subscrição ativada. Obrigado!',
    unavailable: 'A faturação ainda não está disponível.',
    trialDaysLeft: days => `${days} dias de teste grátis restantes`,
    trialEnded: 'Período de teste terminado',
    statusLabel: {
      active: 'Subscrição ativa',
      past_due: 'Pagamento em falta',
      canceled: 'Subscrição cancelada',
    },
    price: '€45/mês · sem cartão para começar · sem custo por trabalhador',
    manage: 'Gerir subscrição',
    subscribe: 'Assinar — €45/mês',
    bannerBlocked:
      'A tua subscrição expirou — o WhatsApp continua a funcionar, mas o chat aqui e as ações ficam bloqueados. Toca para reativar.',
    bannerTrial: days => `Faltam ${days} dias de teste grátis — toca para assinar.`,
    bannerTrialEnded: 'O período de teste terminou — toca para assinar.',
    blockedError: 'A tua subscrição expirou. Vai a Subscrição para reativar — o WhatsApp continua a funcionar.',
    checkoutFailed: 'Não foi possível iniciar o checkout.',
    noSubscription: 'Ainda não tens uma subscrição associada.',
  },

  install: {
    title: 'Instala o Capo',
    subtitle: 'Com o Capo no ecrã principal, abres a app num toque — como o WhatsApp.',
    alreadyInstalled: 'O Capo já está instalado neste aparelho. 💪',
    open: 'Abrir o Capo',
    installButton: 'Instalar aplicação',
    skip: 'Continuar sem instalar',
    iosStep1Before: 'Toca em',
    iosStep1Share: 'Partilhar',
    iosStep1After: 'na barra do Safari.',
    iosStep2Before: 'Escolhe',
    iosStep2Action: 'Adicionar ao ecrã principal',
    iosStep3Before: 'Toca em',
    iosStep3Action: 'Adicionar',
    iosStep3After: 'O Capo fica no teu ecrã como uma app.',
    genericStep1Before: 'Abre o menu do navegador',
    genericStep2Before: 'Escolhe',
    genericStep2Action: 'Instalar aplicação',
    genericStep2After: '(ou “Adicionar ao ecrã principal”).',
  },

  landing: {
    metaTitle: 'Capo — O assistente que gere o teu WhatsApp',
    metaDescription:
      'O assistente de IA que gere o teu WhatsApp e trata da papelada da obra. Envia o orçamento, o Capo faz o plano dia a dia, a equipa recebe o briefing de manhã.',
    ogDescription:
      'Envia o orçamento, o Capo faz o plano dia a dia e avisa a equipa todas as manhãs. €45/mês, 14 dias grátis.',
    headline: 'O assistente que gere o teu WhatsApp e trata da papelada da obra',
    subhead:
      'Não é software de gestão de obras. É o capataz virtual que fala contigo por WhatsApp, organiza a equipa e nunca esquece o que falta.',
    ctaPrimary: 'Começar grátis — 14 dias',
    ctaSecondary: 'Já tenho conta — Entrar',
    stepLabel: n => `Passo ${n}`,
    steps: [
      {
        title: 'Envia o orçamento',
        text: 'Cola o orçamento ou descreve a obra numa mensagem — como falarias com um capataz.',
      },
      {
        title: 'O Capo faz o plano dia a dia',
        text: 'Sequência de tarefas, datas e materiais, prontos para aprovares num cartão.',
      },
      {
        title: 'A equipa recebe o briefing de manhã',
        text: 'Cada trabalhador recebe por SMS as tarefas do dia — sem apps, sem contas.',
      },
    ],
    materialsTitle: 'Antecipação de materiais',
    materialsText:
      'O Capo avisa a equipa com antecedência de que materiais vão precisar amanhã — nada de descobrir no dia que falta o quê.',
    priceSuffix: '/mês',
    priceNote: '14 dias grátis · sem cartão · sem custo por trabalhador',
    ctaFooter: 'Começar grátis',
    signIn: 'Entrar',
  },

  offline: {
    title: 'Sem ligação',
    text: 'O Capo precisa de internet para mostrar dados atualizados. Verifica a ligação e tenta de novo.',
  },

  whatsapp: {
    voiceNoteFailed: 'Não consegui ouvir essa mensagem de voz, chefe. Podes repetir ou escrever?',
    voiceNoteEmpty: 'Recebi a mensagem de voz mas não percebi nada. Podes repetir?',
  },
};

export default dict;
