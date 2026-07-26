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

  nav: { chat: 'Chat', today: 'Hoy', tomorrow: 'Mañana', overdue: 'Atrasadas', jobs: 'Obras' },

  common: {
    signOut: 'Salir',
    settings: 'Ajustes',
    save: 'Guardar',
    backToLogin: 'Volver a entrar',
    notAuthenticated: 'No autenticado',
  },

  chat: {
    title: 'Capo 👷',
    tagline: 'Tu capataz virtual',
    placeholder: 'Escribe un mensaje…',
    send: 'Enviar',
    typing: 'El Capo está escribiendo…',
    emptyThread: 'Habla con el Capo — él se encarga de las obras, las tareas y el equipo.',
    proposalTitle: 'Propuesta del Capo',
    pendingProposals: 'Propuestas por decidir',
    approve: 'Aprobar',
    reject: 'Rechazar',
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
      create_job: 'Obra creada',
      update_job: 'Obra actualizada',
      list_jobs: 'Obras consultadas',
      add_worker: 'Trabajador añadido',
      update_worker: 'Trabajador actualizado',
      list_workers: 'Equipo consultado',
      remember: 'Memorizado',
      search_knowledge: 'Base de conocimiento consultada',
      set_language: 'Idioma cambiado',
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
    noJob: 'Sin obra',
    noDate: 'Sin fecha',
    jobPaused: 'obra en pausa',
    talkToCapo: 'Hablar con el Capo',
    progress: (done, total, pct) => `${done} de ${total} terminadas (${pct}%)`,
    tasksDone: (done, total) => `${done} de ${total} tareas terminadas`,
    noTasksRegistered: 'sin tareas registradas',
    overdueCount: n => `${n} ${n === 1 ? 'atrasada' : 'atrasadas'}`,
    pendingCount: n => `${n} ${n === 1 ? 'pendiente' : 'pendientes'}`,
    dependsOn: titles => `⤷ después de: ${titles.join(', ')}`,
  },

  screens: {
    today: { title: 'Hoy', empty: 'Nada programado para hoy.' },
    tomorrow: { title: 'Mañana', empty: 'Nada programado para mañana.' },
    overdue: {
      title: 'Atrasadas',
      empty: 'Sin tareas atrasadas.',
      subtitle: n => `${n} ${n === 1 ? 'tarea' : 'tareas'} con el plazo vencido`,
    },
    jobs: { title: 'Obras', subtitle: 'Obras activas — progreso y atrasos', empty: 'Sin obras activas.' },
    jobDetail: {
      fallbackTitle: 'Obra',
      empty: 'Todavía no hay tareas en esta obra — pídele al Capo que haga el plan.',
    },
    taskActions: { complete: 'Terminar', reopen: 'Reabrir', failed: 'Ha fallado, inténtalo otra vez.' },
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
    phoneHint: 'Es aquí donde el Capo te manda los mensajes del día.',
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

  settings: {
    title: 'Ajustes',
    yourLanguage: 'Tu idioma',
    yourLanguageHint: 'El idioma en el que el Capo habla contigo y en el que ves la app. Solo te afecta a ti.',
    companyLanguage: 'Idioma de los datos de la empresa',
    companyLanguageHint:
      'El idioma en el que el Capo escribe tareas, obras y notas — lo que todo el equipo ve en el panel.',
    companyLanguageWarning: 'Ojo: las tareas y obras ya creadas no se traducen.',
    saved: 'Guardado.',
    failed: 'No se ha podido guardar. Inténtalo de nuevo.',
    billingLink: 'Suscripción',
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
        text: 'Cada trabajador recibe por SMS las tareas del día — sin apps, sin cuentas.',
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
  },
};

export default dict;
