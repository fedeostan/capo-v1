import type { Catalog } from '../catalog';

// Peninsular Spanish. Register mirrors the pt-PT original: jobsite, informal,
// second person singular ("tú"), never neutral-LatAm.
const dict: Catalog = {
  meta: {
    htmlLang: 'es-ES',
    dateLocale: 'es-ES',
    appName: 'Capo',
    appDescription: 'Tu capataz virtual',
    languageName: 'Español',
    titleSuffix: 'Capo',
  },

  nav: { chat: 'Chat', tasks: 'Tareas', jobs: 'Obras', materials: 'Materiales', profile: 'Perfil' },

  common: {
    signOut: 'Salir',
    save: 'Guardar',
    backToLogin: 'Volver a entrar',
    notAuthenticated: 'No autenticado',
  },

  pullToRefresh: { refreshing: 'Actualizando…' },

  chat: {
    title: 'Capo 👷',
    tagline: 'Tu capataz virtual',
    placeholder: 'Escribe, habla, o pega el presupuesto…',
    send: 'Enviar',
    typing: 'El Capo está escribiendo…',
    stop: 'Parar',
    errorTitle: 'El Capo no ha podido responder.',
    errorHints: {
      billing: 'La suscripción ha caducado. Ve a Suscripción para reactivarla.',
      auth: 'La sesión ha terminado. Vuelve a entrar.',
      network: 'Sin conexión. Comprueba la red e inténtalo otra vez.',
      generic: 'Puede haber sido la red o un fallo momentáneo. Tu mensaje no se ha perdido.',
    },
    retry: 'Intentar otra vez',
    dismiss: 'Descartar',
    emptyThread: 'Habla con el Capo — él se encarga de las obras, las tareas y el equipo.',
    proposalTitle: 'Propuesta del Capo',
    pendingProposals: 'Propuestas por decidir',
    approve: 'Aprobar',
    reject: 'Rechazar',
    deciding: 'Aplicando…',
    cardState: {
      approved: '✅ Aprobada — ejecutada',
      rejected: '❌ Rechazada',
      failed: '⚠️ Aprobada, pero la ejecución falló',
      not_pending: 'Esta propuesta ya se ha resuelto',
      error: '⚠️ Error al resolver la propuesta',
    },
    toolLabels: {
      create_task: 'Tarea creada',
      update_task: 'Tarea actualizada',
      list_tasks: 'Tareas consultadas',
      agenda: 'Agenda consultada',
      materials_outlook: 'Materiales consultados',
      create_job: 'Obra creada',
      update_job: 'Obra actualizada',
      list_jobs: 'Obras consultadas',
      add_worker: 'Trabajador añadido',
      update_worker: 'Trabajador actualizado',
      list_workers: 'Equipo consultado',
      remember: 'Memorizado',
      search_knowledge: 'Base de conocimiento consultada',
      set_language: 'Idioma cambiado',
      translate_company_data: 'Traducción propuesta',
      propose: 'Propuesta creada',
      generate_plan: 'Plan generado',
    },
  },

  mic: {
    record: 'Grabar mensaje de voz',
    stop: 'Parar grabación',
    noAccess: 'Sin acceso al micrófono',
    notUnderstood: 'No te he entendido — inténtalo otra vez',
    error: 'Error al transcribir',
  },

  dashboard: {
    taskStatus: {
      pending: 'Pendiente',
      in_progress: 'En curso',
      blocked: 'Bloqueada',
      done: 'Terminada',
      cancelled: 'Cancelada',
    },
    overdueBy: days => (days === 1 ? 'Plazo vencido hace 1 día' : `Plazo vencido hace ${days} días`),
    noAssignee: 'Sin responsable',
    assignedTo: name => `Asignada a ${name}`,
    noJob: 'Sin obra',
    noDate: 'Sin fecha',
    talkToCapo: 'Hablar con el Capo',
    dueBy: shortDate => `hasta ${shortDate}`,
    risk: {
      blocked: 'bloqueada',
      lateStart: 'ya debería haber empezado',
      dueSoon: 'plazo en 2 días laborables',
      lateDependency: titles => `espera a: ${titles.join(', ')}`,
      pausedJob: 'obra en pausa',
    },
    progress: (done, total, pct) => `${done} de ${total} terminadas (${pct}%)`,
    tasksDone: (done, total) => `${done} de ${total} tareas terminadas`,
    noTasksRegistered: 'sin tareas registradas',
    overdueCount: n => `${n} ${n === 1 ? 'atrasada' : 'atrasadas'}`,
    pendingCount: n => `${n} ${n === 1 ? 'pendiente' : 'pendientes'}`,
    dependsOn: titles => `⤷ después de: ${titles.join(', ')}`,
  },

  screens: {
    tasks: {
      title: 'Tareas',
      quando: {
        hoje: 'Hoy',
        amanha: 'Mañana',
        atrasadas: 'Atrasadas',
        risco: 'En riesgo',
        todas: 'Todas',
      },
      empty: {
        hoje: 'Nada programado para hoy.',
        amanha: 'Nada programado para mañana.',
        atrasadas: 'Ninguna tarea fuera de plazo. Buena señal.',
        risco: 'Nada en riesgo por ahora.',
        todas: 'Sin tareas abiertas.',
      },
      emptyForDate: 'Nada programado para ese día.',
      emptyFallback: 'Sin tareas.',
      emptyInJob: base => `${base.replace(/\.$/, '')} en esta obra.`,
      count: n => `${n} ${n === 1 ? 'tarea' : 'tareas'}`,
      filterByJob: 'Filtrar por obra',
      filterByDay: 'Filtrar por día',
      allJobs: 'Todas las obras',
      jobStatusSuffix: { paused: ' (en pausa)', done: ' (terminada)' },
    },
    jobs: { title: 'Obras', subtitle: 'Obras activas — progreso y atrasos', empty: 'Sin obras activas.' },
    jobDetail: {
      fallbackTitle: 'Obra',
      empty: 'Todavía no hay tareas en esta obra — pídele al Capo que haga el plan.',
    },
    taskActions: { complete: 'Terminar', reopen: 'Reabrir', failed: 'Ha fallado, inténtalo otra vez.' },
    taskDetail: {
      fallbackTitle: 'Tarea',
      backToTasks: '← Tareas',
      assignee: 'Responsable',
      assigneeNoPhone: 'sin móvil registrado',
      assigneeInactive: 'inactivo',
      dates: 'Fechas',
      startDate: 'Inicio',
      dueDate: 'Plazo',
      durationDays: days => `${days} ${days === 1 ? 'día laborable' : 'días laborables'}`,
      description: 'Descripción',
      noDescription: 'Sin descripción. Pídele al Capo que añada lo que el trabajador necesita saber.',
      materials: 'Materiales',
      job: 'Obra',
      help: 'Ayuda',
      askCapo: 'Preguntar al Capo sobre esta tarea',
      askCapoPrompt: title => `Háblame de la tarea "${title}".`,
      knowledge: 'Qué dicen las normas',
      knowledgeHint: 'Leyes, reglamentos y fichas técnicas relacionadas con esta tarea.',
    },
    taskHelp: {
      title: 'Ayuda',
      intro:
        'Extractos de la base de conocimiento compartida, encontrados a partir del título y la descripción de esta tarea. Confírmalo siempre en la fuente antes de decidir.',
      empty:
        'No se ha encontrado nada sobre esta tarea. No significa que no exista — significa que no está en la base de conocimiento.',
      failed: 'No se ha podido consultar la base de conocimiento ahora.',
      backToTask: '← Volver a la tarea',
      category: {
        lei: 'Ley',
        regulamento: 'Reglamento',
        tecnica: 'Técnica',
        material: 'Material',
        fabricante: 'Fabricante',
      },
    },
    materials: {
      title: 'Materiales',
      subtitle: 'Lo que tiene que estar en obra',
      tomorrow: 'Para mañana',
      week: 'Resto de la semana',
      weekHint: 'Para pedir ya — lo que tiene plazo de entrega no espera.',
      emptyTomorrow:
        'Nada por confirmar para mañana. Si hay trabajo programado sin materiales registrados, pregúntale al Capo qué falta.',
      forTasks: tasks => `para: ${tasks.join(', ')}`,
      pending: n => `${n} ${n === 1 ? 'material' : 'materiales'} para mañana`,
      pendingHint: 'Comprueba que está en obra antes de cerrar el día.',
    },
  },

  auth: {
    login: {
      title: 'Capo',
      email: 'Email',
      emailPlaceholder: 'tu.email@empresa.es',
      password: 'Contraseña',
      submit: 'Entrar',
      google: 'Entrar con Google',
      forgot: '¿Has olvidado la contraseña?',
      createAccount: 'Crear cuenta',
      errors: {
        credenciais: 'Email o contraseña incorrectos. Compruébalo e inténtalo de nuevo.',
        'link-invalido': 'El enlace ha caducado o ya se ha usado. Pide uno nuevo.',
      },
    },
    signup: {
      title: 'Crear cuenta',
      subtitle: '14 días gratis. Sin tarjeta de crédito.',
      submit: 'Crear cuenta',
      checkEmailTitle: 'Confirma tu email',
      checkEmailText: 'Te hemos enviado un enlace de confirmación — ábrelo para empezar.',
      alreadyConfirmed: '¿Ya lo has confirmado? Entra aquí',
      haveAccount: '¿Ya tienes cuenta?',
      signIn: 'Entra aquí',
      errors: {
        dados: 'Introduce un email válido y una contraseña de al menos 8 caracteres.',
        fechado: 'Los registros abren pronto — pide una invitación.',
      },
    },
    recover: {
      title: 'Recuperar contraseña',
      subtitle: 'Dinos tu email y te enviamos un enlace.',
      submit: 'Enviar enlace',
      sentTitle: 'Revisa tu email',
      sentText: 'Si existe una cuenta con ese email, te hemos enviado un enlace para restablecer la contraseña.',
      errors: { dados: 'Introduce un email válido.' },
    },
    newPassword: {
      title: 'Nueva contraseña',
      label: 'Contraseña nueva',
      errors: {
        curta: 'La contraseña tiene que tener al menos 8 caracteres.',
        guardar: 'No se ha podido guardar. Pide un nuevo enlace de recuperación.',
      },
    },
  },

  onboarding: {
    title: 'Bienvenido al Capo',
    subtitle: 'Solo faltan unos datos para empezar: tu empresa, tu móvil y el idioma.',
    companyName: 'Nombre de la empresa',
    companyPlaceholder: 'Construcciones García, S.L.',
    yourName: 'Tu nombre',
    yourNamePlaceholder: 'Juan García',
    phone: 'Tu móvil',
    phonePlaceholder: '612 345 678',
    phoneHint: 'Es por aquí que puedes hablar con el Capo en WhatsApp, sin abrir la app.',
    language: 'Idioma',
    languageHint: 'Puedes cambiarlo después — solo tienes que decírselo al Capo.',
    submit: 'Empezar',
    errors: {
      dados: 'Rellena el nombre de la empresa y tu nombre.',
      telemovel: 'Número no válido. Usa el formato 612 345 678 o +34 612 345 678.',
      'telemovel-usado': 'Ese número ya está asociado a otra cuenta.',
      guardar: 'No se ha podido guardar. Inténtalo de nuevo.',
    },
  },

  profile: {
    title: 'Perfil',
    company: 'Empresa',
    yourAccount: 'Tu cuenta',
    team: 'Equipo',
    teamEmpty: 'Todavía no hay nadie en el equipo.',
    teamEmptyCta: 'Pídele al Capo que añada a alguien',
    noContact: 'Sin contacto',
    inactive: 'inactivo',
    workerLoad: (today, tomorrow, open) => `Hoy ${today} · Mañana ${tomorrow} · ${open} abiertas`,
    noWhatsAppWarning: 'Sin móvil — no recibe el WhatsApp de las 07:00.',
    receivesWhatsApp: 'recibe el WhatsApp de las 07:00',
    teamHint: 'Para añadir o cambiar a alguien,',
    teamHintLink: 'habla con el Capo',
    subscription: 'Suscripción',
    manageSubscription: 'Gestionar suscripción',
    app: 'App',
    install: 'Instalar en el móvil',
    companyNameLabel: 'Nombre de la empresa',
    fullNameLabel: 'Tu nombre',
    phoneLabel: 'Tu móvil',
    errors: {
      companyName: 'El nombre de la empresa tiene que tener entre 1 y 120 caracteres.',
      fullName: 'El nombre tiene que tener entre 1 y 120 caracteres.',
      phone: 'Número no válido. Usa el formato +34612345678.',
      phoneTaken: 'Ese número ya está asociado a otra cuenta.',
      save: 'No se ha podido guardar. Inténtalo otra vez.',
    },
  },

  settings: {
    language: 'Idioma',
    languageHint:
      'El idioma en el que el Capo habla contigo, en el que ves la app, y en el que se escriben las tareas, obras y notas de toda la empresa.',
    translateExisting: p => {
      const parts: string[] = [];
      if (p.tasks) parts.push(`${p.tasks} tarea${p.tasks === 1 ? '' : 's'}`);
      if (p.jobs) parts.push(`${p.jobs} obra${p.jobs === 1 ? '' : 's'}`);
      if (p.workers) parts.push(`${p.workers} oficio${p.workers === 1 ? '' : 's'}`);
      if (p.memories) parts.push(`${p.memories} nota${p.memories === 1 ? '' : 's'}`);
      const last = parts.pop();
      if (!last) return 'Traducir también lo que ya existe';
      const list = parts.length > 0 ? `${parts.join(', ')} y ${last}` : last;
      return `Traducir también lo que ya existe (${list})`;
    },
    translateNothing: 'Todavía no hay nada guardado que traducir.',
    translateWarning:
      'Los mensajes del equipo en WhatsApp pasarán a enviarse en el nuevo idioma, y los materiales se agruparán por los nombres traducidos. Puedes revertirlo durante 30 días.',

    advanced: 'Ajustes avanzados',
    advancedHint:
      'Usa idiomas distintos para ti y para los datos de la empresa — útil si hablas un idioma diferente al del resto del equipo.',
    yourLanguage: 'Tu idioma',
    yourLanguageHint: 'El idioma en el que el Capo habla contigo y en el que ves la app. Solo te afecta a ti.',
    companyLanguage: 'Idioma de los datos de la empresa',
    companyLanguageHint:
      'El idioma en el que el Capo escribe tareas, obras y notas — lo que todo el equipo ve en el panel.',
    companyLanguageWarning: 'Ojo: aquí las tareas y obras ya creadas no se traducen.',
    appearance: 'Aspecto',
    appearanceHint: 'Claro, oscuro, o lo que use el móvil. Se guarda solo en este dispositivo.',
    themeOption: { light: 'Claro', dark: 'Oscuro', system: 'Sistema' },

    translationRunning: p => `Traduciendo… ${p.done} de ${p.total}`,
    translationDone: n => `${n} campo${n === 1 ? '' : 's'} traducido${n === 1 ? '' : 's'}.`,
    translationFailed: 'La traducción se ha parado a medias. No se ha perdido nada — puedes reanudarla.',
    translationResume: 'Reanudar traducción',
    revert: 'Revertir traducción',
    revertHint: days =>
      `Restaura el texto original exactamente como estaba, palabra por palabra. Disponible durante ${days} días.`,
    reverted: 'Traducción revertida.',
    revertFailed: 'No se ha podido revertir. Inténtalo de nuevo.',

    saved: 'Guardado.',
    failed: 'No se ha podido guardar. Inténtalo de nuevo.',
  },

  billing: {
    title: 'Suscripción',
    activated: '¡Suscripción activada. Gracias!',
    unavailable: 'La facturación todavía no está disponible.',
    trialDaysLeft: days => `${days} días de prueba gratis restantes`,
    trialEnded: 'Periodo de prueba terminado',
    statusLabel: {
      active: 'Suscripción activa',
      past_due: 'Pago pendiente',
      canceled: 'Suscripción cancelada',
    },
    price: '45 €/mes · sin tarjeta para empezar · sin coste por trabajador',
    manage: 'Gestionar suscripción',
    subscribe: 'Suscribirse — 45 €/mes',
    bannerBlocked:
      'Tu suscripción ha caducado — WhatsApp sigue funcionando, pero el chat de aquí y las acciones quedan bloqueados. Toca para reactivar.',
    bannerTrial: days => `Quedan ${days} días de prueba gratis — toca para suscribirte.`,
    bannerTrialEnded: 'El periodo de prueba ha terminado — toca para suscribirte.',
    blockedError: 'Tu suscripción ha caducado. Ve a Suscripción para reactivarla — WhatsApp sigue funcionando.',
    checkoutFailed: 'No se ha podido iniciar el pago.',
    noSubscription: 'Todavía no tienes una suscripción asociada.',
  },

  install: {
    title: 'Instala el Capo',
    subtitle: 'Con el Capo en la pantalla de inicio, abres la app de un toque — como WhatsApp.',
    alreadyInstalled: 'El Capo ya está instalado en este aparato. 💪',
    open: 'Abrir el Capo',
    installButton: 'Instalar aplicación',
    skip: 'Continuar sin instalar',
    iosStep1Before: 'Toca en',
    iosStep1Share: 'Compartir',
    iosStep1After: 'en la barra de Safari.',
    iosStep2Before: 'Elige',
    iosStep2Action: 'Añadir a pantalla de inicio',
    iosStep3Before: 'Toca en',
    iosStep3Action: 'Añadir',
    iosStep3After: 'El Capo se queda en tu pantalla como una app.',
    genericStep1Before: 'Abre el menú del navegador',
    genericStep2Before: 'Elige',
    genericStep2Action: 'Instalar aplicación',
    genericStep2After: '(o «Añadir a pantalla de inicio»).',
  },

  landing: {
    metaTitle: 'Capo — El asistente que gestiona tu WhatsApp',
    metaDescription:
      'El asistente de IA que gestiona tu WhatsApp y se ocupa del papeleo de la obra. Manda el presupuesto, el Capo hace el plan día a día, el equipo recibe el parte por la mañana.',
    ogDescription:
      'Manda el presupuesto, el Capo hace el plan día a día y avisa al equipo cada mañana. 45 €/mes, 14 días gratis.',
    headline: 'El asistente que gestiona tu WhatsApp y se ocupa del papeleo de la obra',
    subhead:
      'No es software de gestión de obras. Es el capataz virtual que habla contigo por WhatsApp, organiza al equipo y nunca olvida lo que falta.',
    ctaPrimary: 'Empezar gratis — 14 días',
    ctaSecondary: 'Ya tengo cuenta — Entrar',
    stepLabel: n => `Paso ${n}`,
    steps: [
      {
        title: 'Manda el presupuesto',
        text: 'Pega el presupuesto o describe la obra en un mensaje — como se lo contarías a un capataz.',
      },
      {
        title: 'El Capo hace el plan día a día',
        text: 'Secuencia de tareas, fechas y materiales, listos para que los apruebes en una tarjeta.',
      },
      {
        title: 'El equipo recibe el parte por la mañana',
        text: 'Cada trabajador recibe por WhatsApp las tareas del día — sin apps, sin cuentas.',
      },
    ],
    materialsTitle: 'Previsión de materiales',
    materialsText:
      'El Capo avisa al equipo con antelación de qué materiales van a necesitar mañana — se acabó descubrir el mismo día que falta algo.',
    priceSuffix: '/mes',
    priceNote: '14 días gratis · sin tarjeta · sin coste por trabajador',
    ctaFooter: 'Empezar gratis',
    signIn: 'Entrar',
  },

  offline: {
    title: 'Sin conexión',
    text: 'El Capo necesita internet para mostrar datos actualizados. Comprueba la conexión e inténtalo de nuevo.',
  },

  whatsapp: {
    voiceNoteFailed: 'No he podido escuchar ese audio, jefe. ¿Lo repites o me lo escribes?',
    voiceNoteEmpty: 'Me ha llegado el audio pero no se entiende nada. ¿Lo repites?',
    approveButton: 'Aprobar',
    rejectButton: 'Rechazar',
    approvalPrompt: '¿Apruebas esta propuesta, jefe?',
    proposalApproved: '✅ Hecho, jefe.',
    proposalRejected: '❌ Vale, no hago nada.',
    proposalFailed: reason => `⚠️ Lo aprobaste, pero no pude ejecutarlo: ${reason}`,
    proposalNotPending: 'Esa propuesta ya estaba decidida.',
    proposalError: 'No he podido registrar esa decisión. Hazlo desde la app.',
    approvalFallback: 'No he podido mostrar los botones. Apruébalo o recházalo en la app.',
    workerAck: 'Recibido, gracias. Si tienes dudas habla con tu encargado. Para cambiar de idioma responde PT, ES o EN.',
    workerLanguageChanged: 'Hecho — a partir de ahora te escribo en español.',
  },

  reminders: {
    templateLanguage: 'es_ES',
    taskSeparator: ' · ',
    taskWithJob: (title, job) => `${title} (${job})`,
    taskOverdue: (title, days) => `${title} — retrasada ${days}d`,
    andMore: n => `+${n}`,
    workerNothing: 'Nada previsto para hoy.',
    managerSummary: ({ today, unassigned, overdue }) => {
      const parts = [`${today} ${today === 1 ? 'tarea' : 'tareas'} para hoy`];
      if (unassigned > 0) parts.push(`${unassigned} sin responsable`);
      if (overdue > 0) parts.push(`${overdue} ${overdue === 1 ? 'retrasada' : 'retrasadas'}`);
      return parts.join(' · ');
    },
    managerNothing: 'Nada previsto para hoy.',
    managerEvent: ({ today, unassigned, overdue, notified }) => {
      const parts = [`Buenos días. Hoy hay ${today} ${today === 1 ? 'tarea' : 'tareas'} en curso`];
      if (overdue > 0) parts.push(`${overdue} ${overdue === 1 ? 'retrasada' : 'retrasadas'}`);
      if (unassigned > 0) parts.push(`${unassigned} sin responsable`);
      const head = parts.join(' · ');
      const tail =
        notified === 0
          ? 'No he enviado nada al equipo.'
          : `He enviado el resumen a ${notified} ${notified === 1 ? 'persona' : 'personas'}.`;
      return `${head}. ${tail}`;
    },
  },
};

export default dict;
