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

  nav: {
    home: 'Início',
    chat: 'Chat',
    tasks: 'Tarefas',
    jobs: 'Obras',
    materials: 'Materiais',
    activity: 'Atividade',
    profile: 'Perfil',
  },

  shell: {
    openMenu: 'Abrir menu',
    profile: 'Perfil',
    search: 'Pesquisar',
    searchUnavailable: 'A pesquisa ainda não está disponível',
    voiceNote: 'Nota de voz',
    newTask: 'Nova tarefa',
    close: 'Fechar',
    role: 'Encarregado',
    version: (v: string) => `Capo ${v}`,
    rooms: {
      personal: { title: 'Informação pessoal', sub: 'Empresa, nome, email, telefone' },
      team: { title: 'Equipa', sub: 'Quem trabalha consigo' },
      billing: { title: 'Faturação', sub: 'Subscrição e pagamentos' },
      privacy: { title: 'Privacidade', sub: 'Memória, notificações, mensagens' },
      settings: { title: 'Definições', sub: 'Idioma, aspeto, conta' },
    },
    deleteAccount: {
      row: 'Apagar conta',
      cannotUndo: 'Não pode ser desfeito',
      title: 'Apagar esta conta',
      body: 'Todas as obras, tarefas, fotografias e mensagens são apagadas para toda a equipa. Isto não pode ser desfeito.',
      placeholder: 'Nome da empresa',
      cancel: 'Cancelar',
      confirm: 'Apagar para sempre',
      unavailable: 'Ainda não é possível apagar a conta a partir da aplicação. Fale connosco e tratamos disso.',
    },
  },

  activity: {
    title: 'Atividade',
    subtitle: 'O que aconteceu nas obras',
    empty: 'Ainda não aconteceu nada por aqui.',
    today: 'Hoje',
    yesterday: 'Ontem',
    claimed: (task: string, who: string) => `${who} diz que terminou ${task}.`,
    claimedAnon: (task: string) => `${task} foi dada como terminada.`,
    approved: (task: string) => `Confirmaste ${task}.`,
    rejected: (task: string) => `Devolveste ${task} para ser refeita.`,
    photos: (count: number, task: string) =>
      count === 1 ? `1 fotografia adicionada a ${task}.` : `${count} fotografias adicionadas a ${task}.`,
    checkinDone: (who: string) => `${who} respondeu que acabou o dia.`,
    checkinNotDone: (who: string) => `${who} respondeu que ainda não acabou.`,
  },

  home: {
    greetingMorning: (name: string) => (name ? `Bom dia, ${name}` : 'Bom dia'),
    greetingAfternoon: (name: string) => (name ? `Boa tarde, ${name}` : 'Boa tarde'),
    greetingEvening: (name: string) => (name ? `Boa noite, ${name}` : 'Boa noite'),
    summary: (sites: number, openTasks: number) =>
      `${sites === 1 ? '1 obra activa' : `${sites} obras activas`} · ${openTasks === 1 ? '1 tarefa aberta' : `${openTasks} tarefas abertas`}`,
    nextUp: 'Para hoje',
    allTasks: 'Todas as tarefas',
    nothingToday: 'Nada marcado para hoje.',
    decision: 'Precisa da tua decisão',
    decisionMore: (n: number) => (n === 1 ? 'mais 1 à espera' : `mais ${n} à espera`),
    openTask: 'Abrir tarefa',
    whatHappened: 'O que aconteceu',
    seeActivity: 'Atividade',
    crew: 'A equipa hoje',
    checkedIn: (answered: number, total: number) => `${answered} de ${total} responderam`,
    silent: (n: number) => (n === 1 ? '1 sem resposta' : `${n} sem resposta`),
    noCrew: 'Ainda não há ninguém na equipa.',
    materialsLow: 'Materiais a acabar',
    allMaterials: 'Todos os materiais',
    materialsNone: 'Não falta nada para amanhã.',
  },

  common: {
    signOut: 'Sair',
    save: 'Guardar',
    backToLogin: 'Voltar a entrar',
    notAuthenticated: 'Não autenticado',
  },

  pullToRefresh: { refreshing: 'A atualizar…' },

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
    deciding: 'A aplicar…',
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
      pending_review: 'A aguardar controlo',
      blocked: 'Bloqueada',
      done: 'Concluída',
      cancelled: 'Cancelada',
    },
    overdueBy: days => (days === 1 ? 'Prazo passou há 1 dia' : `Prazo passou há ${days} dias`),
    noAssignee: 'Sem responsável',
    assignedTo: name => `Atribuída a ${name}`,
    noJob: 'Sem obra',
    noDate: 'Sem data',
    agendaToday: 'Hoje',
    agendaTomorrow: 'Amanhã',
    agendaOverdue: 'Atrasadas',
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
    jobPaused: 'Em pausa',
    jobPausedHint: 'Sem trabalho marcado por agora. As tarefas continuam aqui.',
    dependsOn: titles => `⤷ depois de: ${titles.join(', ')}`,
  },

  notifications: {
    title: 'Notificações',
    subtitle: 'O que aconteceu desde a última vez que olhaste.',
    empty: 'Nada por ler. Quando um trabalhador der uma tarefa como feita, aparece aqui.',
    banner: n => `${n} ${n === 1 ? 'novidade' : 'novidades'}`,
    markAllRead: 'Marcar tudo como lido',
    failed: 'Não foi possível marcar como lido.',
    unread: 'Por ler',
    profileLink: 'Notificações',
    kind: {
      review_pending: subject => `“${subject}” está a aguardar o teu controlo.`,
      worker_request: subject => `${subject} pediu uma coisa para a obra.`,
    },
    noSubject: 'Uma tarefa',
    noteLabel: 'O que escreveram:',
    openSubject: 'Ver nas tarefas',
    pushNudge: 'Queres receber estes avisos no telemóvel?',
    pushNudgeLink: 'Ligar alertas',
  },

  requests: {
    title: 'Pedidos da equipa',
    seeAll: 'Ver todos',
    more: n => `+${n} ${n === 1 ? 'pedido' : 'pedidos'}`,
    category: {
      material: 'Material',
      tool: 'Ferramenta',
      machine: 'Máquina',
      delivery: 'Entrega',
      other: 'Outro',
    },
    when: ({ kind, dateLabel }) => {
      if (kind === 'today') return 'para hoje';
      if (kind === 'tomorrow') return 'para amanhã';
      if (kind === 'overdue') return dateLabel ? `era para ${dateLabel}` : 'já passou do dia';
      if (kind === 'later') return dateLabel ? `para ${dateLabel}` : 'para mais tarde';
      return 'sem data';
    },
    quoteLabel: name => `${name} escreveu:`,
    whatsapp: ({ name, when, quote, task }) => {
      const where = task ? ` · ${task}` : '';
      return `Pedido de ${name}${where}, ${when}.\n\n“${quote}”\n\nFica registado nas tuas notificações. Não encomendei nada.`;
    },
    event: ({ name, when, task }) => {
      const where = task ? `, na tarefa “${task}”` : '';
      return `${name} fez um pedido pelo WhatsApp${where}, ${when}. Está nas tuas notificações, tal como foi escrito.`;
    },
  },

  crewMessage: {
    whatsapp: ({ company, text }) =>
      `Recado de ${company}:\n\n“${text}”\n\nPodes responder aqui e eu levo a resposta.`,
  },

  automations: {
    title: 'Mensagens automáticas',
    subtitle: 'O que o Capo envia à equipa sozinho, a que horas, e o que aconteceu em cada dia.',
    profileLink: 'Ver mensagens automáticas',
    costNote:
      'Cada pessoa que recebe uma destas mensagens conta como um envio pago no WhatsApp. Mais pessoas na equipa, ou mais mensagens por dia, é mais custo.',

    job: {
      daily_briefing: {
        name: 'Mensagem da manhã',
        what: 'Diz a cada pessoa o que tem para fazer hoje: obra, morada, material e do que depende.',
        who: 'Toda a equipa activa com WhatsApp autorizado, e cada responsável da empresa.',
      },
      task_checkin: {
        name: 'Pergunta do fim do dia',
        what: 'Pergunta “acabaste as tarefas de hoje?”, com dois botões para responder.',
        who: 'Só quem é responsável por uma tarefa hoje. Quem só está a ajudar não recebe.',
      },
    },

    aimedAt: (hour: string) => `Apontada para as ${hour}`,
    window: (from: string, to: string) => `Chega entre as ${from} e as ${to}`,
    nextRun: (when: string) => `Próxima: ${when}`,
    usingDefault: 'A usar a hora de origem — ninguém mexeu nesta.',
    on: 'Ligada',
    off: 'Desligada',
    enabledLabel: 'Enviar esta mensagem',
    hourLabel: 'Hora',
    saved: 'Guardado.',
    saveFailed: 'Não consegui guardar. Tenta outra vez.',
    invalidHour: 'Escolhe uma hora entre as 05:00 e as 21:00.',

    addTitle: 'Adicionar outra mensagem',
    addExplanation:
      'Ainda não dá para criar uma mensagem nova a partir daqui, e a razão é do lado do WhatsApp: uma mensagem que o Capo envia sem ninguém ter escrito primeiro tem de usar um texto aprovado pela Meta com antecedência. Um texto escrito por ti não sairia. Enquanto isso não existir, o que podes fazer é mudar a hora destas duas ou desligar a que não queres.',

    historyTitle: 'O que aconteceu',
    historyHint:
      'Uma linha por dia e por mensagem: a que horas estava marcada e a que horas saiu mesmo. O sítio onde alojamos o Capo costuma tocar à porta com algum atraso, por isso as duas horas raramente são iguais.',
    historyEmpty: 'Ainda não há nada registado.',
    due: 'Marcada',
    ran: 'Saiu',
    lateBy: (minutesLabel: string) => `${minutesLabel} de atraso`,
    onTime: 'À hora',
    messagedCount: (n: number) => (n === 1 ? '1 pessoa avisada' : `${n} pessoas avisadas`),
    failedCount: (n: number) => (n === 1 ? '1 falhou' : `${n} falharam`),
    skippedCount: (n: number) => (n === 1 ? '1 sem nada para dizer' : `${n} sem nada para dizer`),
    nothingSent: 'Não saiu nada neste dia.',

    debugTitle: 'Pessoa a pessoa',
    debugHint: 'Quem recebeu, quem não recebeu, e porquê.',
    recipientWorker: 'Equipa',
    recipientManager: 'Responsável',
    outcome: {
      sent: 'Entregue à Meta',
      delivered: 'Chegou ao telemóvel',
      read: 'Lida',
      failed: 'Falhou',
      skipped: 'Não enviada',
      pending: 'Por confirmar',
    },
    outcomeHint: {
      sent: 'A Meta aceitou a mensagem, mas ainda não confirmou que chegou.',
      delivered: 'A Meta confirmou que a mensagem chegou ao telemóvel.',
      read: 'A pessoa abriu a mensagem.',
      failed: 'A Meta recusou ou não conseguiu entregar.',
      skipped: 'Não havia nada para dizer a esta pessoa neste dia.',
      pending: 'O envio começou e não chegou a terminar.',
    },

    reasonTitle: 'Quem não recebe nada, e porquê',
    reason: {
      noConsent: 'Não autorizou receber WhatsApp.',
      unreachable: 'Não tem número nem outra forma de ser contactado.',
      inactive: 'Está marcado como inactivo na equipa.',
      managerNoConsent: 'O responsável não autorizou receber WhatsApp.',
      noManagerAccount: 'Esta empresa não tem nenhuma conta de responsável, por isso o resumo diário não vai a lado nenhum.',
    },
    reasonNamesHint:
      'Os nomes aqui em baixo são de agora, não do dia em causa — as contas de cada dia ficam guardadas, os nomes não.',
    reasonNobody: 'Ninguém está a ficar de fora.',

    metaError: {
      '132001': 'O texto aprovado ainda não existe neste idioma.',
      '131030': 'O número não está na lista de teste. Isto já não devia acontecer.',
      '131026': 'Este número não tem WhatsApp.',
      '131047': 'Passaram mais de 24 horas desde a última mensagem desta pessoa, por isso só sai texto aprovado.',
      '131021': 'Tentámos enviar para o nosso próprio número.',
      '132000': 'O texto enviado não encaixa no formato aprovado.',
    },
    metaErrorUnknown: 'A Meta recusou o envio.',
    metaErrorLabel: (code: number) => `Código ${code}`,
  },

  memory: {
    title: 'Memória',
    subtitle: 'O que o Capo se lembra de ti e da empresa — e como o fazer esquecer.',
    profileLink: 'Ver o que o Capo se lembra',
    explainer:
      'O Capo não “aprende” sozinho: tudo o que ele sabe de uma conversa para a outra está escrito aqui, em frases soltas, e é isto que ele volta a ler antes de cada resposta. Se algo nesta lista estiver errado ou já não fizer sentido, apaga — deixa de contar imediatamente.',

    companyHeading: 'Sobre a empresa',
    companyHint: 'Toda a gente com conta nesta empresa vê estas.',
    personalHeading: 'Sobre ti',
    personalHint: 'Só tu vês estas. Ninguém mais na empresa lhes toca.',
    empty: 'Ainda não há nada guardado.',

    capTitle: 'O que o Capo leva consigo',
    capHint: (carried: number, limit: number) =>
      `O Capo leva as ${limit} notas mais recentes para cada conversa. Agora leva ${carried}.`,
    storedNotCarried: 'Guardada, mas fora das mais recentes — o Capo não a está a ler.',

    forget: 'Esquecer',
    forgotten: 'Esquecido.',
    forgetFailed: 'Não consegui apagar. Tenta outra vez.',
    forgetNote:
      'Esquecer tira a nota da cabeça do Capo para sempre. O registo de que existiu fica guardado, para se um dia quiseres perceber porque é que ele respondeu de certa maneira.',

    kind: {
      company: 'Empresa',
      job: 'Obra',
      worker: 'Equipa',
      preference: 'Preferência',
      fact: 'Facto',
    },

    reviewTitle: 'Revisão da noite',
    lastReviewed: (when: string) => `Última revisão: ${when}`,
    neverReviewed: 'Ainda não houve nenhuma revisão.',
    reviewHint:
      'Todas as noites, de madrugada, o Capo relê a vossa conversa e decide se há alguma coisa que valha a pena guardar para daqui a três meses. Na maioria das noites não há, e isso é normal.',
  },

  push: {
    title: 'Alertas no telemóvel',
    subtitle: 'Recebe um aviso assim que alguém disser que acabou uma tarefa — mesmo com a app fechada.',
    enable: 'Receber alertas',
    enabled: 'Alertas ligados neste telemóvel.',
    disable: 'Desligar',
    working: 'Um momento…',
    failed: 'Não foi possível mudar os alertas. Tenta outra vez.',
    deniedTitle: 'Bloqueaste os alertas neste telemóvel.',
    deniedHelp: 'Para voltar a recebê-los, tens de os permitir nas definições do telemóvel — o Capo já não pode voltar a perguntar.',
    iosTitle: 'No iPhone, só com o Capo instalado.',
    iosHelp: 'Os alertas no iPhone só funcionam com o Capo no ecrã principal.',
    iosLink: 'Ver como instalar',
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
    jobs: { title: 'Obras', subtitle: 'Progresso, atrasos e obras em pausa', empty: 'Ainda não há obras.' },
    jobDetail: {
      fallbackTitle: 'Obra',
      empty: 'Sem tarefas nesta obra ainda — pede ao Capo para criar o plano.',
      paused: 'Esta obra está em pausa: não há trabalho marcado e ninguém da equipa é chamado para ela. As tarefas ficam aqui até a retomares.',
    },
    taskActions: { complete: 'Concluir', reopen: 'Reabrir', failed: 'Falhou, tenta outra vez.' },
    taskReview: {
      declaredBy: name => `${name} diz que está feita:`,
      declaredByManager: 'A aguardar controlo:',
      declaredByUnknownWorker: 'Um trabalhador diz que está feita:',
      approve: 'Aprovar',
      reject: 'Rejeitar',
      dismiss: 'Não precisa controlo',
      request: 'Pedir controlo',
      failed: 'Não foi possível resolver o controlo',
      proofNone: 'Sem fotos anexadas.',
      proofPhotos: n => (n === 1 ? '1 foto anexada.' : `${n} fotos anexadas.`),
    },
    taskDetail: {
      fallbackTitle: 'Tarefa',
      backToTasks: '← Tarefas',
      assignee: 'Responsável',
      assigneeNoPhone: 'sem telemóvel registado',
      assigneeInactive: 'inativo',
      assignUnassigned: 'Atribuir a…',
      assignTitle: 'Quem faz esta tarefa?',
      assignAvailabilityOn: shortDate => `Quem está livre a ${shortDate}`,
      assignAvailabilityUnknown:
        'Esta tarefa não tem datas, por isso não dá para saber quem está livre.',
      assignFree: 'livre',
      assignBusy: n => (n === 1 ? 'já tem 1 tarefa nesse dia' : `já tem ${n} tarefas nesse dia`),
      assignNoneFree: 'Não há trabalhadores disponíveis para esta tarefa.',
      assignNoWorkers: 'Ainda não há trabalhadores ativos na equipa.',
      assignCurrent: 'atual',
      assignRemove: 'Deixar sem responsável',
      assignCancel: 'Cancelar',
      assignFailed: 'Não foi possível mudar o responsável.',
      collaborators: 'A ajudar',
      collaboratorsNone: 'Só o responsável nesta tarefa.',
      collaboratorsTitle: 'Quem mais ajuda nesta tarefa?',
      collaboratorsHint:
        'O responsável não muda — estas pessoas trabalham na mesma tarefa e recebem o aviso da manhã a dizer que estão a ajudar. O material continua a ser o desta tarefa, não se duplica.',
      collaboratorsLead: 'responsável',
      collaboratorsSave: 'Guardar',
      collaboratorsFailed: 'Não foi possível guardar quem ajuda nesta tarefa.',
      dates: 'Datas',
      startDate: 'Início',
      dueDate: 'Prazo',
      durationDays: days => `${days} ${days === 1 ? 'dia útil' : 'dias úteis'}`,
      description: 'Descrição',
      noDescription: 'Sem descrição. Pede ao Capo para acrescentar o que o trabalhador precisa de saber.',
      materials: 'Materiais',
      job: 'Obra',
      help: 'Ajuda',
      askCapo: 'Perguntar ao Capo sobre esta tarefa',
      askCapoPrompt: title => `Fala-me da tarefa "${title}".`,
      knowledge: 'O que dizem as normas',
      knowledgeHint: 'Leis, regulamentos e fichas técnicas relacionadas com esta tarefa.',
    },
    taskPhotos: {
      sheetTitle: 'Fotos do trabalho',
      sheetIntro: 'Mostra o que ficou feito — o pormenor acabado, não a obra toda.',
      addPhotos: 'Adicionar fotos',
      preparing: 'A preparar as fotos…',
      limitHint: (max, megabytes) => `Até ${max} fotos, ${megabytes} MB cada.`,
      remove: 'Remover foto',
      confirm: n => (n === 1 ? 'Concluir com 1 foto' : `Concluir com ${n} fotos`),
      skip: 'Concluir sem fotos',
      cancel: 'Cancelar',
      sending: 'A enviar…',
      sectionTitle: 'Fotos',
      sourceWorker: 'do trabalhador',
      sourceManager: 'tua',
      errors: {
        mime: 'Só entram fotografias (JPG, PNG ou WEBP).',
        too_large: 'Essa foto é grande demais.',
        empty: 'Escolhe pelo menos uma foto, ou carrega em «Concluir sem fotos».',
        too_many: 'São fotos a mais de uma só vez.',
        unknown_task: 'Essa tarefa já não existe.',
        upload_failed: 'Não foi possível enviar as fotos. Tenta outra vez.',
        generic: 'Falhou, tenta outra vez.',
      },
    },
    taskHelp: {
      title: 'Ajuda',
      intro:
        'Excertos da base de conhecimento partilhada, encontrados a partir do título e da descrição desta tarefa. Confirma sempre na fonte antes de decidir.',
      empty:
        'Nada encontrado sobre esta tarefa. Não quer dizer que não exista — quer dizer que não está na base de conhecimento.',
      failed: 'Não foi possível consultar a base de conhecimento agora.',
      backToTask: '← Voltar à tarefa',
      category: {
        lei: 'Lei',
        regulamento: 'Regulamento',
        tecnica: 'Técnica',
        material: 'Material',
        fabricante: 'Fabricante',
      },
    },
    materials: {
      title: 'Materiais',
      subtitle: 'O que tem de estar em obra',
      // ── issue #154 ─────────────────────────────────────────────────────
      today: 'Para hoje',
      todayHint: 'Marca o que já está em obra e o que falta. Recomeça do zero todas as manhãs.',
      emptyToday: 'Não há materiais registados para o trabalho de hoje.',
      onSite: 'Em obra',
      missing: 'Falta',
      checkedCount: (onSite, total) => `${onSite} de ${total} em obra`,
      checkFailed: 'Não deu para guardar. Tenta outra vez.',
      tomorrow: 'Para amanhã',
      week: 'Resto da semana',
      weekHint: 'Para encomendar já — o que tem prazo de entrega não espera.',
      emptyTomorrow:
        'Nada por confirmar para amanhã. Se houver trabalho agendado sem materiais registados, pergunta ao Capo o que falta.',
      forTasks: tasks => `para: ${tasks.join(', ')}`,
      pending: n => `${n} ${n === 1 ? 'material' : 'materiais'} para amanhã`,
      pendingHint: 'Confirma que está em obra antes de fechares o dia.',
    },
    // ── issue #60 ────────────────────────────────────────────────────────
    materialsEdit: {
      groupCount: n => (n === 1 ? '1 material' : `${n} materiais`),
      groupEmpty: 'Ainda sem materiais registados.',
      seeJob: 'Ver obra',
      add: 'Adicionar material',
      edit: 'Editar materiais',
      pickTask: 'Para que tarefa?',
      pickTaskHint: 'Os materiais pertencem a uma tarefa. Escolhe a tarefa a que este material é preciso.',
      taskCount: n => (n === 1 ? '1 material' : `${n} materiais`),
      title: task => `Materiais — ${task}`,
      placeholder: 'Ex.: 20 sacos de cimento',
      addRow: 'Adicionar linha',
      removeRow: 'Remover',
      empty: 'Ainda não há materiais nesta tarefa.',
      save: 'Guardar',
      saving: 'A guardar…',
      cancel: 'Cancelar',
      back: 'Voltar às tarefas',
      failed: 'Não foi possível guardar os materiais.',
      noTasks: 'Não há nenhuma tarefa nesta obra para receber materiais.',
    },
    // ── end issue #60 ────────────────────────────────────────────────────
  },

  auth: {
    showPassword: 'Mostrar palavra-passe',
    hidePassword: 'Esconder palavra-passe',
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
      emailNote:
        'A seguir enviamos-te um email com um link. Tens de o abrir para a conta ficar pronta.',
      haveAccount: 'Já tens conta?',
      signIn: 'Entra aqui',
      errors: {
        dados: 'Preenche um email válido e uma palavra-passe com pelo menos 8 caracteres.',
        fechado: 'Os registos abrem em breve — pede um convite.',
      },
    },
    confirmEmail: {
      title: 'Confirma o teu email',
      sentTo: ({ email }) => `Enviámos um email para ${email}.`,
      sentToUnknown: 'Enviámos-te um email com um link de confirmação.',
      blockedNotice:
        'A tua conta já existe, mas ainda não está confirmada — é por isso que a palavra-passe não te deixou entrar.',
      step1: 'Abre a tua caixa de correio.',
      step2: 'Procura o email do Capo. Se não o vires, vê no spam ou na publicidade.',
      step3: 'Carrega no link que vem lá dentro.',
      thenWhat:
        'Esse link abre o Capo já com a tua conta pronta. Não precisas de voltar a esta página.',
      resend: 'Reenviar o email',
      resent: 'Reenviámos o email. Pode demorar um minuto a chegar.',
      wrongEmail: 'Escreveste o email errado? Criar conta outra vez',
      alreadyConfirmed: 'Já carregaste no link? Entrar',
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
    noWhatsAppWarning: 'Sem telemóvel — não recebe o WhatsApp das 07:00.',
    noConsentWarning: 'Falta autorização — pergunta-lhe se aceita receber mensagens e diz ao Capo.',
    receivesWhatsApp: 'recebe o WhatsApp das 07:00',
    awaitingFirstReply:
      'Recebe o WhatsApp das 07:00, mas ainda nunca escreveu ao Capo. Até responder uma vez, o Capo não lhe consegue responder nem mandar-lhe o dia.',
    awaitingFirstReplyChase: p =>
      `Autorizado há ${p.days} dia${p.days === 1 ? '' : 's'} e ainda nunca escreveu ao Capo. Até responder uma vez, o Capo não lhe consegue responder nem mandar-lhe o dia. Vale a pena pedires-lhe em pessoa.`,
    firstReplyAction: 'Mandar-lhe uma mensagem',
    firstReplyMessage: p =>
      `Olá ${p.name}. Adicionei-te ao Capo. É ele que te manda as tarefas do dia por WhatsApp. Responde-lhe uma vez, nem que seja «sim»: sem isso ele consegue enviar-te mensagens, mas não te consegue responder nem mandar-te o teu dia.`,
    welcomeCostHint:
      'Quando dizes ao Capo que alguém aceita receber mensagens, o Capo apresenta-se a essa pessoa uma vez no WhatsApp. É uma mensagem paga por pessoa — uma equipa de 20 são 20 mensagens.',
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

  report: {
    row: { title: 'Reportar um problema', sub: 'Diz-nos o que não está a funcionar' },
    intro:
      'Conta o que correu mal, nas tuas palavras. Vai direto para a equipa do Capo, junto com a informação do ecrã — não precisas de explicar onde estavas.',
    label: 'O que aconteceu?',
    placeholder: 'Ex.: a lista de materiais mostra o mesmo azulejo duas vezes',
    submit: 'Enviar',
    sent: 'Recebido, obrigado. A equipa do Capo vai dar uma olhada.',
    empty: 'Escreve primeiro o que aconteceu.',
    failed: 'Não foi possível registar o reporte. Tenta outra vez.',
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
      'As mensagens da equipa no WhatsApp passam a ir na nova língua, e os materiais passam a ser agrupados pelos nomes traduzidos. Podes reverter durante 30 dias.',

    driftBanner: p => `O Capo fala contigo em ${p.you}, mas escreve as tarefas e as obras em ${p.board}.`,
    driftHint:
      'Faz sentido quando a equipa lê numa língua diferente da tua. Se não for o teu caso, põe as duas na mesma língua — o Capo traduz o que já existe.',
    driftAction: 'Pôr as duas na mesma língua',

    advanced: 'Definições avançadas',
    advancedHint:
      'Usa línguas diferentes para ti e para os dados da empresa — útil se falares uma língua diferente do resto da equipa.',
    yourLanguage: 'A tua língua',
    yourLanguageHint: 'A língua em que o Capo fala contigo e em que vês a app. Só afeta a ti.',
    companyLanguage: 'Língua dos dados da empresa',
    companyLanguageHint: 'A língua em que o Capo escreve tarefas, obras e notas — o que toda a equipa vê no painel.',
    companyLanguageWarning: 'Atenção: aqui as tarefas e obras já criadas não são traduzidas.',
    appearance: 'Aspeto',
    appearanceHint: 'Claro, escuro, ou o que o telemóvel usar. Fica guardado só neste aparelho.',
    themeOption: { light: 'Claro', dark: 'Escuro', system: 'Sistema' },
    confirmPosture: 'Confirmar alterações',
    confirmPostureHint:
      'Quando pedes ao Capo para mudar alguma coisa — criar uma tarefa, passá-la para outra pessoa, cancelar uma obra — ele pode perguntar primeiro ou avançar logo.',
    confirmPostureOption: { always_ask: 'Perguntar sempre', trust_quote: 'Avançar logo' },
    confirmPostureOptionHint: {
      always_ask:
        'Mais seguro. Cada alteração aparece primeiro como um cartão com «Aprovar» e «Rejeitar» — nada muda no painel enquanto não carregares. Custa um toque de cada vez.',
      trust_quote:
        'Mais rápido. O Capo avança logo quando consegue repetir as tuas palavras exatas a autorizar a alteração; se não conseguir, mostra o cartão na mesma.',
    },
    whatsappConsent: 'Mensagens no WhatsApp',
    whatsappConsentHint:
      'O resumo do dia de manhã e o ponto de situação ao fim da tarde, enviados para o teu número. Podes desligar quando quiseres.',
    whatsappConsentOption: { yes: 'Sim, quero receber', no: 'Não, obrigado' },
    whatsappConsentOn: 'Estás a receber as mensagens do dia.',
    whatsappConsentOff: 'Não estás a receber nada — liga aqui para começares.',
    whatsappConsentCost:
      'Ao ligares, o Capo apresenta-se uma vez no teu WhatsApp. Essa mensagem de boas-vindas é paga; as do dia-a-dia já estavam contadas.',

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

  whatsappHandshake: {
    title: 'Fala com o Capo no WhatsApp',
    subtitle: 'O Capo trabalha no WhatsApp, como tu e a tua equipa. Envia-lhe a primeira mensagem e ele começa a preparar a tua obra.',
    prefill: 'Olá Capo! Acabei de me registar. Ajudas-me a começar?',
    openButton: 'Abrir o WhatsApp',
    qrHint: 'Aponta a câmara do telemóvel para o código.',
    webLink: 'Abrir no WhatsApp Web',
    consentLabel: 'Envia-me o resumo do dia às 07:00 no WhatsApp',
    consentHint: 'Podes desligar isto quando quiseres, no teu perfil.',
    waiting: 'À espera da tua mensagem…',
    arrived: 'O Capo recebeu a tua mensagem. Vê o WhatsApp. ✅',
    stalled: phone => `Ainda não chegou nada. O ${phone} é o número do teu WhatsApp?`,
    fixNumber: 'Corrigir o número',
    skip: 'Fazer isto mais tarde',
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
        text: 'Cada trabalhador recebe no WhatsApp as tarefas do dia — sem apps, sem contas.',
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
    turnFailed: 'Desculpa, chefe — não consegui responder agora. Tenta outra vez daqui a pouco.',
    approveButton: 'Aprovar',
    rejectButton: 'Rejeitar',
    approvalPrompt: 'Aprovas esta proposta, chefe?',
    proposalApproved: '✅ Feito, chefe.',
    proposalRejected: '❌ Certo, não faço nada.',
    proposalFailed: reason => `⚠️ Aprovaste, mas não consegui executar: ${reason}`,
    proposalNotPending: 'Essa proposta já tinha sido decidida.',
    proposalError: 'Não consegui registar essa decisão. Trata dela na app.',
    approvalFallback: 'Não consegui mostrar os botões. Aprova ou rejeita na app.',
    workerAck: 'Recebido, obrigado. Qualquer dúvida fala com o teu encarregado.',
    workerLanguageChanged: 'Pronto — a partir de agora escrevo-te em português.',
    workerMenuButton: 'Ver tarefa',
    workerMenuSection: 'As tuas tarefas',
    workerMenuBody: (shown, total) =>
      shown < total
        ? `Tens ${total} tarefas em aberto — mostro-te as ${shown} mais próximas. Escolhe uma para veres os detalhes.`
        : total === 1
          ? 'Tens 1 tarefa em aberto. Escolhe para veres os detalhes.'
          : `Tens ${total} tarefas em aberto. Escolhe uma para veres os detalhes.`,
    workerMenuEmpty: 'Não tens nenhuma tarefa em aberto de momento. Se achas que devias ter, fala com o teu encarregado.',
    workerMenuManagerRow: 'Falar com o chefe',
    workerMenuManagerNote: 'Para tudo o que eu não posso resolver daqui',
    workerMenuManagerReply: 'Para isso fala com o teu encarregado — eu daqui só consigo ver as tuas tarefas e responder a dúvidas técnicas.',
    workerMenuUnknownTask: 'Já não consigo abrir essa tarefa. Escreve AJUDA para veres a lista outra vez.',
    workerOptedOut: 'Pronto, não te envio mais mensagens. Se mudares de ideias responde START.',
    workerOptedIn: 'Boa, voltas a receber as mensagens do dia. Responde STOP quando quiseres parar.',
    workerBudgetReached: 'Por hoje já não consigo responder a mais mensagens. Amanhã de manhã volto ao normal — se for urgente, fala com o teu encarregado.',
    workerAgentFailed: 'Não estou a conseguir responder agora. Tenta daqui a bocado ou fala com o teu encarregado.',
    workerPhotoFailed: 'Não consegui receber essa foto. Podes mandar outra vez?',
    checkinDoneButton: 'Sim, terminei',
    checkinNotDoneButton: 'Ainda não',
    checkinDone: 'Boa, obrigado. Fica registado que terminaste hoje.',
    checkinDoneAwaiting:
      'Boa, obrigado. Já avisei o teu encarregado — falta ele confirmar, por isso a tarefa ainda fica aberta até lá.',
    checkinDoneNothing: 'Obrigado, fica registado. Já não havia nada à espera de confirmação.',
    checkinDoneProblem:
      'Fica registada a tua resposta, mas não consegui avisar o teu encarregado. Fala com ele.',
    checkinNotDone: 'Certo, obrigado por avisares. Fica registado.',
    checkinPhotoAsk: task =>
      `Se puderes, manda-me uma foto de “${task}” que eu junto ao pedido. Se não der, não faz mal — o pedido segue na mesma.`,
    checkinPhotoNext: task => `Recebi a foto, obrigado. E de “${task}”, tens alguma?`,
    checkinPhotoThanks:
      'Recebi a foto, obrigado. Vai junto com o pedido — falta na mesma o teu encarregado confirmar.',
    checkinError: 'Não consegui registar a tua resposta. Fala com o teu encarregado.',
    stillWorking: 'Continuo a tratar disso, chefe — só mais um bocadinho.',
    workerStillWorking: 'Continuo a ver isso — só mais um bocadinho.',
    reportPrompt:
      'Diz-me o que está mal na aplicação ou nas minhas mensagens — a tua próxima mensagem fica registada para a equipa do Capo.',
    reportAck: 'Recebido, obrigado. Ficou registado para a equipa do Capo dar uma olhada.',
    reportFailed: 'Não consegui registar o teu reporte agora. Tenta outra vez daqui a pouco.',
  },

  dia: {
    title: 'O meu dia — Capo',
    dateLine: date => date,
    todayHeading: count => (count === 1 ? 'Hoje tens 1 tarefa' : `Hoje tens ${count} tarefas`),
    overdueHeading: count => (count === 1 ? 'Atrasada (1)' : `Atrasadas (${count})`),
    nothing: 'Não tens nada marcado para hoje. Bom trabalho.',
    askOnWhatsApp: 'Alguma dúvida? Responde ao Capo no WhatsApp.',
    expiredTitle: 'Este link já expirou',
    expired:
      'Os links duram um dia. Amanhã de manhã recebes um novo no WhatsApp, com a lista atualizada.',
  },
  reminders: {
    templateLanguage: 'pt_PT',
    taskSeparator: ' · ',
    taskWithJob: (title, job) => `${title} (${job})`,
    taskOverdue: (title, days) => `${title} — atrasada ${days}d`,
    andMore: n => `+${n}`,
    // issue #44. The clause that stops a helper reading their briefing as if
    // the job were theirs. Applied before taskOverdue, so lateness stays last.
    taskAsCollaborator: (title, lead) => `${title} — a ajudar ${lead}`,
    taskAsTeam: title => `${title} — em equipa`,
    freeFormWith: names => `Contigo: ${names}`,
    workerNothing: 'Nada agendado para hoje.',
    // issue #108. The day's size and how to see it — never the squashed task
    // list. One line, no trailing full stop: the OLD template body continues
    // "…{{2}}. Responde STOP…" straight after it.
    workerKnock: ({ count, overdue }) => {
      const head = `${count} ${count === 1 ? 'tarefa' : 'tarefas'} hoje`;
      const late = overdue > 0 ? `, ${overdue} ${overdue === 1 ? 'atrasada' : 'atrasadas'}` : '';
      return `${head}${late} — responde OK para veres o detalhe`;
    },
    managerSummary: ({ today, unassigned, overdue }) => {
      const parts = [`${today} ${today === 1 ? 'tarefa' : 'tarefas'} para hoje`];
      if (unassigned > 0) parts.push(`${unassigned} sem responsável`);
      if (overdue > 0) parts.push(`${overdue} ${overdue === 1 ? 'atrasada' : 'atrasadas'}`);
      return parts.join(' · ');
    },
    managerNothing: 'Nada agendado para hoje.',
    managerEvent: ({ today, unassigned, overdue, notified, names }) => {
      const parts = [`Bom dia. Hoje há ${today} ${today === 1 ? 'tarefa' : 'tarefas'} em curso`];
      if (overdue > 0) parts.push(`${overdue} ${overdue === 1 ? 'atrasada' : 'atrasadas'}`);
      if (unassigned > 0) parts.push(`${unassigned} sem responsável`);
      const head = parts.join(' · ');
      const who = names ? `: ${names}` : '';
      const tail =
        notified === 0
          ? 'Não enviei nada à equipa.'
          : `Enviei o resumo do dia a ${notified} ${notified === 1 ? 'pessoa' : 'pessoas'}${who}.`;
      return `${head}. ${tail}`;
    },
    checkinEvent: ({ asked, names }) => {
      if (asked === 0) return 'Ao fim da tarde não consegui perguntar a ninguém se acabou o trabalho de hoje.';
      const who = names ? `: ${names}` : '';
      return `Ao fim da tarde perguntei a ${asked} ${asked === 1 ? 'pessoa' : 'pessoas'} se acabaram o trabalho de hoje${who}. As respostas aparecem aqui à medida que chegam.`;
    },
    checkinAnswer: ({ name, answer, tasks }) => {
      const count = tasks > 0 ? ` (${tasks} ${tasks === 1 ? 'tarefa' : 'tarefas'})` : '';
      return answer === 'done'
        ? `${name} respondeu ao check-in: diz que acabou o trabalho de hoje${count}. Fica à espera da tua confirmação — até lá o trabalho continua em aberto.`
        : `${name} respondeu ao check-in: ainda não acabou o trabalho de hoje${count}.`;
    },
    nameSeparator: ', ',
    freeFormGreeting: name => `Bom dia, ${name}.`,
    freeFormHeader: count => `Hoje tens ${count} ${count === 1 ? 'tarefa' : 'tarefas'}:`,
    freeFormDescription: text => text,
    freeFormMaterials: items => `Material: ${items}`,
    freeFormMaterialSeparator: ', ',
    freeFormAddress: text => `Morada: ${text}`,
    freeFormWaitingOn: items => `Depende de: ${items}`,
    freeFormAwaitingReview: 'Já disseste que acabaste — à espera da confirmação do chefe.',
    detailHeader: title => `📋 ${title}`,
    detailDue: date => `Prazo: ${date}`,
    detailNothingMore: 'Não tenho mais detalhes sobre esta tarefa. Se precisares, fala com o teu encarregado.',
    detailOverdue: title => `${title} — atrasada`,
    languageHint: 'Responde PT, ES ou EN para mudares de idioma',
    dayLinkCta: '🔗 Vê a tua lista completa aqui:',
    welcomeWorker: company =>
      `A ${company} pôs o teu número no Capo: a partir de agora recebes aqui as tarefas de cada dia e podes responder-me com dúvidas. Escreve PT, ES ou EN para mudares de idioma.`,
    welcomeManager: company =>
      `A tua conta da ${company} está pronta: recebes aqui o resumo de cada manhã e podes falar comigo por WhatsApp tal como falas na aplicação.`,
    welcomeGreeting: name => `Olá ${name}, sou o Capo, o assistente de obra.`,
    welcomeStop: 'Responde STOP para deixar de receber.',
    welcomeEvent: ({ notified, names }) => {
      const who = names ? `: ${names}` : '';
      return `Apresentei-me a ${notified} ${notified === 1 ? 'pessoa nova' : 'pessoas novas'} da equipa no WhatsApp${who}.`;
    },
  },
};

export default dict;
