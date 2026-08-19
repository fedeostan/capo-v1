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
      pending_review: 'Pendiente de control',
      blocked: 'Bloqueada',
      done: 'Terminada',
      cancelled: 'Cancelada',
    },
    overdueBy: days => (days === 1 ? 'Plazo vencido hace 1 día' : `Plazo vencido hace ${days} días`),
    noAssignee: 'Sin responsable',
    assignedTo: name => `Asignada a ${name}`,
    noJob: 'Sin obra',
    noDate: 'Sin fecha',
    jobPaused: 'En pausa',
    jobPausedHint: 'Sin trabajo previsto por ahora. Las tareas siguen aquí.',
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

  notifications: {
    title: 'Notificaciones',
    subtitle: 'Lo que ha pasado desde la última vez que miraste.',
    empty: 'Nada por leer. Cuando un trabajador dé una tarea por hecha, aparecerá aquí.',
    banner: n => `${n} ${n === 1 ? 'novedad' : 'novedades'}`,
    markAllRead: 'Marcar todo como leído',
    failed: 'No se ha podido marcar como leído.',
    unread: 'Sin leer',
    profileLink: 'Notificaciones',
    kind: {
      review_pending: subject => `“${subject}” está pendiente de tu control.`,
    },
    noSubject: 'Una tarea',
    noteLabel: 'Lo que han escrito:',
    openSubject: 'Ver en tareas',
    pushNudge: '¿Quieres recibir estos avisos en el móvil?',
    pushNudgeLink: 'Activar alertas',
  },

  automations: {
    title: 'Mensajes automáticos',
    subtitle: 'Lo que Capo envía al equipo por su cuenta, a qué hora, y qué pasó cada día.',
    profileLink: 'Ver mensajes automáticos',
    costNote:
      'Cada persona que recibe uno de estos mensajes cuenta como un envío de pago en WhatsApp. Más gente en el equipo, o más mensajes al día, es más coste.',

    job: {
      daily_briefing: {
        name: 'Mensaje de la mañana',
        what: 'Dice a cada persona qué tiene hoy: obra, dirección, material y de qué depende.',
        who: 'Todo el equipo activo con WhatsApp autorizado, y cada responsable de la empresa.',
      },
      task_checkin: {
        name: 'Pregunta del final del día',
        what: 'Pregunta «¿has acabado las tareas de hoy?», con dos botones para responder.',
        who: 'Solo quien es responsable de una tarea hoy. Quien solo ayuda no lo recibe.',
      },
    },

    aimedAt: (hour: string) => `Apuntado a las ${hour}`,
    window: (from: string, to: string) => `Llega entre las ${from} y las ${to}`,
    nextRun: (when: string) => `Siguiente: ${when}`,
    usingDefault: 'Usando la hora de origen — nadie la ha cambiado.',
    on: 'Activado',
    off: 'Desactivado',
    enabledLabel: 'Enviar este mensaje',
    hourLabel: 'Hora',
    saved: 'Guardado.',
    saveFailed: 'No he podido guardar. Inténtalo otra vez.',
    invalidHour: 'Elige una hora entre las 05:00 y las 21:00.',

    addTitle: 'Añadir otro mensaje',
    addExplanation:
      'Todavía no se puede crear un mensaje nuevo desde aquí, y el motivo está en WhatsApp: un mensaje que Capo envía sin que nadie haya escrito antes tiene que usar un texto aprobado por Meta de antemano. Un texto escrito por ti no saldría. Mientras tanto, lo que sí puedes hacer es cambiar la hora de estos dos o desactivar el que no quieras.',

    historyTitle: 'Qué ha pasado',
    historyHint:
      'Una línea por día y por mensaje: a qué hora estaba previsto y a qué hora salió de verdad. El sitio donde alojamos Capo suele llamar a la puerta con algo de retraso, así que las dos horas rara vez coinciden.',
    historyEmpty: 'Todavía no hay nada registrado.',
    due: 'Previsto',
    ran: 'Salió',
    lateBy: (minutesLabel: string) => `${minutesLabel} de retraso`,
    onTime: 'A la hora',
    messagedCount: (n: number) => (n === 1 ? '1 persona avisada' : `${n} personas avisadas`),
    failedCount: (n: number) => (n === 1 ? '1 ha fallado' : `${n} han fallado`),
    skippedCount: (n: number) => (n === 1 ? '1 sin nada que decir' : `${n} sin nada que decir`),
    nothingSent: 'No salió nada este día.',

    debugTitle: 'Persona a persona',
    debugHint: 'Quién lo recibió, quién no, y por qué.',
    recipientWorker: 'Equipo',
    recipientManager: 'Responsable',
    outcome: {
      sent: 'Entregado a Meta',
      delivered: 'Llegó al móvil',
      read: 'Leído',
      failed: 'Falló',
      skipped: 'No enviado',
      pending: 'Sin confirmar',
    },
    outcomeHint: {
      sent: 'Meta aceptó el mensaje, pero aún no ha confirmado que llegara.',
      delivered: 'Meta ha confirmado que el mensaje llegó al móvil.',
      read: 'La persona abrió el mensaje.',
      failed: 'Meta lo rechazó o no consiguió entregarlo.',
      skipped: 'No había nada que decirle a esta persona ese día.',
      pending: 'El envío empezó y no llegó a terminar.',
    },

    reasonTitle: 'Quién no recibe nada, y por qué',
    reason: {
      noConsent: 'No ha autorizado recibir WhatsApp.',
      unreachable: 'No tiene número ni otra forma de contacto.',
      inactive: 'Está marcado como inactivo en el equipo.',
      managerNoConsent: 'El responsable no ha autorizado recibir WhatsApp.',
      noManagerAccount: 'Esta empresa no tiene ninguna cuenta de responsable, así que el resumen diario no va a ninguna parte.',
    },
    reasonNamesHint:
      'Los nombres de aquí abajo son de ahora, no del día en cuestión — las cuentas de cada día quedan guardadas, los nombres no.',
    reasonNobody: 'No se está quedando nadie fuera.',

    metaError: {
      '132001': 'El texto aprobado todavía no existe en este idioma.',
      '131030': 'El número no está en la lista de prueba. Esto ya no debería pasar.',
      '131026': 'Este número no tiene WhatsApp.',
      '131047': 'Han pasado más de 24 horas desde el último mensaje de esta persona, así que solo sale texto aprobado.',
      '131021': 'Hemos intentado enviar a nuestro propio número.',
      '132000': 'El texto enviado no encaja en el formato aprobado.',
    },
    metaErrorUnknown: 'Meta rechazó el envío.',
    metaErrorLabel: (code: number) => `Código ${code}`,
  },

  memory: {
    title: 'Memoria',
    subtitle: 'Lo que Capo recuerda de ti y de la empresa — y cómo hacer que lo olvide.',
    profileLink: 'Ver lo que Capo recuerda',
    explainer:
      'Capo no “aprende” solo: todo lo que sabe de una conversación a otra está escrito aquí, en frases sueltas, y es esto lo que vuelve a leer antes de cada respuesta. Si algo de esta lista está mal o ya no tiene sentido, bórralo — deja de contar al momento.',

    companyHeading: 'Sobre la empresa',
    companyHint: 'Todas las personas con cuenta en esta empresa las ven.',
    personalHeading: 'Sobre ti',
    personalHint: 'Solo tú las ves. Nadie más en la empresa las toca.',
    empty: 'Todavía no hay nada guardado.',

    capTitle: 'Lo que Capo lleva consigo',
    capHint: (carried: number, limit: number) =>
      `Capo lleva las ${limit} notas más recientes a cada conversación. Ahora lleva ${carried}.`,
    storedNotCarried: 'Guardada, pero fuera de las más recientes — Capo no la está leyendo.',

    forget: 'Olvidar',
    forgotten: 'Olvidado.',
    forgetFailed: 'No he podido borrarlo. Inténtalo otra vez.',
    forgetNote:
      'Olvidar saca la nota de la cabeza de Capo para siempre. El registro de que existió se conserva, por si algún día quieres entender por qué respondió de cierta manera.',

    kind: {
      company: 'Empresa',
      job: 'Obra',
      worker: 'Equipo',
      preference: 'Preferencia',
      fact: 'Hecho',
    },

    reviewTitle: 'Revisión de la noche',
    lastReviewed: (when: string) => `Última revisión: ${when}`,
    neverReviewed: 'Todavía no ha habido ninguna revisión.',
    reviewHint:
      'Cada noche, de madrugada, Capo relee vuestra conversación y decide si hay algo que merezca la pena guardar para dentro de tres meses. La mayoría de las noches no lo hay, y eso es normal.',
  },

  push: {
    title: 'Alertas en el móvil',
    subtitle: 'Recibe un aviso en cuanto alguien diga que ha acabado una tarea — incluso con la app cerrada.',
    enable: 'Recibir alertas',
    enabled: 'Alertas activadas en este móvil.',
    disable: 'Desactivar',
    working: 'Un momento…',
    failed: 'No se han podido cambiar las alertas. Inténtalo otra vez.',
    deniedTitle: 'Has bloqueado las alertas en este móvil.',
    deniedHelp: 'Para volver a recibirlas, tienes que permitirlas en los ajustes del móvil — Capo ya no puede volver a preguntar.',
    iosTitle: 'En iPhone, solo con Capo instalado.',
    iosHelp: 'Las alertas en iPhone solo funcionan con Capo en la pantalla de inicio.',
    iosLink: 'Ver cómo instalarlo',
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
    jobs: { title: 'Obras', subtitle: 'Progreso, atrasos y obras en pausa', empty: 'Todavía no hay obras.' },
    jobDetail: {
      fallbackTitle: 'Obra',
      empty: 'Todavía no hay tareas en esta obra — pídele al Capo que haga el plan.',
      paused: 'Esta obra está en pausa: no hay trabajo previsto y no se avisa a nadie del equipo. Las tareas siguen aquí hasta que la retomes.',
    },
    taskActions: { complete: 'Terminar', reopen: 'Reabrir', failed: 'Ha fallado, inténtalo otra vez.' },
    taskReview: {
      declaredBy: name => `${name} dice que está hecha:`,
      declaredByManager: 'Pendiente de control:',
      declaredByUnknownWorker: 'Un trabajador dice que está hecha:',
      approve: 'Aprobar',
      reject: 'Rechazar',
      dismiss: 'No necesita control',
      request: 'Pedir control',
      failed: 'No se pudo resolver el control',
      proofNone: 'Sin fotos adjuntas.',
      proofPhotos: n => (n === 1 ? '1 foto adjunta.' : `${n} fotos adjuntas.`),
    },
    taskDetail: {
      fallbackTitle: 'Tarea',
      backToTasks: '← Tareas',
      assignee: 'Responsable',
      assigneeNoPhone: 'sin móvil registrado',
      assigneeInactive: 'inactivo',
      assignUnassigned: 'Asignar a…',
      assignTitle: '¿Quién hace esta tarea?',
      assignAvailabilityOn: shortDate => `Quién está libre el ${shortDate}`,
      assignAvailabilityUnknown:
        'Esta tarea no tiene fechas, así que no se puede saber quién está libre.',
      assignFree: 'libre',
      assignBusy: n => (n === 1 ? 'ya tiene 1 tarea ese día' : `ya tiene ${n} tareas ese día`),
      assignNoneFree: 'No hay trabajadores disponibles para esta tarea.',
      assignNoWorkers: 'Todavía no hay trabajadores activos en el equipo.',
      assignCurrent: 'actual',
      assignRemove: 'Dejar sin responsable',
      assignCancel: 'Cancelar',
      assignFailed: 'No se pudo cambiar el responsable.',
      collaborators: 'Ayudan',
      collaboratorsNone: 'Solo el responsable en esta tarea.',
      collaboratorsTitle: '¿Quién más ayuda en esta tarea?',
      collaboratorsHint:
        'El responsable no cambia: estas personas trabajan en la misma tarea y reciben el aviso de la mañana indicando que están ayudando. El material sigue siendo el de esta tarea, no se duplica.',
      collaboratorsLead: 'responsable',
      collaboratorsSave: 'Guardar',
      collaboratorsFailed: 'No se pudo guardar quién ayuda en esta tarea.',
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
    taskPhotos: {
      sheetTitle: 'Fotos del trabajo',
      sheetIntro: 'Enseña lo que ha quedado hecho — el detalle acabado, no la obra entera.',
      addPhotos: 'Añadir fotos',
      preparing: 'Preparando las fotos…',
      limitHint: (max, megabytes) => `Hasta ${max} fotos, ${megabytes} MB cada una.`,
      remove: 'Quitar foto',
      confirm: n => (n === 1 ? 'Terminar con 1 foto' : `Terminar con ${n} fotos`),
      skip: 'Terminar sin fotos',
      cancel: 'Cancelar',
      sending: 'Enviando…',
      sectionTitle: 'Fotos',
      sourceWorker: 'del trabajador',
      sourceManager: 'tuya',
      errors: {
        mime: 'Solo entran fotografías (JPG, PNG o WEBP).',
        too_large: 'Esa foto es demasiado grande.',
        empty: 'Elige al menos una foto, o pulsa «Terminar sin fotos».',
        too_many: 'Son demasiadas fotos de una sola vez.',
        unknown_task: 'Esa tarea ya no existe.',
        upload_failed: 'No se han podido enviar las fotos. Inténtalo otra vez.',
        generic: 'Ha fallado, inténtalo otra vez.',
      },
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
    // ── issue #60 ────────────────────────────────────────────────────────
    materialsEdit: {
      groupCount: n => (n === 1 ? '1 material' : `${n} materiales`),
      groupEmpty: 'Todavía sin materiales registrados.',
      seeJob: 'Ver obra',
      add: 'Añadir material',
      edit: 'Editar materiales',
      pickTask: '¿Para qué tarea?',
      pickTaskHint: 'Los materiales pertenecen a una tarea. Elige la tarea para la que hace falta este material.',
      taskCount: n => (n === 1 ? '1 material' : `${n} materiales`),
      title: task => `Materiales — ${task}`,
      placeholder: 'Ej.: 20 sacos de cemento',
      addRow: 'Añadir línea',
      removeRow: 'Quitar',
      empty: 'Todavía no hay materiales en esta tarea.',
      save: 'Guardar',
      saving: 'Guardando…',
      cancel: 'Cancelar',
      back: 'Volver a las tareas',
      failed: 'No se pudieron guardar los materiales.',
      noTasks: 'No hay ninguna tarea en esta obra que pueda llevar materiales.',
    },
    // ── end issue #60 ────────────────────────────────────────────────────
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
    noConsentWarning: 'Falta permiso — pregúntale si acepta recibir mensajes y díselo a Capo.',
    receivesWhatsApp: 'recibe el WhatsApp de las 07:00',
    welcomeCostHint:
      'Cuando le dices a Capo que alguien acepta recibir mensajes, Capo se presenta a esa persona una vez por WhatsApp. Es un mensaje de pago por persona — un equipo de 20 son 20 mensajes.',
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

    driftBanner: p => `El Capo habla contigo en ${p.you}, pero escribe las tareas y las obras en ${p.board}.`,
    driftHint:
      'Tiene sentido cuando tu equipo lee en un idioma distinto al tuyo. Si no es tu caso, pon los dos en el mismo idioma — el Capo traduce lo que ya existe.',
    driftAction: 'Poner los dos en el mismo idioma',

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
    confirmPosture: 'Confirmar los cambios',
    confirmPostureHint:
      'Cuando le pides a Capo que cambie algo — crear una tarea, pasarla a otra persona, cancelar una obra — puede preguntarte primero o hacerlo directamente.',
    confirmPostureOption: { always_ask: 'Preguntar siempre', trust_quote: 'Hacerlo directamente' },
    confirmPostureOptionHint: {
      always_ask:
        'Más seguro. Cada cambio aparece primero como una tarjeta con «Aprobar» y «Rechazar» — nada cambia en el panel hasta que pulses. Cuesta un toque cada vez.',
      trust_quote:
        'Más rápido. Capo actúa en el momento cuando puede repetir tus palabras exactas autorizando el cambio; si no puede, te enseña la tarjeta igualmente.',
    },
    whatsappConsent: 'Mensajes por WhatsApp',
    whatsappConsentHint:
      'El resumen del día por la mañana y el repaso al final de la tarde, enviados a tu número. Puedes desactivarlo cuando quieras.',
    whatsappConsentOption: { yes: 'Sí, quiero recibirlos', no: 'No, gracias' },
    whatsappConsentOn: 'Estás recibiendo los mensajes del día.',
    whatsappConsentOff: 'No estás recibiendo nada — actívalo aquí para empezar.',
    whatsappConsentCost:
      'Al activarlo, Capo se presenta una vez en tu WhatsApp. Ese mensaje de bienvenida es de pago; los del día a día ya estaban contados.',

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

  whatsappHandshake: {
    title: 'Habla con Capo en WhatsApp',
    subtitle: 'Capo trabaja en WhatsApp, igual que tú y tu equipo. Envíale el primer mensaje y empezará a preparar tu obra.',
    prefill: '¡Hola Capo! Acabo de registrarme. ¿Me ayudas a empezar?',
    openButton: 'Abrir WhatsApp',
    qrHint: 'Apunta la cámara del móvil al código.',
    webLink: 'Abrir en WhatsApp Web',
    consentLabel: 'Envíame el resumen del día a las 07:00 por WhatsApp',
    consentHint: 'Puedes desactivarlo cuando quieras, en tu perfil.',
    waiting: 'Esperando tu mensaje…',
    arrived: 'Capo ha recibido tu mensaje. Mira WhatsApp. ✅',
    stalled: phone => `Todavía no ha llegado nada. ¿El ${phone} es el número de tu WhatsApp?`,
    fixNumber: 'Corregir el número',
    skip: 'Hacerlo más tarde',
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
    workerAck: 'Recibido, gracias. Si tienes dudas habla con tu encargado.',
    workerLanguageChanged: 'Hecho — a partir de ahora te escribo en español.',
    workerMenuButton: 'Ver tarea',
    workerMenuSection: 'Tus tareas',
    workerMenuBody: (shown, total) =>
      shown < total
        ? `Tienes ${total} tareas abiertas — te enseño las ${shown} más próximas. Elige una para ver los detalles.`
        : total === 1
          ? 'Tienes 1 tarea abierta. Elígela para ver los detalles.'
          : `Tienes ${total} tareas abiertas. Elige una para ver los detalles.`,
    workerMenuEmpty: 'Ahora mismo no tienes ninguna tarea abierta. Si crees que deberías tenerla, habla con tu encargado.',
    workerMenuManagerRow: 'Hablar con el jefe',
    workerMenuManagerNote: 'Para todo lo que yo no puedo resolver desde aquí',
    workerMenuManagerReply: 'Para eso habla con tu encargado — desde aquí solo puedo ver tus tareas y responder dudas técnicas.',
    workerMenuUnknownTask: 'Ya no puedo abrir esa tarea. Escribe AYUDA para ver la lista otra vez.',
    workerOptedOut: 'Listo, no te envío más mensajes. Si cambias de idea responde START.',
    workerOptedIn: 'Genial, vuelves a recibir los mensajes del día. Responde STOP cuando quieras parar.',
    workerBudgetReached: 'Por hoy ya no puedo responder a más mensajes. Mañana por la mañana vuelvo a la normalidad — si es urgente, habla con tu encargado.',
    workerAgentFailed: 'Ahora mismo no consigo responder. Prueba dentro de un rato o habla con tu encargado.',
    workerPhotoFailed: 'No he podido recibir esa foto. ¿Puedes mandarla otra vez?',
    checkinDoneButton: 'Sí, he terminado',
    checkinNotDoneButton: 'Todavía no',
    checkinDone: 'Genial, gracias. Queda registrado que has terminado hoy.',
    checkinDoneAwaiting:
      'Genial, gracias. Ya avisé a tu encargado — falta que lo confirme, así que la tarea sigue abierta hasta entonces.',
    checkinDoneNothing: 'Gracias, queda registrado. Ya no había nada pendiente de confirmar.',
    checkinDoneProblem:
      'Tu respuesta queda registrada, pero no pude avisar a tu encargado. Habla con él.',
    checkinNotDone: 'Vale, gracias por avisar. Queda registrado.',
    checkinPhotoAsk: task =>
      `Si puedes, mándame una foto de “${task}” y la adjunto al aviso. Si no puedes, no pasa nada — el aviso sigue igual.`,
    checkinPhotoNext: task => `Recibida, gracias. ¿Y de “${task}”, tienes alguna?`,
    checkinPhotoThanks:
      'Recibida, gracias. Va junto con el aviso — falta igualmente que tu encargado lo confirme.',
    checkinError: 'No he podido registrar tu respuesta. Habla con tu encargado.',
    stillWorking: 'Sigo con ello, jefe — dame un momento más.',
    workerStillWorking: 'Sigo mirándolo — dame un momento más.',
  },

  reminders: {
    templateLanguage: 'es_ES',
    taskSeparator: ' · ',
    taskWithJob: (title, job) => `${title} (${job})`,
    taskOverdue: (title, days) => `${title} — retrasada ${days}d`,
    andMore: n => `+${n}`,
    // issue #44. The clause that stops a helper reading their briefing as if
    // the job were theirs. Applied before taskOverdue, so lateness stays last.
    taskAsCollaborator: (title, lead) => `${title} — ayudando a ${lead}`,
    taskAsTeam: title => `${title} — en equipo`,
    freeFormWith: names => `Contigo: ${names}`,
    workerNothing: 'Nada previsto para hoy.',
    managerSummary: ({ today, unassigned, overdue }) => {
      const parts = [`${today} ${today === 1 ? 'tarea' : 'tareas'} para hoy`];
      if (unassigned > 0) parts.push(`${unassigned} sin responsable`);
      if (overdue > 0) parts.push(`${overdue} ${overdue === 1 ? 'retrasada' : 'retrasadas'}`);
      return parts.join(' · ');
    },
    managerNothing: 'Nada previsto para hoy.',
    managerEvent: ({ today, unassigned, overdue, notified, names }) => {
      const parts = [`Buenos días. Hoy hay ${today} ${today === 1 ? 'tarea' : 'tareas'} en curso`];
      if (overdue > 0) parts.push(`${overdue} ${overdue === 1 ? 'retrasada' : 'retrasadas'}`);
      if (unassigned > 0) parts.push(`${unassigned} sin responsable`);
      const head = parts.join(' · ');
      const who = names ? `: ${names}` : '';
      const tail =
        notified === 0
          ? 'No he enviado nada al equipo.'
          : `He enviado el resumen del día a ${notified} ${notified === 1 ? 'persona' : 'personas'}${who}.`;
      return `${head}. ${tail}`;
    },
    checkinEvent: ({ asked, names }) => {
      if (asked === 0) return 'Al final de la tarde no he podido preguntarle a nadie si ha acabado el trabajo de hoy.';
      const who = names ? `: ${names}` : '';
      return `Al final de la tarde le he preguntado a ${asked} ${asked === 1 ? 'persona' : 'personas'} si han acabado el trabajo de hoy${who}. Las respuestas van apareciendo aquí.`;
    },
    checkinAnswer: ({ name, answer, tasks }) => {
      const count = tasks > 0 ? ` (${tasks} ${tasks === 1 ? 'tarea' : 'tareas'})` : '';
      return answer === 'done'
        ? `${name} ha respondido al check-in: dice que ha acabado el trabajo de hoy${count}. Queda a la espera de que lo confirmes — hasta entonces sigue abierto.`
        : `${name} ha respondido al check-in: todavía no ha acabado el trabajo de hoy${count}.`;
    },
    nameSeparator: ', ',
    freeFormGreeting: name => `Buenos días, ${name}.`,
    freeFormHeader: count => `Hoy tienes ${count} ${count === 1 ? 'tarea' : 'tareas'}:`,
    freeFormDescription: text => text,
    freeFormMaterials: items => `Material: ${items}`,
    freeFormMaterialSeparator: ', ',
    freeFormAddress: text => `Dirección: ${text}`,
    freeFormWaitingOn: items => `Depende de: ${items}`,
    freeFormAwaitingReview: 'Ya dijiste que habías acabado — a la espera de que lo confirme el jefe.',
    detailHeader: title => `📋 ${title}`,
    detailDue: date => `Plazo: ${date}`,
    detailNothingMore: 'No tengo más detalles de esta tarea. Si te hace falta, habla con tu encargado.',
    detailOverdue: title => `${title} — retrasada`,
    languageHint: 'Responde PT, ES o EN para cambiar de idioma',
    welcomeWorker: company =>
      `${company} ha puesto tu número en Capo: a partir de ahora recibes aquí las tareas de cada día y puedes responderme con dudas. Escribe PT, ES o EN para cambiar de idioma.`,
    welcomeManager: company =>
      `Tu cuenta de ${company} ya está lista: recibes aquí el resumen de cada mañana y puedes hablar conmigo por WhatsApp igual que en la aplicación.`,
    welcomeGreeting: name => `Hola ${name}, soy Capo, el asistente de obra.`,
    welcomeStop: 'Responde STOP para dejar de recibir.',
    welcomeEvent: ({ notified, names }) => {
      const who = names ? `: ${names}` : '';
      return `Me he presentado por WhatsApp a ${notified} ${notified === 1 ? 'persona nueva' : 'personas nuevas'} del equipo${who}.`;
    },
  },
};

export default dict;
